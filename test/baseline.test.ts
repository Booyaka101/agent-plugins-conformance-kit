import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaselineError, compareToBaseline, readBaseline, writeBaseline } from '../src/baseline.js';
import type { Baseline } from '../src/baseline.js';
import type { Verdict, VerdictStatus } from '../src/diff.js';

const verdict = (fixture: string, status: VerdictStatus): Verdict => ({
  fixture,
  ruleId: 'AP-7.1-DEPTH',
  section: '7.1',
  confidence: 'core',
  group: 'core',
  observability: 'report',
  status,
  failures: status === 'fail' ? ['expected loaded.skills to contain [alpha], got []'] : [],
  warnings: [],
  notes: [],
});

const baseline = (fixtures: Record<string, VerdictStatus>): Baseline => ({
  tool: 'agent-plugins-conformance-kit',
  specVersion: '1.0.0',
  fixtures,
});

describe('compareToBaseline', () => {
  it('treats a fixture failing now and before as known, not a regression', () => {
    const result = compareToBaseline([verdict('core/a', 'fail')], baseline({ 'core/a': 'fail' }));
    expect(result.known.map((v) => v.fixture)).toEqual(['core/a']);
    expect(result.regressions).toEqual([]);
  });

  it('treats a fixture that used to pass and now fails as a regression', () => {
    const result = compareToBaseline([verdict('core/a', 'fail')], baseline({ 'core/a': 'pass' }));
    expect(result.regressions.map((v) => v.fixture)).toEqual(['core/a']);
    expect(result.known).toEqual([]);
  });

  it('treats a failing fixture absent from the baseline as a regression', () => {
    const result = compareToBaseline([verdict('core/new', 'fail')], baseline({}));
    expect(result.regressions.map((v) => v.fixture)).toEqual(['core/new']);
  });

  it('counts an error the same way as a failure, in both directions', () => {
    expect(compareToBaseline([verdict('core/a', 'error')], baseline({ 'core/a': 'fail' })).known)
      .toHaveLength(1);
    expect(compareToBaseline([verdict('core/a', 'fail')], baseline({ 'core/a': 'error' })).known)
      .toHaveLength(1);
    expect(compareToBaseline([verdict('core/a', 'error')], baseline({ 'core/a': 'pass' })).regressions)
      .toHaveLength(1);
  });

  it('reports a fixture that used to fail and now passes as fixed', () => {
    const result = compareToBaseline([verdict('core/a', 'pass')], baseline({ 'core/a': 'fail' }));
    expect(result.fixed).toEqual(['core/a']);
    expect(result.regressions).toEqual([]);
  });

  it('does not call an always-passing fixture fixed', () => {
    expect(compareToBaseline([verdict('core/a', 'pass')], baseline({ 'core/a': 'pass' })).fixed)
      .toEqual([]);
  });

  it('names baseline entries that are not in this run', () => {
    const result = compareToBaseline([verdict('core/a', 'pass')], baseline({ 'core/a': 'pass', 'core/gone': 'fail' }));
    expect(result.missing).toEqual(['core/gone']);
  });

  it('does not treat a skipped fixture as a failure or a fix', () => {
    const result = compareToBaseline([verdict('core/a', 'skipped')], baseline({ 'core/a': 'fail' }));
    expect(result).toMatchObject({ regressions: [], known: [], fixed: [] });
  });
});

describe('baseline files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apconform-baseline-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when there is no baseline yet', async () => {
    expect(await readBaseline(join(dir, 'absent.json'))).toBeNull();
  });

  it('round-trips a run and sorts the fixtures', async () => {
    const path = join(dir, 'baseline.json');
    await writeBaseline(path, '1.0.0', [verdict('core/z', 'fail'), verdict('core/a', 'pass')]);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).fixtures)).toEqual(['core/a', 'core/z']);
    expect(await readBaseline(path)).toEqual(baseline({ 'core/a': 'pass', 'core/z': 'fail' }));
  });

  it('explains a corrupt baseline instead of throwing a parse error', async () => {
    const path = join(dir, 'corrupt.json');
    await writeFile(path, 'not json');
    await expect(readBaseline(path)).rejects.toThrow(BaselineError);
    await expect(readBaseline(path)).rejects.toThrow(/--update-baseline/);
  });

  it('rejects a JSON file that is not a baseline', async () => {
    const path = join(dir, 'other.json');
    await writeFile(path, '{"something": "else"}');
    await expect(readBaseline(path)).rejects.toThrow(/not an apconform baseline/);
  });
});
