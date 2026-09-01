export type { LoadReport, ReportedEntry, SkippedEntry, ParseResult } from './report.js';
export { parseLoadReport, validateLoadReport } from './report.js';

export type {
  DiffOptions,
  Fixture,
  FixtureExpectation,
  FixtureGroup,
  LinkSpec,
  NameSets,
  Observability,
  Summary,
  Verdict,
  VerdictStatus,
} from './diff.js';
export {
  diffReport,
  formatPassLine,
  formatVerdictLines,
  normalizeWhat,
  summarize,
} from './diff.js';

export type { Confidence, Rule, RuleTable, Severity } from './rules.js';
export { loadRules, packageRoot, ruleIndex } from './rules.js';

export type { AdapterResult, CorpusOptions, RunOptions, RunResult } from './runner.js';
export {
  AdapterError,
  CorpusError,
  GROUPS,
  adapterLaunch,
  fixtureRoot,
  isDirectory,
  loadCorpus,
  runAdapter,
  runFixture,
  runSuite,
} from './runner.js';

export type { Baseline, BaselineComparison } from './baseline.js';
export { BaselineError, compareToBaseline, readBaseline, writeBaseline } from './baseline.js';

export type { Problem } from './verify.js';
export { skillName, verifyCorpus } from './verify.js';
