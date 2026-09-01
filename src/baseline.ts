import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Verdict, VerdictStatus } from './diff.js';

/**
 * A recorded run, used as a ratchet. A client adopting the suite part way through its life
 * starts with failures it already knows about; gating on the total makes the suite useless
 * to them, and gating on nothing makes it toothless. Gating on change is the useful one.
 */
export interface Baseline {
  tool: 'agent-plugins-conformance-kit';
  specVersion: string;
  /** Fixture id to the status it had when the baseline was written. */
  fixtures: Record<string, VerdictStatus>;
}

export class BaselineError extends Error {}

const isFailing = (status: VerdictStatus): boolean => status === 'fail' || status === 'error';

export async function readBaseline(path: string): Promise<Baseline | null> {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new BaselineError(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        'Delete it and re-run with --update-baseline to start again.',
    );
  }
  const fixtures = (parsed as Partial<Baseline>)?.fixtures;
  if (typeof fixtures !== 'object' || fixtures === null || Array.isArray(fixtures)) {
    throw new BaselineError(`${path} has no "fixtures" object. It is not an apconform baseline.`);
  }
  return parsed as Baseline;
}

export async function writeBaseline(
  path: string,
  specVersion: string,
  verdicts: Verdict[],
): Promise<void> {
  const fixtures: Record<string, VerdictStatus> = {};
  // Sorted so a committed baseline produces a readable diff when it changes.
  for (const verdict of [...verdicts].sort((a, b) => a.fixture.localeCompare(b.fixture))) {
    fixtures[verdict.fixture] = verdict.status;
  }
  const baseline: Baseline = { tool: 'agent-plugins-conformance-kit', specVersion, fixtures };
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export interface BaselineComparison {
  /** Failing now, passing or unknown before. These fail the run. */
  regressions: Verdict[];
  /** Failing now and failing before. Reported, not gated. */
  known: Verdict[];
  /** Passing now, failing before. Worth saying out loud. */
  fixed: string[];
  /** In the baseline but not in this run, usually a renamed or removed fixture. */
  missing: string[];
}

export function compareToBaseline(verdicts: Verdict[], baseline: Baseline): BaselineComparison {
  const regressions: Verdict[] = [];
  const known: Verdict[] = [];
  const fixed: string[] = [];
  const seen = new Set<string>();

  for (const verdict of verdicts) {
    seen.add(verdict.fixture);
    const before = baseline.fixtures[verdict.fixture];
    if (isFailing(verdict.status)) {
      // A fixture absent from the baseline is new coverage, so it has to pass on its own.
      if (before !== undefined && isFailing(before)) known.push(verdict);
      else regressions.push(verdict);
    } else if (verdict.status === 'pass' && before !== undefined && isFailing(before)) {
      fixed.push(verdict.fixture);
    }
  }

  const missing = Object.keys(baseline.fixtures).filter((id) => !seen.has(id));
  return { regressions, known, fixed, missing };
}
