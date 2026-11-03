#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fail closed on missing, running or failed CI, including a failed rerun after a success. */
export async function checkRelease({ tag, version, sha, tagSha, repository, token, apiUrl = 'https://api.github.com' }, request = fetch) {
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match package version v${version}`);
  if (tagSha !== sha) throw new Error('the release tag does not point to the checked-out commit');
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[\w-]+\/[\w.-]+$/.test(repository) || !token) {
    throw new Error('release verification requires a commit, repository and GitHub token');
  }

  const url = new URL(`${apiUrl}/repos/${repository}/actions/workflows/ci.yml/runs`);
  // Do not filter for success: the latest run must be green, not an older successful run.
  url.search = new URLSearchParams({ head_sha: sha, branch: 'main', event: 'push', per_page: '1' }).toString();
  const response = await request(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not verify CI: GitHub HTTP ${response.status}`);
  const { workflow_runs: runs } = await response.json();
  const run = Array.isArray(runs) ? runs[0] : undefined;
  if (!run || run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push' ||
      run.head_repository?.full_name !== repository || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('the latest main-branch CI run for this exact commit must complete successfully before release');
  }
  return run.html_url;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const tag = process.env.RELEASE_TAG;
    if (tag !== `v${version}`) throw new Error(`release requires tag v${version}`);
    const git = (...args) => execFileSync('git', ['rev-parse', '--verify', ...args], { encoding: 'utf8' }).trim();
    const url = await checkRelease({
      tag, version, sha: git('HEAD'), tagSha: git(`refs/tags/${tag}^{commit}`),
      repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    console.log(`release gate passed: ${url}`);
  } catch (err) {
    console.error(`release blocked: ${err.message}`);
    process.exitCode = 1;
  }
}
