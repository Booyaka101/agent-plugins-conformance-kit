import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageRoot } from '../src/rules.js';

const action = YAML.parse(await readFile(join(packageRoot, 'action.yml'), 'utf8'));
const bash = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..', 'bin/bash.exe')
  : 'bash';

describe('the composite Action shell', () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'apconform-action-'));
    workspace = join(root, 'workspace with spaces');
    await mkdir(workspace);
    await writeFile(join(root, 'fake-npx.mjs'), `
      import { writeFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      writeFileSync(process.env.APCONFORM_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }));
      const mode = process.env.APCONFORM_TEST_MODE;
      if (mode === 'setup') { console.error('setup failed'); process.exit(2); }
      if (mode === 'install') { console.error('installation failed'); process.exit(1); }
      if (mode === 'empty') process.exit(0);
      for (const flag of ['--json', '--junit', '--baseline']) {
        const i = args.indexOf(flag);
        if (i !== -1) writeFileSync(args[i + 1], flag);
      }
      console.log('total          2 pass  1 fail  0 error  0 skipped  0 warnings');
      process.exit(mode === 'fail' ? 1 : 0);
    `);
    await writeFile(join(root, 'run.sh'),
      `npx() { node "$APCONFORM_FAKE_NPX" "$@"; }\n${action.runs.steps[0].run}`);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function run(inputs: Record<string, string> = {}, mode = 'pass') {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, definition] of Object.entries(action.inputs) as Array<[string, { default?: string }]>) {
      const variable = Object.entries(action.runs.steps[0].env)
        .find(([, expression]) => expression === `\${{ inputs.${name} }}`)?.[0];
      if (variable) env[variable] = inputs[name] ?? definition.default ?? '';
    }
    Object.assign(env, {
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: join(root, 'outputs'),
      GITHUB_STEP_SUMMARY: join(root, 'summary'),
      RUNNER_TEMP: root,
      APCONFORM_FAKE_NPX: join(root, 'fake-npx.mjs'),
      APCONFORM_CAPTURE: join(root, 'capture.json'),
      APCONFORM_TEST_MODE: mode,
    });
    const result = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      const child = spawn(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(root, 'run.sh').replace(/\\/g, '/')], {
        cwd: workspace, env, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => done({ code, stderr }));
    });
    const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
    return { ...result, ...capture, outputs: await readFile(join(root, 'outputs'), 'utf8') };
  }

  it.each(['relative', 'absolute'])('resolves %s artifact and adapter paths without shell expansion', async (kind) => {
    const path = (name: string) => kind === 'absolute' ? join(root, name) : name;
    const inputs = {
      adapter: path('adapter with spaces.mjs'), json: path('result with spaces.json'),
      junit: path('junit.xml'), baseline: path('baseline.json'), 'update-baseline': 'true',
      fixture: 'literal $(not-a-command); value',
    };
    const result = await run(inputs);
    expect(result.code, result.stderr).toBe(0);
    for (const [input, flag] of [['adapter', '--adapter'], ['json', '--json'], ['junit', '--junit'], ['baseline', '--baseline']] as const) {
      const expected = resolve(workspace, inputs[input]);
      expect(result.args[result.args.indexOf(flag) + 1]).toBe(expected);
      if (input !== 'adapter') expect(existsSync(expected)).toBe(true);
    }
    expect(result.args[result.args.indexOf('--fixture') + 1]).toBe(inputs.fixture);
    expect(result.outputs).toContain('passed=2\nfailed=1\n');
    expect(existsSync(result.cwd)).toBe(false);
  });

  it.each([['true', 1], ['false', 0]])('gates fixture failures with fail-on-error=%s', async (value, code) => {
    expect((await run({ adapter: 'adapter.mjs', 'fail-on-error': String(value) }, 'fail')).code).toBe(code);
  });

  it('preserves setup failures and emits zero counts even in report-only mode', async () => {
    const result = await run({ adapter: 'missing.mjs', 'fail-on-error': 'false' }, 'setup');
    expect(result.code).toBe(2);
    expect(result.outputs).toContain('passed=0\nfailed=0\n');
    expect(existsSync(result.cwd)).toBe(false);
  });

  it.each(['empty', 'install'])('rejects npx %s without a completed suite', async (mode) => {
    const result = await run({ adapter: 'adapter.mjs', 'fail-on-error': 'false' }, mode);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('produced no summary');
  });
});
