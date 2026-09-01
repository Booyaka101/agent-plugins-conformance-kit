#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { formatPassLine, formatVerdictLines, type Fixture, type Verdict } from './diff.js';
import { loadRules } from './rules.js';
import {
  AdapterError,
  CorpusError,
  GROUPS,
  isDirectory,
  loadCorpus,
  runSuite,
  type RunResult,
} from './runner.js';
import { verifyCorpus } from './verify.js';
import { toJUnitXml } from './junit.js';
import { BaselineError, compareToBaseline, readBaseline, writeBaseline, type Baseline } from './baseline.js';
import type { FixtureGroup } from './diff.js';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const USAGE = `apconform ${version} - Agent Plugins 1.0.0 client conformance suite

Usage:
  apconform run --adapter <path> [options]
  apconform list [options]
  apconform rules [--json]
  apconform verify
  apconform explain <rule-id>
  apconform show <fixture-id>

Run options:
  --adapter <path>       Executable that takes a plugin directory as argv[2] and prints
                         a load report to stdout. See ADAPTERS.md.
  --adapter-exec <cmd>   Launch the adapter with this program instead of guessing from
                         the file extension, e.g. --adapter-exec "deno run -A".
  --only <groups>        core, disputed, regressions or all. Comma-separated. Default: all.
  --fixture <substring>  Run only fixtures whose id contains this text.
  --json <file>          Write the full machine-readable result to this file.
  --junit <file>         Write JUnit XML, for CI systems that render test reports.
  --strict-reporting     Treat SHOULD-report mismatches in "skipped" as failures.
  --timeout <ms>         Per-fixture adapter timeout. Default: 30000.
  --concurrency <n>      Adapters to run at once. Default: min(8, cpus).
  --fixtures <dir>       Use a different corpus root.
  --baseline <file>      Gate on change instead of on the total. Only fixtures that
                         regressed against this file fail the run.
  --update-baseline      Write the current result to --baseline and exit 0.
  --quiet                Only print the summary and any failures.

Exit codes: 0 all passed, 1 conformance failures or adapter errors, 2 could not run.
`;

interface Args {
  command: string;
  flags: Map<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(token.slice(2), next);
      i++;
    } else {
      flags.set(token.slice(2), true);
    }
  }
  return { command, flags, positional };
}

function requireString(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`--${name} requires a value`);
  }
  return value;
}

/**
 * A value-taking flag given no value is a typo, not a request for the default. Silently
 * treating `--fixture --quiet` as "run everything" is the kind of thing you only notice
 * when a CI run takes ten minutes instead of one.
 */
function optionalString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || value.length === 0) throw new UsageError(`--${name} requires a value`);
  return value;
}

function optionalNumber(flags: Map<string, string | true>, name: string): number | undefined {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive number, got "${String(value)}"`);
  }
  return parsed;
}

class UsageError extends Error {}

function parseGroups(flags: Map<string, string | true>): FixtureGroup[] {
  const raw = optionalString(flags, 'only');
  if (raw === undefined || raw === 'all') return GROUPS;
  const requested = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !GROUPS.includes(name as FixtureGroup));
  if (unknown.length > 0) {
    throw new UsageError(`--only accepts ${GROUPS.join(', ')} or all, got "${unknown.join(', ')}"`);
  }
  return requested as FixtureGroup[];
}

async function corpusFor(flags: Map<string, string | true>): Promise<Fixture[]> {
  const root = optionalString(flags, 'fixtures');
  const filter = optionalString(flags, 'fixture');
  const fixtures = await loadCorpus({
    ...(root !== undefined ? { root: resolve(root) } : {}),
    groups: parseGroups(flags),
    ...(filter !== undefined ? { filter } : {}),
  });
  if (fixtures.length === 0) {
    throw new UsageError(
      filter !== undefined ? `no fixtures match --fixture "${filter}"` : 'no fixtures selected',
    );
  }
  return fixtures;
}

async function commandRun(args: Args): Promise<number> {
  // Every option is validated before anything is printed or spawned, so a typo in a flag
  // never lands halfway through a run.
  const adapter = requireString(args.flags, 'adapter');
  const adapterExec = optionalString(args.flags, 'adapter-exec');
  const timeoutMs = optionalNumber(args.flags, 'timeout');
  const concurrency = optionalNumber(args.flags, 'concurrency');
  const jsonPath = optionalString(args.flags, 'json');
  const junitPath = optionalString(args.flags, 'junit');
  const baselinePath = optionalString(args.flags, 'baseline');
  const updateBaseline = args.flags.get('update-baseline') === true;
  const quiet = args.flags.get('quiet') === true;

  // The baseline is read before the run, so a missing or corrupt one is reported in a
  // second rather than after the whole corpus, and so a failure the baseline already knows
  // about can be printed as KNOWN instead of as a red FAIL the summary then contradicts.
  let baseline: Baseline | null = null;
  if (baselinePath !== undefined && !updateBaseline) {
    baseline = await readBaseline(resolve(baselinePath));
    if (baseline === null) {
      throw new UsageError(
        `no baseline at ${resolve(baselinePath)}. Create one with --baseline ${baselinePath} --update-baseline.`,
      );
    }
  }
  const wasFailing = (id: string): boolean => {
    const before = baseline?.fixtures[id];
    return before === 'fail' || before === 'error';
  };

  const fixtures = await corpusFor(args.flags);

  process.stdout.write(
    `apconform ${version}  ${fixtures.length} fixtures  adapter ${relative(process.cwd(), resolve(adapter)) || adapter}\n\n`,
  );

  const result: RunResult = await runSuite(fixtures, {
    adapter,
    ...(adapterExec !== undefined ? { adapterExec } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    strictReporting: args.flags.get('strict-reporting') === true,
    onVerdict: (verdict) => {
      if (quiet && verdict.status === 'pass' && verdict.warnings.length === 0) return;
      process.stdout.write(renderVerdict(verdict, wasFailing(verdict.fixture)));
    },
  });

  const { summary } = result;
  process.stdout.write('\n');
  for (const group of GROUPS) {
    const stats = summary.byGroup[group];
    if (stats.total === 0) continue;
    process.stdout.write(
      `${group.padEnd(12)} ${String(stats.pass).padStart(4)} pass  ${String(stats.fail).padStart(3)} fail  ` +
        `${String(stats.error).padStart(3)} error  ${String(stats.skipped).padStart(3)} skipped\n`,
    );
  }
  process.stdout.write(
    `${'total'.padEnd(12)} ${String(summary.pass).padStart(4)} pass  ${String(summary.fail).padStart(3)} fail  ` +
      `${String(summary.error).padStart(3)} error  ${String(summary.skipped).padStart(3)} skipped  ` +
      `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}\n`,
  );

  let exitCode = summary.fail > 0 || summary.error > 0 ? 1 : 0;

  if (baselinePath !== undefined) {
    const resolved = resolve(baselinePath);
    if (updateBaseline) {
      await writeBaseline(resolved, loadRules().specVersion, result.verdicts);
      process.stdout.write(`\nwrote baseline ${resolved} (${result.verdicts.length} fixtures)\n`);
      exitCode = 0;
    } else {
      exitCode = reportAgainstBaseline(result, baseline as Baseline);
    }
  }

  if (junitPath !== undefined) {
    const xml = toJUnitXml(result.verdicts, summary, loadRules().specVersion);
    await writeFile(resolve(junitPath), xml);
    process.stdout.write(`
wrote ${resolve(junitPath)}
`);
  }

  if (jsonPath !== undefined) {
    const payload = {
      tool: 'agent-plugins-conformance-kit',
      version,
      specVersion: loadRules().specVersion,
      adapter: resolve(adapter),
      summary,
      verdicts: result.verdicts,
    };
    await writeFile(resolve(jsonPath), `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`\nwrote ${resolve(jsonPath)}\n`);
  }

  return exitCode;
}

/** Prints the ratchet view and returns the exit code: only regressions gate. */
function reportAgainstBaseline(result: RunResult, baseline: Baseline): number {
  const { regressions, known, fixed, missing } = compareToBaseline(result.verdicts, baseline);

  process.stdout.write('\n');
  for (const verdict of regressions) {
    for (const line of formatVerdictLines(verdict)) {
      if (line.startsWith('FAIL') || line.startsWith('ERROR')) {
        process.stdout.write(`REGRESSION ${line.slice(line.indexOf(' ') + 1)}\n`);
      }
    }
  }
  for (const id of fixed) process.stdout.write(`FIXED ${id}\n`);
  for (const id of missing) process.stdout.write(`GONE ${id} was in the baseline but is not in this run\n`);

  process.stdout.write(
    `baseline     ${regressions.length} regression${regressions.length === 1 ? '' : 's'}  ` +
      `${known.length} known  ${fixed.length} fixed\n`,
  );
  if (fixed.length > 0 && regressions.length === 0) {
    process.stdout.write('re-run with --update-baseline to lock the fixes in\n');
  }
  return regressions.length > 0 ? 1 : 0;
}

/** `known` relabels a failure the baseline already recorded, so the log agrees with the summary. */
function renderVerdict(verdict: Verdict, known = false): string {
  const lines = formatVerdictLines(verdict);
  if (lines.length === 0) return `${formatPassLine(verdict)}\n`;
  const shown = known ? lines.map((line) => line.replace(/^(FAIL|ERROR) /, 'KNOWN ')) : lines;
  return `${shown.join('\n')}\n`;
}

async function commandList(args: Args): Promise<number> {
  const fixtures = await corpusFor(args.flags);
  for (const fixture of fixtures) {
    const flag = fixture.observability === 'partial' ? ' [partial]' : '';
    process.stdout.write(`${fixture.id}\n  spec ${fixture.spec}  ${fixture.title}${flag}\n`);
  }
  process.stdout.write(`\n${fixtures.length} fixtures\n`);
  return 0;
}

function commandRules(args: Args): number {
  const table = loadRules();
  if (args.flags.get('json') !== undefined) {
    process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
    return 0;
  }
  for (const rule of table.rules) {
    process.stdout.write(`${rule.id}\n  spec ${rule.section}  ${rule.severity}  ${rule.confidence}\n`);
  }
  process.stdout.write(`\n${table.rules.length} rules from Agent Plugins ${table.specVersion}\n`);
  return 0;
}

function commandExplain(args: Args): number {
  const id = args.positional[0];
  if (id === undefined) throw new UsageError('explain needs a rule id, e.g. apconform explain AP-7.1-DEPTH');
  const table = loadRules();
  const rule = table.rules.find((r) => r.id.toLowerCase() === id.toLowerCase());
  if (!rule) throw new UsageError(`no rule "${id}". Run apconform rules for the list.`);

  process.stdout.write(`${rule.id}\n`);
  process.stdout.write(`  specification  §${rule.section} of Agent Plugins ${table.specVersion}\n`);
  process.stdout.write(`  severity       ${rule.severity} - ${table.severities[rule.severity]}\n`);
  process.stdout.write(`  confidence     ${rule.confidence} - ${table.confidence[rule.confidence]}\n`);
  process.stdout.write(`\n  "${rule.quote}"\n`);
  if (rule.agentSkills) {
    process.stdout.write(`\n  Agent Skills: "${rule.agentSkills.quote}"\n  ${rule.agentSkills.source}\n`);
  }
  if (rule.note) process.stdout.write(`\n  ${rule.note}\n`);
  if (rule.issue) process.stdout.write(`\n  ${rule.issue}\n`);
  process.stdout.write(`\n  ${table.specSource}\n`);
  return 0;
}

/**
 * The fixture behind a failing rule id. A verdict line names the rule; the next question
 * is always what the plugin on disk actually contains, and this answers it without
 * making anyone go spelunking in node_modules.
 */
async function commandShow(args: Args): Promise<number> {
  const wanted = args.positional[0];
  if (wanted === undefined) {
    throw new UsageError('show needs a fixture id, e.g. apconform show core/AP-7.1-DEPTH');
  }
  const all = await loadCorpus();
  const matches = all.filter((f) => f.id.toLowerCase().includes(wanted.toLowerCase()));
  if (matches.length === 0) {
    throw new UsageError(`no fixture matching "${wanted}". Run apconform list for the corpus.`);
  }
  if (matches.length > 1 && !matches.some((f) => f.id === wanted)) {
    process.stdout.write(`${matches.length} fixtures match "${wanted}":\n`);
    for (const fixture of matches) process.stdout.write(`  ${fixture.id}\n`);
    return 0;
  }
  const fixture = matches.find((f) => f.id === wanted) ?? (matches[0] as Fixture);

  process.stdout.write(`${fixture.id}\n  ${fixture.title}\n\n`);
  process.stdout.write(`  rule           ${fixture.ruleId}\n`);
  process.stdout.write(`  specification  §${fixture.spec}\n`);
  process.stdout.write(`  confidence     ${fixture.confidence}\n`);
  process.stdout.write(`  observability  ${fixture.observability}\n`);
  process.stdout.write(`\n  "${fixture.quote}"\n`);
  process.stdout.write(`\n  ${fixture.rationale}\n`);
  if (fixture.observabilityNote) process.stdout.write(`\n  ${fixture.observabilityNote}\n`);
  if (fixture.issue) process.stdout.write(`\n  ${fixture.issue}\n`);

  process.stdout.write('\nplugin/\n');
  for (const entry of await pluginTree(join(fixture.dir, 'plugin'))) {
    process.stdout.write(`  ${entry}\n`);
  }
  for (const link of fixture.links ?? []) {
    process.stdout.write(`  ${link.path} -> ${link.target}  (${link.type} link, created at run time)\n`);
  }

  for (const name of ['plugin.json', 'mcp.json']) {
    const path = join(fixture.dir, 'plugin', name);
    if (!existsSync(path) || (await isDirectory(path))) continue;
    process.stdout.write(`\n${name}\n`);
    const text = await readFile(path, 'utf8');
    for (const line of text.replace(/\s+$/, '').split('\n')) process.stdout.write(`  ${line}\n`);
  }

  process.stdout.write('\nexpected load report\n');
  for (const line of JSON.stringify(fixture.expect, null, 2).split('\n')) {
    process.stdout.write(`  ${line}\n`);
  }
  if (fixture.optional) {
    process.stdout.write(`\n  either way: ${JSON.stringify(fixture.optional)}\n`);
  }
  if (fixture.atLeastOne) {
    process.stdout.write(`  at least one of: ${JSON.stringify(fixture.atLeastOne)}\n`);
  }
  return 0;
}

/** Plugin-relative paths, directories marked, deepest last. */
async function pluginTree(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...(await pluginTree(join(root, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function commandVerify(args: Args): Promise<number> {
  const fixtures = await loadCorpus(
    typeof args.flags.get('fixtures') === 'string'
      ? { root: resolve(args.flags.get('fixtures') as string) }
      : {},
  );
  const problems = await verifyCorpus(fixtures);
  if (problems.length === 0) {
    process.stdout.write(`corpus OK: ${fixtures.length} fixtures, ${loadRules().rules.length} rules\n`);
    return 0;
  }
  for (const problem of problems) {
    process.stdout.write(`PROBLEM ${problem.where}: ${problem.message}\n`);
  }
  process.stdout.write(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'run':
      return commandRun(args);
    case 'list':
      return commandList(args);
    case 'rules':
      return commandRules(args);
    case 'explain':
      return commandExplain(args);
    case 'verify':
      return commandVerify(args);
    case 'show':
      return commandShow(args);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${version}\n`);
      return 0;
    default:
      throw new UsageError(`unknown command "${args.command}"`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (
      err instanceof UsageError ||
      err instanceof AdapterError ||
      err instanceof CorpusError ||
      err instanceof BaselineError
    ) {
      process.stderr.write(`apconform: ${err.message}\n\n`);
      if (err instanceof UsageError) process.stderr.write(USAGE);
    } else {
      process.stderr.write(`apconform: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 2;
  });
