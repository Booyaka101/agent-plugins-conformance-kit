import { describe, expect, it } from 'vitest';
import { checkRelease } from '../scripts/check-release.mjs';

const sha = 'a'.repeat(40);
const options = {
  tag: 'v1.2.3', version: '1.2.3', sha, tagSha: sha,
  repository: 'owner/repo', token: 'test-token',
};
const green = {
  head_sha: sha, head_branch: 'main', event: 'push', head_repository: { full_name: 'owner/repo' },
  status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/1',
};
const response = (runs) => async () => ({ ok: true, json: async () => ({ workflow_runs: runs }) });

describe('the release gate', () => {
  it('accepts the exact tagged commit after a successful main-branch CI run', async () => {
    let requested;
    const result = await checkRelease(options, async (url, init) => {
      requested = url;
      expect(init.headers.authorization).toBe('Bearer test-token');
      return response([green])();
    });
    expect(result).toBe(green.html_url);
    expect(requested.pathname).toBe('/repos/owner/repo/actions/workflows/ci.yml/runs');
    expect(Object.fromEntries(requested.searchParams)).toEqual({ head_sha: sha, branch: 'main', event: 'push', per_page: '1' });
    expect(requested.searchParams.has('status')).toBe(false);
  });

  it.each([
    [], [{ ...green, head_sha: 'b'.repeat(40) }], [{ ...green, head_branch: 'other' }],
    [{ ...green, event: 'pull_request' }], [{ ...green, head_repository: { full_name: 'other/repo' } }],
    [{ ...green, status: 'in_progress', conclusion: null }], [{ ...green, conclusion: 'failure' }],
    [{ ...green, conclusion: 'cancelled' }], [{ ...green, conclusion: 'skipped' }],
    [{ ...green, conclusion: 'failure' }, green],
  ].map((runs) => ({ runs })))('blocks missing or non-green latest CI: $runs', async ({ runs }) => {
    await expect(checkRelease(options, response(runs))).rejects.toThrow(/latest main-branch CI/);
  });

  it.each([
    { tag: 'v9.9.9' }, { tagSha: 'b'.repeat(40) }, { token: '' }, { repository: '../bad' },
  ])('rejects invalid release inputs before contacting GitHub: %j', async (overrides) => {
    await expect(checkRelease({ ...options, ...overrides }, () => { throw new Error('unexpected request'); }))
      .rejects.not.toThrow('unexpected request');
  });

  it('fails closed on API failure', async () => {
    await expect(checkRelease(options, async () => ({ ok: false, status: 403 }))).rejects.toThrow('GitHub HTTP 403');
  });

  it('fails closed on malformed API data', async () => {
    await expect(checkRelease(options, response(null))).rejects.toThrow(/latest main-branch CI/);
  });

  it('propagates a network failure instead of approving release', async () => {
    await expect(checkRelease(options, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
});
