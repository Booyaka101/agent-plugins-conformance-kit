import type { LoadReport, ReportedEntry, SkippedEntry } from './report.js';
import type { Confidence } from './rules.js';

export type FixtureGroup = 'core' | 'disputed' | 'regressions';
export type Observability = 'report' | 'partial';

export interface LinkSpec {
  /** Path of the link, relative to the plugin root. */
  path: string;
  /** Link target, relative to the directory holding the link. */
  target: string;
  type: 'file' | 'dir';
}

export interface FixtureExpectation {
  rejected: string | null;
  loaded: { skills: string[]; mcpServers: string[] };
  skipped: SkippedEntry[];
  reported: ReportedEntry[];
}

/** Component names a conformant client may load or omit. Neither choice fails. */
export interface NameSets {
  skills?: string[];
  mcpServers?: string[];
}

export interface Fixture {
  /** Corpus-relative id, e.g. `core/AP-5.2-UNKNOWN-FIELD`. */
  id: string;
  group: FixtureGroup;
  /** Absolute path of the fixture directory (the one holding fixture.json). */
  dir: string;
  ruleId: string;
  confidence: Confidence;
  spec: string;
  title: string;
  rationale: string;
  quote: string;
  issue?: string;
  observability: Observability;
  observabilityNote?: string;
  links?: LinkSpec[];
  expect: FixtureExpectation;
  optional?: NameSets;
  /** At least one of the listed names must be loaded. Used where the spec lets a client pick. */
  atLeastOne?: NameSets;
}

export type VerdictStatus = 'pass' | 'fail' | 'error' | 'skipped';

export interface Verdict {
  fixture: string;
  ruleId: string;
  section: string;
  confidence: Confidence;
  group: FixtureGroup;
  observability: Observability;
  status: VerdictStatus;
  /** Specification MUSTs the client broke. Non-empty means `fail`. */
  failures: string[];
  /** Specification SHOULDs the client did not follow, and reporting-vocabulary differences. */
  warnings: string[];
  /** Choices the specification leaves open, recorded so the corpus stays a description. */
  notes: string[];
  durationMs?: number;
  report?: LoadReport;
  /** Set when the adapter could not be run or did not produce a usable report. */
  error?: string;
}

export interface DiffOptions {
  /** Promote SHOULD-report mismatches to failures. */
  strictReporting?: boolean;
}

/** `./skills/x/` and `skills\x` are the same component. */
export function normalizeWhat(what: string): string {
  return what.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

const quote = (value: string | null): string => (value === null ? 'null' : JSON.stringify(value));

/** Component names as they appear in a `skipped` entry's `what`. */
const componentPaths = (names: NameSets | undefined): string[] => [
  ...(names?.skills ?? []).map((name) => `skills/${name}`),
  ...(names?.mcpServers ?? []).map((name) => `mcp.json#${name}`),
];
const list = (values: Iterable<string>): string => {
  const sorted = [...values].sort();
  return sorted.length === 0 ? '[]' : `[${sorted.join(', ')}]`;
};

function compareNames(
  channel: 'skills' | 'mcpServers',
  actual: string[],
  fixture: Fixture,
  failures: string[],
  notes: string[],
): void {
  const optional = new Set(fixture.optional?.[channel] ?? []);
  const eitherWay = new Set(fixture.atLeastOne?.[channel] ?? []);
  const expected = fixture.expect.loaded[channel];

  const required = expected.filter((name) => !optional.has(name) && !eitherWay.has(name));
  const allowed = new Set([...expected, ...optional, ...eitherWay]);
  const seen = new Set(actual);

  const missing = required.filter((name) => !seen.has(name));
  const unexpected = actual.filter((name) => !allowed.has(name));

  if (missing.length > 0) {
    failures.push(
      `expected loaded.${channel} to contain ${list(missing)}, got ${list(actual)}`,
    );
  }
  if (unexpected.length > 0) {
    failures.push(
      `expected loaded.${channel} not to contain ${list(unexpected)}, got ${list(actual)}`,
    );
  }
  const optionalNames = [...optional];
  if (optionalNames.length > 3) {
    const included = optionalNames.filter((name) => seen.has(name)).length;
    notes.push(`loaded.${channel} includes ${included} of ${optionalNames.length} optional names`);
  } else {
    for (const name of optionalNames) {
      notes.push(`loaded.${channel} ${seen.has(name) ? 'includes' : 'omits'} the optional "${name}"`);
    }
  }
}

function compareAtLeastOne(fixture: Fixture, report: LoadReport, failures: string[]): void {
  if (!fixture.atLeastOne) return;
  const wanted = [
    ...(fixture.atLeastOne.skills ?? []).map((n) => `skills:${n}`),
    ...(fixture.atLeastOne.mcpServers ?? []).map((n) => `mcpServers:${n}`),
  ];
  if (wanted.length === 0) return;
  const got = new Set([
    ...report.loaded.skills.map((n) => `skills:${n}`),
    ...report.loaded.mcpServers.map((n) => `mcpServers:${n}`),
  ]);
  if (!wanted.some((name) => got.has(name))) {
    failures.push(`expected at least one of ${list(wanted)} to load, got none`);
  }
}

/**
 * A client's own rule vocabulary is its own, so a mismatched id is worth saying out loud
 * and never worth failing over.
 */
function warnOnRuleIdMismatch<T extends { ruleId?: string }>(
  label: string,
  entries: readonly T[],
  nameOf: (entry: T) => string,
  expected: Map<string, string>,
  warnings: string[],
): void {
  for (const entry of entries) {
    const name = nameOf(entry);
    const want = expected.get(name);
    if (want !== undefined && entry.ruleId !== undefined && entry.ruleId !== want) {
      warnings.push(`${label} "${name}" carries ruleId ${quote(entry.ruleId)}, expected ${quote(want)}`);
    }
  }
}

function compareReported(
  fixture: Fixture,
  report: LoadReport,
  failures: string[],
  warnings: string[],
): void {
  const expected = new Set(fixture.expect.reported.map((entry) => entry.field));
  const actual = new Set(report.reported.map((entry) => entry.field));

  const missing = [...expected].filter((field) => !actual.has(field));
  const unexpected = [...actual].filter((field) => !expected.has(field));

  if (missing.length > 0) {
    failures.push(`expected reported fields to contain ${list(missing)}, got ${list(actual)}`);
  }
  if (unexpected.length > 0) {
    failures.push(`expected reported fields not to contain ${list(unexpected)}, got ${list(actual)}`);
  }

  warnOnRuleIdMismatch(
    'reported',
    report.reported,
    (entry) => entry.field,
    new Map(
      fixture.expect.reported
        .filter((entry) => entry.ruleId !== undefined)
        .map((entry) => [entry.field, entry.ruleId as string]),
    ),
    warnings,
  );
}

function compareSkipped(
  fixture: Fixture,
  report: LoadReport,
  strict: boolean,
  failures: string[],
  warnings: string[],
): void {
  const expected = new Set(fixture.expect.skipped.map((entry) => normalizeWhat(entry.what)));
  const actual = new Set(report.skipped.map((entry) => normalizeWhat(entry.what)));

  // A component the client may legitimately load is one it may legitimately not skip, so
  // the same set relaxes the check in both directions.
  const eitherWay = new Set([
    ...componentPaths(fixture.optional),
    ...componentPaths(fixture.atLeastOne),
  ]);
  const tolerated = new Set([...expected, ...eitherWay]);

  const missing = [...expected].filter((what) => !actual.has(what) && !eitherWay.has(what));
  const unexpected = [...actual].filter((what) => !tolerated.has(what));
  const sink = strict ? failures : warnings;

  if (missing.length > 0) {
    sink.push(`expected skipped to contain ${list(missing)}, got ${list(actual)}`);
  }
  if (unexpected.length > 0) {
    sink.push(`expected skipped not to contain ${list(unexpected)}, got ${list(actual)}`);
  }

  warnOnRuleIdMismatch(
    'skipped',
    report.skipped,
    (entry) => normalizeWhat(entry.what),
    new Map(
      fixture.expect.skipped
        .filter((entry) => entry.ruleId !== undefined)
        .map((entry) => [normalizeWhat(entry.what), entry.ruleId as string]),
    ),
    warnings,
  );
}

/**
 * Compares one load report against one fixture.
 *
 * `rejected` is compared on rejectedness, not on the string: every client has its own
 * rejection vocabulary and the specification defines none, so the value is echoed in the
 * message and never asserted.
 */
export function diffReport(fixture: Fixture, report: LoadReport, options: DiffOptions = {}): Verdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const shouldReject = fixture.expect.rejected !== null;
  const didReject = report.rejected !== null;

  if (shouldReject !== didReject) {
    failures.push(
      `expected rejected=${shouldReject ? '<non-null>' : 'null'}, got rejected=${quote(report.rejected)}`,
    );
  }

  // A rejected plugin has no components, so the name channels carry no information.
  if (didReject && shouldReject) {
    if (report.loaded.skills.length > 0 || report.loaded.mcpServers.length > 0) {
      failures.push(
        `expected a rejected plugin to load nothing, got skills=${list(report.loaded.skills)} mcpServers=${list(report.loaded.mcpServers)}`,
      );
    }
  } else if (!shouldReject) {
    compareNames('skills', report.loaded.skills, fixture, failures, notes);
    compareNames('mcpServers', report.loaded.mcpServers, fixture, failures, notes);
    compareAtLeastOne(fixture, report, failures);
    compareReported(fixture, report, failures, warnings);
    compareSkipped(fixture, report, options.strictReporting === true, failures, warnings);
  }

  return {
    fixture: fixture.id,
    ruleId: fixture.ruleId,
    section: fixture.spec,
    confidence: fixture.confidence,
    group: fixture.group,
    observability: fixture.observability,
    status: failures.length > 0 ? 'fail' : 'pass',
    failures,
    warnings,
    notes,
    report,
  };
}

/**
 * `FAIL AP-5.2-UNKNOWN-FIELD (spec 5.2) expected rejected=null, got rejected="schema"`
 *
 * Several fixtures can share one rule, so a trailing locator is appended whenever the
 * fixture directory is not named after the rule alone.
 */
export function formatVerdictLines(verdict: Verdict): string[] {
  const head = `${verdict.ruleId} (spec ${verdict.section})`;
  const dirName = verdict.fixture.slice(verdict.fixture.indexOf('/') + 1);
  const tail = dirName === verdict.ruleId ? '' : `  (${verdict.fixture})`;
  const lines: string[] = [];
  for (const failure of verdict.failures) lines.push(`FAIL ${head} ${failure}${tail}`);
  for (const warning of verdict.warnings) lines.push(`WARN ${head} ${warning}${tail}`);
  if (verdict.status === 'error') lines.push(`ERROR ${head} ${verdict.error ?? 'adapter failed'}${tail}`);
  if (verdict.status === 'skipped') {
    lines.push(`SKIP ${head} ${verdict.error ?? 'fixture not runnable here'}${tail}`);
  }
  return lines;
}

/** `PASS AP-7.1-DEPTH (spec 7.1)`, with the same locator rule as failures. */
export function formatPassLine(verdict: Verdict): string {
  const dirName = verdict.fixture.slice(verdict.fixture.indexOf('/') + 1);
  const tail = dirName === verdict.ruleId ? '' : `  (${verdict.fixture})`;
  return `PASS ${verdict.ruleId} (spec ${verdict.section})${tail}`;
}

export interface Summary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  warnings: number;
  byGroup: Record<FixtureGroup, { total: number; pass: number; fail: number; error: number; skipped: number }>;
}

export function summarize(verdicts: Verdict[]): Summary {
  const blank = () => ({ total: 0, pass: 0, fail: 0, error: 0, skipped: 0 });
  const summary: Summary = {
    total: verdicts.length,
    pass: 0,
    fail: 0,
    error: 0,
    skipped: 0,
    warnings: 0,
    byGroup: { core: blank(), disputed: blank(), regressions: blank() },
  };
  for (const verdict of verdicts) {
    summary[verdict.status] += 1;
    summary.warnings += verdict.warnings.length;
    const group = summary.byGroup[verdict.group];
    group.total += 1;
    group[verdict.status] += 1;
  }
  return summary;
}
