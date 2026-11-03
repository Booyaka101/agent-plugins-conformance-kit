import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterLaunch, fixtureRoot, loadCorpus, runAdapter, runSuite } from '../src/runner.js';

describe('adapter output limits', () => {
  let root: string;
  const cap = 8 * 1024 * 1024;

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'apconform-output-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each(['stdout', 'stderr'] as const)('caps %s by UTF-8 bytes, including the final chunk', async (stream) => {
    const path = join(root, 'adapter.mjs');
    // Fewer than 8M characters but more than 8 MiB. No later write is needed to trip the cap.
    await writeFile(path, `process.${stream}.write('\\u20ac'.repeat(3 * 1024 * 1024));`);
    const result = await runAdapter(adapterLaunch(path), root, 10_000);
    expect(result.overflowed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Buffer.byteLength(result[stream], 'utf8')).toBeLessThanOrEqual(cap);
  });

  it('accepts output exactly at the cap', async () => {
    const path = join(root, 'adapter.mjs');
    await writeFile(path, `process.stdout.write('x'.repeat(${cap}));`);
    const result = await runAdapter(adapterLaunch(path), root, 10_000);
    expect(result.overflowed).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(cap);
  });
});

describe('staged fixture link containment', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'apconform-links-'));
    await mkdir(join(root, 'plugin', 'skills'), { recursive: true });
    await writeFile(join(root, 'fixture.json'), '{}');
    await writeFile(join(root, 'sentinel'), 'preserve me');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function runLinks(paths: string[]) {
    const fixture = (await loadCorpus({ filter: 'core/AP-7.1-DEPTH' }))[0]!;
    return runSuite([{
      ...fixture,
      dir: root,
      links: paths.map((path) => ({ path, target: root, type: 'dir' as const })),
    }], { adapter: join(root, 'sentinel') });
  }

  it('resolves a relative corpus root before constructing plugin paths', () => {
    expect(fixtureRoot(relative(process.cwd(), root))).toBe(root);
    expect(isAbsolute(fixtureRoot())).toBe(true);
  });

  it('counts unexpected staging failures as errors, not successful skips', async () => {
    const result = await runLinks(['missing-parent/link']);
    expect(result.summary.error).toBe(1);
    expect(result.summary.skipped).toBe(0);
    expect(result.verdicts[0]?.error).toContain('could not stage fixture');
  });

  it.each(['.', '..', '../outside'])('rejects link destination %s as a corpus error', async (path) => {
    await expect(runLinks([path])).rejects.toThrow(/link path must stay inside/);
    expect(await readFile(join(root, 'sentinel'), 'utf8')).toBe('preserve me');
  });

  it('rejects an absolute destination without deleting it', async () => {
    await expect(runLinks([join(root, 'sentinel')])).rejects.toThrow(/link path must stay inside/);
    expect(await readFile(join(root, 'sentinel'), 'utf8')).toBe('preserve me');
  });

  it('rejects a destination redirected through an earlier directory link', async () => {
    await expect(runLinks(['skills/redirect', 'skills/redirect/sentinel'])).rejects.toThrow(/link path must stay inside/);
    expect(await readFile(join(root, 'sentinel'), 'utf8')).toBe('preserve me');
  });
});
