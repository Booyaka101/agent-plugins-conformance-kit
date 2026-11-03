import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, realpath, rm, symlink, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { availableParallelism } from 'node:os';
import { parseLoadReport, validateLoadReport } from './report.js';
import { isPositiveInteger, MAX_TIMEOUT_MS } from './options.js';
import {
  diffReport,
  summarize,
  type DiffOptions,
  type Fixture,
  type FixtureGroup,
  type Summary,
  type Verdict,
} from './diff.js';
import { loadRules, packageRoot, ruleIndex } from './rules.js';

export const GROUPS: FixtureGroup[] = ['core', 'disputed', 'regressions'];

/** Per-stream cap on what an adapter may print before the runner gives up on it. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface CorpusOptions {
  /** Fixture root. Defaults to the `fixtures/` directory shipped with the package. */
  root?: string;
  groups?: FixtureGroup[];
  /** Case-insensitive substring match against the fixture id. */
  filter?: string;
}

export class CorpusError extends Error {}
export class AdapterError extends Error {}

export function fixtureRoot(root?: string): string {
  return resolve(root ?? join(packageRoot, 'fixtures'));
}

export async function loadCorpus(options: CorpusOptions = {}): Promise<Fixture[]> {
  const root = fixtureRoot(options.root);
  if (!(await isDirectory(root))) {
    throw new CorpusError(`fixture directory not found: ${root}`);
  }
  const rules = ruleIndex(loadRules());
  const groups = options.groups ?? GROUPS;
  const fixtures: Fixture[] = [];

  for (const group of groups) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    const entries = await readdir(groupDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      const manifestPath = join(dir, 'fixture.json');
      if (!existsSync(manifestPath)) {
        throw new CorpusError(`${group}/${entry.name} has no fixture.json`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch (err) {
        throw new CorpusError(
          `${group}/${entry.name}/fixture.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const shapeError = fixtureShapeError(raw);
      if (shapeError) throw new CorpusError(`${group}/${entry.name}/fixture.json ${shapeError}`);
      const fixture = raw as Omit<Fixture, 'id' | 'group' | 'dir'>;
      const rule = rules.get(fixture.ruleId);
      if (!rule) {
        throw new CorpusError(`${group}/${entry.name} names unknown rule ${fixture.ruleId}`);
      }
      if (!(await isDirectory(join(dir, 'plugin')))) {
        throw new CorpusError(`${group}/${entry.name} has no plugin/ directory`);
      }
      const shape = validateLoadReport(fixture.expect);
      if (!shape.ok) {
        throw new CorpusError(
          `${group}/${entry.name}/fixture.json "expect" is not a load report: ${shape.error}`,
        );
      }
      fixtures.push({ ...fixture, expect: shape.report, id: `${group}/${entry.name}`, group, dir });
    }
  }

  const filter = options.filter?.toLowerCase();
  return filter ? fixtures.filter((f) => f.id.toLowerCase().includes(filter)) : fixtures;
}

function fixtureShapeError(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'must be an object';
  const value = raw as Record<string, unknown>;
  for (const field of ['ruleId', 'confidence', 'spec', 'title', 'rationale', 'quote', 'observability']) {
    if (typeof value[field] !== 'string') return `"${field}" must be a string`;
  }
  for (const field of ['issue', 'observabilityNote']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return `"${field}" must be a string`;
  }
  if (!['core', 'disputed'].includes(value['confidence'] as string)) return 'has invalid confidence';
  if (!['report', 'partial'].includes(value['observability'] as string)) return 'has invalid observability';
  for (const field of ['optional', 'atLeastOne']) {
    const sets = value[field];
    if (sets === undefined) continue;
    if (typeof sets !== 'object' || sets === null || Array.isArray(sets)) return `"${field}" must be an object`;
    for (const [name, members] of Object.entries(sets)) {
      if (name === 'rejected') {
        if (typeof members !== 'boolean') return `"${field}.rejected" must be a boolean`;
      } else if (!['skills', 'mcpServers', 'reported'].includes(name) ||
          !Array.isArray(members) || !members.every((item) => typeof item === 'string')) {
        return `"${field}.${name}" must name a supported array of strings`;
      }
    }
  }
  const links = value['links'];
  if (links !== undefined) {
    if (!Array.isArray(links)) return '"links" must be an array';
    for (const link of links) {
      if (typeof link !== 'object' || link === null ||
          typeof link.path !== 'string' || !link.path || typeof link.target !== 'string' || !link.target ||
          !['file', 'dir'].includes(link.type)) return 'has an invalid link (path, target and type are required)';
    }
  }
  return undefined;
}

interface Launch {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Picks how to launch an adapter. Anything without a known script extension is spawned
 * directly, which is what `--adapter ./target/release/adapt` needs.
 */
export function adapterLaunch(adapterPath: string, exec?: string): Launch {
  const path = resolve(adapterPath);
  if (exec) {
    const parts = exec.split(/\s+/).filter(Boolean);
    const [command, ...rest] = parts;
    if (command === undefined) throw new AdapterError('--adapter-exec was empty');
    return { command, args: [...rest, path], shell: false };
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) {
    return { command: process.execPath, args: [path], shell: false };
  }
  if (lower.endsWith('.py')) {
    return { command: process.platform === 'win32' ? 'python' : 'python3', args: [path], shell: false };
  }
  if (lower.endsWith('.sh')) {
    return { command: 'sh', args: [path], shell: false };
  }
  if (lower.endsWith('.ps1')) {
    return { command: 'powershell', args: ['-NoProfile', '-File', path], shell: false };
  }
  // A .cmd or .bat shim cannot be spawned without a shell on Windows. With `shell: true`
  // Node hands the whole line to cmd.exe unquoted, so a path under "Program Files" splits
  // at the space unless it is quoted here.
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { command: `"${path}"`, args: [], shell: true };
  }
  return { command: path, args: [], shell: false };
}

/** Arguments are quoted only for a shell launch; a direct spawn must not see the quotes. */
function launchArgs(launch: Launch, pluginDir: string): string[] {
  const args = [...launch.args, pluginDir];
  return launch.shell ? args.map((arg) => `"${arg}"`) : args;
}

export interface AdapterResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** The adapter was killed for printing more than the runner will hold. */
  overflowed: boolean;
}

export function runAdapter(
  launch: Launch,
  pluginDir: string,
  timeoutMs: number,
): Promise<AdapterResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!isPositiveInteger(timeoutMs, MAX_TIMEOUT_MS)) {
      rejectPromise(new AdapterError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`));
      return;
    }
    let child;
    try {
      child = spawn(launch.command, launchArgs(launch, pluginDir), {
        shell: launch.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      rejectPromise(new AdapterError(`could not start adapter: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    const bytes = { stdout: 0, stderr: 0 };
    const stop = (): void => {
      child.kill('SIGKILL');
      // A descendant may still hold these pipes after the adapter exits. Waiting for
      // their EOF would defeat both the timeout and output cap.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // A load report is a few kilobytes. An adapter that streams without end must not take
    // the runner down with it.
    const capture = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (overflowed) return;
      bytes[stream] += Buffer.byteLength(chunk, 'utf8');
      if (bytes[stream] > MAX_OUTPUT_BYTES) {
        overflowed = true;
        stop();
        return;
      }
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk: string) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: string) => capture('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new AdapterError(`could not start adapter "${launch.command}": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, timedOut, overflowed });
    });
  });
}

/**
 * Materializes a fixture that needs symlinks into a temp directory, because a link
 * escaping the plugin root cannot be committed to git or packed into a tarball.
 * Returns the plugin directory to hand the adapter and a cleanup function.
 */
async function stage(fixture: Fixture): Promise<{ pluginDir: string; cleanup: () => Promise<void> }> {
  if (!fixture.links || fixture.links.length === 0) {
    return { pluginDir: join(fixture.dir, 'plugin'), cleanup: async () => {} };
  }
  const base = await mkdtemp(join(tmpdir(), 'apconform-'));
  const cleanup = () => rm(base, { recursive: true, force: true });
  try {
    await cp(join(fixture.dir, 'plugin'), join(base, 'plugin'), { recursive: true });
    if (existsSync(join(fixture.dir, 'outside'))) {
      await cp(join(fixture.dir, 'outside'), join(base, 'outside'), { recursive: true });
    }
    // Kept beside the staged plugin, never inside it, so the layout an adapter sees
    // matches an unstaged fixture exactly.
    await cp(join(fixture.dir, 'fixture.json'), join(base, 'fixture.json'));
    const pluginRoot = await realpath(join(base, 'plugin'));
    for (const link of fixture.links) {
      const linkPath = resolve(pluginRoot, link.path);
      // Check the parent on disk too: an earlier link can redirect a later removal.
      if (!isWithin(pluginRoot, linkPath) ||
          !isWithin(pluginRoot, await realpath(dirname(linkPath)), true)) {
        throw new CorpusError(`link path must stay inside the staged plugin: ${link.path}`);
      }
      await rm(linkPath, { recursive: true, force: true });
      await createLink(link.target, linkPath, link.type);
    }
    return { pluginDir: join(base, 'plugin'), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function isWithin(root: string, path: string, allowRoot = false): boolean {
  const rel = relative(root, path);
  return (allowRoot || rel !== '') && rel !== '..' &&
    !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function createLink(target: string, linkPath: string, type: 'file' | 'dir'): Promise<void> {
  try {
    await symlink(target, linkPath, type);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows refuses symlinks without Developer Mode or elevation. A junction needs no
    // privilege but only works for directories and only with an absolute target.
    if (code === 'EPERM' && type === 'dir') {
      await symlink(resolve(dirname(linkPath), target), linkPath, 'junction');
      return;
    }
    throw err;
  }
}

export interface RunOptions extends DiffOptions {
  adapter: string;
  adapterExec?: string;
  timeoutMs?: number;
  concurrency?: number;
  onVerdict?: (verdict: Verdict) => void;
}

export interface RunResult {
  verdicts: Verdict[];
  summary: Summary;
}

export async function runFixture(
  fixture: Fixture,
  launch: Launch,
  options: RunOptions,
): Promise<Verdict> {
  const base = {
    fixture: fixture.id,
    ruleId: fixture.ruleId,
    section: fixture.spec,
    confidence: fixture.confidence,
    group: fixture.group,
    observability: fixture.observability,
    failures: [] as string[],
    warnings: [] as string[],
    notes: [] as string[],
  };
  const started = Date.now();

  let staged;
  try {
    staged = await stage(fixture);
  } catch (err) {
    if (err instanceof CorpusError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'EPERM'
        ? 'this fixture needs a symlink and the platform refused to create one (enable Developer Mode on Windows, or run the suite on Linux)'
        : `could not stage fixture: ${err instanceof Error ? err.message : String(err)}`;
    return { ...base, status: code === 'EPERM' ? 'skipped' : 'error', error: reason, durationMs: Date.now() - started };
  }

  try {
    const result = await runAdapter(launch, staged.pluginDir, options.timeoutMs ?? 30_000);
    const durationMs = Date.now() - started;

    if (result.timedOut) {
      return {
        ...base,
        status: 'error',
        error: `adapter timed out after ${options.timeoutMs ?? 30_000}ms`,
        durationMs,
      };
    }
    if (result.overflowed) {
      return {
        ...base,
        status: 'error',
        error: `adapter printed more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB to stdout or stderr and was killed`,
        durationMs,
      };
    }

    const parsed = parseLoadReport(result.stdout);
    if (!parsed.ok) {
      const trailer = result.code !== 0 ? ` (adapter exited ${result.code}${tail(result.stderr)})` : '';
      return { ...base, status: 'error', error: `${parsed.error}${trailer}`, durationMs };
    }
    if (result.code !== 0) {
      return {
        ...base,
        status: 'error',
        error: `adapter printed a valid report but exited ${result.code}${tail(result.stderr)}`,
        durationMs,
        report: parsed.report,
      };
    }

    const verdict = diffReport(fixture, parsed.report, options);
    verdict.durationMs = durationMs;
    return verdict;
  } catch (err) {
    // An adapter that cannot be launched is a setup problem, not 133 fixture failures.
    if (err instanceof AdapterError) throw err;
    return {
      ...base,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    await staged.cleanup();
  }
}

export async function runSuite(fixtures: Fixture[], options: RunOptions): Promise<RunResult> {
  if (options.concurrency !== undefined && !isPositiveInteger(options.concurrency)) {
    throw new AdapterError('concurrency must be a positive safe integer');
  }
  if (options.timeoutMs !== undefined && !isPositiveInteger(options.timeoutMs, MAX_TIMEOUT_MS)) {
    throw new AdapterError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  const adapterPath = resolve(options.adapter);
  if (!existsSync(adapterPath)) {
    throw new AdapterError(`adapter not found: ${options.adapter}`);
  }
  if (!statSync(adapterPath).isFile()) {
    throw new AdapterError(`adapter is not a file: ${options.adapter}`);
  }
  const launch = adapterLaunch(adapterPath, options.adapterExec);

  const limit = Math.max(1, options.concurrency ?? Math.min(8, availableParallelism()));
  const verdicts: Verdict[] = new Array(fixtures.length);
  let next = 0;

  // Fixtures finish out of order, but two runs of the same corpus must produce the same
  // output or nobody can diff them. Verdicts are released in corpus order as the prefix
  // fills in, which keeps live progress without making the log depend on scheduling.
  let released = 0;
  const release = (): void => {
    while (released < fixtures.length) {
      const verdict = verdicts[released];
      if (verdict === undefined) return;
      options.onVerdict?.(verdict);
      released++;
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const fixture = fixtures[index];
      if (fixture === undefined) return;
      verdicts[index] = await runFixture(fixture, launch, options);
      release();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, fixtures.length) }, worker));
  return { verdicts, summary: summarize(verdicts) };
}

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return '';
  const lines = trimmed.split(/\r?\n/).slice(-3).join(' | ');
  return `: ${lines.length > 300 ? `${lines.slice(0, 300)}...` : lines}`;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
