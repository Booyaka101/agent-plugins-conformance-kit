import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffReport } from '../src/diff.js';
import { adapterLaunch, CorpusError, loadCorpus, runAdapter, runSuite } from '../src/runner.js';

const fixture = (await loadCorpus({ filter: 'core/AP-7.1-DEPTH' }))[0]!;
const echo = fileURLToPath(new URL('./echo-adapter.mjs', import.meta.url));

describe('custom corpus input validation', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'apconform-manifest-'));
    dir = join(root, 'core', 'custom');
    await mkdir(join(dir, 'plugin'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function load(data: unknown) {
    await writeFile(join(dir, 'fixture.json'), JSON.stringify(data));
    return loadCorpus({ root });
  }

  it.each([
    null, [], 3, { ...fixture, title: 3 }, { ...fixture, observability: 'unknown' },
    { ...fixture, optional: [] }, { ...fixture, optional: { skills: 'alpha' } },
    { ...fixture, optional: { mcpServers: [3] } }, { ...fixture, optional: { rejected: 'yes' } },
    { ...fixture, atLeastOne: { skill: ['alpha'] } }, { ...fixture, links: {} },
    { ...fixture, links: [null] }, { ...fixture, links: [{ path: 'x', target: 'y', type: 'unknown' }] },
    { ...fixture, links: [{ path: '', target: 'y', type: 'dir' }] },
  ])('rejects malformed manifest data before launching an adapter: %j', async (data) => {
    await expect(load(data)).rejects.toThrow(CorpusError);
  });

  it('uses normalized expectation arrays instead of retaining omitted fields', async () => {
    const [loaded] = await load({ ...fixture, expect: {
      rejected: null, loaded: { skills: [], mcpServers: [] },
    } });
    expect(loaded?.expect.skipped).toEqual([]);
    expect(loaded?.expect.reported).toEqual([]);
    expect(diffReport(loaded!, loaded!.expect).status).toBe('pass');
  });

  it('rejects a file masquerading as a plugin directory', async () => {
    await rm(join(dir, 'plugin'), { recursive: true });
    await writeFile(join(dir, 'plugin'), 'not a directory');
    await expect(load(fixture)).rejects.toThrow(/no plugin\/ directory/);
  });

  it('rejects a file masquerading as a corpus directory', async () => {
    const path = join(root, 'file');
    await writeFile(path, '{}');
    await expect(loadCorpus({ root: path })).rejects.toThrow(CorpusError);
  });
});

describe('library execution option validation', () => {
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid concurrency %s before running', async (concurrency) => {
    await expect(runSuite([], { adapter: echo, concurrency })).rejects.toThrow(/concurrency/);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s at both public entrypoints', async (timeoutMs) => {
    await expect(runSuite([], { adapter: echo, timeoutMs })).rejects.toThrow(/timeoutMs/);
    await expect(runAdapter(adapterLaunch(echo), tmpdir(), timeoutMs)).rejects.toThrow(/timeoutMs/);
  });
});
