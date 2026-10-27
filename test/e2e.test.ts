import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus, runSuite } from '../src/runner.js';
import { packageRoot } from '../src/rules.js';

const ECHO = fileURLToPath(new URL('./echo-adapter.mjs', import.meta.url));
const CLI = join(packageRoot, 'dist', 'cli.js');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      cwd: packageRoot,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('the runner against a perfect client', () => {
  it('passes every fixture in the corpus', async () => {
    const fixtures = await loadCorpus();
    const { summary, verdicts } = await runSuite(fixtures, { adapter: ECHO });

    const notPassing = verdicts
      .filter((v) => v.status !== 'pass' && v.status !== 'skipped')
      .map((v) => `${v.fixture}: ${v.failures.join('; ') || v.error}`);

    expect(notPassing).toEqual([]);
    expect(summary.fail).toBe(0);
    expect(summary.error).toBe(0);
    expect(summary.pass + summary.skipped).toBe(fixtures.length);
  });

  it('reports failures when the adapter is wrong', async () => {
    const fixtures = (await loadCorpus({ groups: ['core'] })).slice(0, 12);
    const { summary } = await runSuite(fixtures, {
      adapter: ECHO,
      onVerdict: () => {},
    });
    expect(summary.pass + summary.skipped).toBe(fixtures.length);

    process.env['APCONFORM_ECHO_BREAK'] = '1';
    try {
      const broken = await runSuite(fixtures, { adapter: ECHO });
      expect(broken.summary.fail).toBeGreaterThan(0);
    } finally {
      delete process.env['APCONFORM_ECHO_BREAK'];
    }
  });
});

describe('the runner handling a misbehaving adapter', () => {
  const one = async () => (await loadCorpus({ filter: 'core/AP-7.1-DEPTH' })).slice(0, 1);

  it('turns non-JSON stdout into an error, not a crash', async () => {
    process.env['APCONFORM_ECHO_JUNK'] = '1';
    try {
      const { verdicts } = await runSuite(await one(), { adapter: ECHO });
      expect(verdicts[0]?.status).toBe('error');
      expect(verdicts[0]?.error).toContain('not JSON');
    } finally {
      delete process.env['APCONFORM_ECHO_JUNK'];
    }
  });

  it('reports a non-zero exit alongside the report', async () => {
    process.env['APCONFORM_ECHO_EXIT'] = '3';
    try {
      const { verdicts } = await runSuite(await one(), { adapter: ECHO });
      expect(verdicts[0]?.status).toBe('error');
      expect(verdicts[0]?.error).toContain('exited 3');
    } finally {
      delete process.env['APCONFORM_ECHO_EXIT'];
    }
  });

  it('kills an adapter that never exits', async () => {
    process.env['APCONFORM_ECHO_HANG'] = '1';
    try {
      const { verdicts } = await runSuite(await one(), { adapter: ECHO, timeoutMs: 1500 });
      expect(verdicts[0]?.status).toBe('error');
      expect(verdicts[0]?.error).toContain('timed out');
    } finally {
      delete process.env['APCONFORM_ECHO_HANG'];
    }
  });

  it('kills an adapter that floods stdout instead of running out of memory', async () => {
    process.env['APCONFORM_ECHO_FLOOD'] = '1';
    try {
      const { verdicts } = await runSuite(await one(), { adapter: ECHO, timeoutMs: 60_000 });
      expect(verdicts[0]?.status).toBe('error');
      expect(verdicts[0]?.error).toMatch(/printed more than 8 MB/);
    } finally {
      delete process.env['APCONFORM_ECHO_FLOOD'];
    }
  });

  it('refuses an adapter path that does not exist', async () => {
    await expect(runSuite(await one(), { adapter: './no-such-adapter.mjs' })).rejects.toThrow(
      /adapter not found/,
    );
  });

  it('refuses an adapter that is a directory', async () => {
    await expect(runSuite(await one(), { adapter: packageRoot })).rejects.toThrow(
      /adapter is not a file/,
    );
  });

  it('fails the whole run once when the adapter cannot be launched at all', async () => {
    const many = await loadCorpus({ groups: ['core'] });
    await expect(
      runSuite(many, { adapter: ECHO, adapterExec: 'apconform-no-such-interpreter' }),
    ).rejects.toThrow(/could not start adapter/);
  });
});

describe('the CLI', () => {
  let out: string;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'apconform-test-'));
  });
  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('exits 0 and writes a JSON report for a passing run', async () => {
    const jsonPath = join(out, 'report.json');
    const result = await run(['run', '--adapter', ECHO, '--only', 'core', '--json', jsonPath, '--quiet']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^core\s+\d+ pass\s+0 fail/m);

    const payload = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(payload.tool).toBe('agent-plugins-conformance-kit');
    expect(payload.specVersion).toBe('1.0.0');
    expect(payload.summary.fail).toBe(0);
    expect(payload.verdicts.length).toBe(payload.summary.total);
  });

  it('exits 1 when a fixture fails', async () => {
    const result = await run(['run', '--adapter', ECHO, '--fixture', 'AP-7.1-DEPTH', '--quiet'], {
      APCONFORM_ECHO_BREAK: '1',
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('FAIL AP-7.1-DEPTH (spec 7.1)');
  });

  it('produces byte-identical output across two runs of the same corpus', async () => {
    const first = await run(['run', '--adapter', ECHO, '--only', 'core', '--concurrency', '8']);
    const second = await run(['run', '--adapter', ECHO, '--only', 'core', '--concurrency', '8']);
    expect(first.stdout).toBe(second.stdout);

    // Concurrency must not change what is printed either, only how fast it arrives.
    const serial = await run(['run', '--adapter', ECHO, '--only', 'core', '--concurrency', '1']);
    expect(serial.stdout).toBe(first.stdout);
  });

  it.each([['fixture'], ['only'], ['json'], ['baseline'], ['fixtures'], ['adapter-exec'], ['timeout']])(
    'exits 2 when --%s is given no value',
    async (flag) => {
      const result = await run(['run', '--adapter', ECHO, `--${flag}`, '--quiet']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`--${flag} requires a value`);
    },
  );

  it('exits 2 with usage on a bad --only', async () => {
    const result = await run(['run', '--adapter', ECHO, '--only', 'nonsense']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--only accepts');
    expect(result.stderr).toContain('Usage:');
  });

  it.each([
    ['concurrency', '0.5'], ['concurrency', '1.5'], ['concurrency', '9007199254740992'],
    ['timeout', '0.5'], ['timeout', '2147483648'], ['timeout', 'Infinity'],
  ])('rejects unsafe --%s values before running: %s', async (flag, value) => {
    const result = await run(['run', '--adapter', ECHO, `--${flag}`, value]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`--${flag} must be`);
    expect(result.stdout).toBe('');
  });

  it.each([['json', 'junit'], ['baseline', 'json'], ['baseline', 'junit']])(
    'rejects colliding --%s and --%s paths before running',
    async (first, second) => {
      const path = join(out, 'same-output.json');
      await writeFile(path, 'preserve existing contents');
      const result = await run([
        'run', '--adapter', ECHO, `--${first}`, `${out}/./same-output.json`,
        `--${second}`, path,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('must use different paths');
      expect(result.stdout).toBe('');
      expect(await readFile(path, 'utf8')).toBe('preserve existing contents');
    },
  );

  it('accepts integer execution options including the maximum supported timeout', async () => {
    const result = await run([
      'run', '--adapter', ECHO, '--fixture', 'AP-7.1-DEPTH',
      '--concurrency=2', '--timeout=2147483647', '--quiet',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/total\s+3 pass\s+0 fail/);
  });

  it.each(['run', 'list', 'verify', 'rules', 'show', 'explain'])(
    'shows help for %s without requiring command arguments',
    async (command) => {
      const result = await run([command, '--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stderr).toBe('');
    },
  );

  it.each([
    ['help', '--typo'], ['--help', 'unexpected'], ['version', '--typo'], ['-v', 'unexpected'],
    ['rules', '--json=false'], ['run', '--help=false'], ['constructor'], ['__proto__'],
  ])('rejects invalid help, version and command arguments: %s', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('apconform:');
    expect(result.stderr).not.toContain('TypeError');
  });

  it.each([[], ['help'], ['--help'], ['-h'], ['version'], ['--version'], ['-v']])(
    'preserves help and version aliases: %s', async (...args) => {
      const result = await run(args);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toBe('');
    },
  );

  it.each([
    ['run', '--adapter', ECHO, '--fixture', 'AP-7.1-DEPTH', '--strict-repoting'],
    ['list', '--strict-reporting'],
    ['rules', '--adapter', ECHO],
    ['verify', '--fixture', 'AP-7.1-DEPTH'],
    ['show', 'AP-7.1-DEPTH', '--fixtures', 'missing-corpus'],
    ['explain', 'AP-7.1-DEPTH', '--json'],
  ])('rejects unsupported flags before running: %s', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option');
    expect(result.stdout).toBe('');
  });

  it.each(['quiet', 'strict-reporting', 'update-baseline'])(
    'rejects an explicit value for boolean --%s',
    async (flag) => {
      const result = await run(['run', '--adapter', ECHO, '--fixture', 'AP-7.1-DEPTH', `--${flag}=false`]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`--${flag} does not take a value`);
      expect(result.stdout).toBe('');
    },
  );

  it('rejects duplicate options rather than silently overwriting them', async () => {
    const result = await run(['list', '--only', 'core', '--only=disputed']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('duplicate option --only');
    expect(result.stdout).toBe('');
  });

  it.each([
    ['run', '--adapter', ECHO, '--fixture', 'AP-7.1-DEPTH', 'unexpected'],
    ['list', 'unexpected'],
    ['show', 'AP-7.1-DEPTH', 'unexpected'],
    ['explain', 'AP-7.1-DEPTH', 'unexpected'],
  ])('rejects extra positional arguments: %s', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unexpected argument');
    expect(result.stdout).toBe('');
  });

  it('requires --baseline when updating a baseline', async () => {
    const result = await run(['run', '--adapter', ECHO, '--update-baseline']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--update-baseline requires --baseline');
    expect(result.stdout).toBe('');
  });

  it('requires a value for verify --fixtures instead of verifying the default corpus', async () => {
    const result = await run(['verify', '--fixtures']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--fixtures requires a value');
    expect(result.stdout).toBe('');
  });

  it('rejects a separate boolean value instead of disabling strict reporting', async () => {
    const result = await run(['run', '--adapter', ECHO, '--strict-reporting', 'false']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--strict-reporting does not take a value');
    expect(result.stdout).toBe('');
  });

  it('accepts equals-style values and boolean rules --json', async () => {
    const listed = await run(['list', '--only=regressions']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('4 fixtures');

    const rules = await run(['rules', '--json']);
    expect(rules.code).toBe(0);
    expect(JSON.parse(rules.stdout).specVersion).toBe('1.0.0');
  });

  it('exits 2 when no fixture matches the filter', async () => {
    const result = await run(['run', '--adapter', ECHO, '--fixture', 'no-such-fixture']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no fixtures match');
  });

  it('gates on change once a baseline exists', async () => {
    const baseline = join(out, 'baseline.json');
    const args = ['run', '--adapter', ECHO, '--fixture', 'AP-7.1-DEPTH', '--quiet', '--baseline', baseline];

    // Reported before the corpus runs, not after it.
    const started = Date.now();
    const missing = await run(args);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('no baseline at');
    expect(missing.stdout).not.toContain('fixtures  adapter');
    expect(Date.now() - started).toBeLessThan(5_000);

    // Record a run in which the client is broken, then confirm those failures stop gating.
    const record = await run([...args, '--update-baseline'], { APCONFORM_ECHO_BREAK: '1' });
    expect(record.code).toBe(0);
    expect(record.stdout).toContain('wrote baseline');

    const known = await run(args, { APCONFORM_ECHO_BREAK: '1' });
    expect(known.code).toBe(0);
    expect(known.stdout).toMatch(/baseline\s+0 regressions\s+3 known\s+0 fixed/);
    // A failure the baseline already records must not print as a red FAIL the summary
    // then contradicts.
    expect(known.stdout).toContain('KNOWN AP-7.1-DEPTH (spec 7.1)');
    expect(known.stdout).not.toContain('FAIL AP-7.1-DEPTH');

    const fixed = await run(args);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain('FIXED core/AP-7.1-DEPTH');
    expect(fixed.stdout).toContain('--update-baseline to lock the fixes in');

    await run([...args, '--update-baseline']);
    const regressed = await run(args, { APCONFORM_ECHO_BREAK: '1' });
    expect(regressed.code).toBe(1);
    expect(regressed.stdout).toContain('REGRESSION AP-7.1-DEPTH (spec 7.1)');
  });

  it('writes JUnit XML a CI system can read', async () => {
    const junitPath = join(out, 'junit.xml');
    const result = await run(['run', '--adapter', ECHO, '--only', 'core', '--junit', junitPath, '--quiet']);
    expect(result.code).toBe(0);

    const xml = await readFile(junitPath, 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('name="agent-plugins.core"');
    expect(xml).toContain('classname="core/AP-7.1-DEPTH"');
    expect(xml.trimEnd().endsWith('</testsuites>')).toBe(true);
  });

  it('shows a fixture, and disambiguates a partial id', async () => {
    const one = await run(['show', 'core/AP-7.2.1-CWD-FORMS']);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('a cwd of "../escape" is not a permitted form');
    expect(one.stdout).toContain('"cwd": "../escape"');
    expect(one.stdout).toContain('expected load report');

    const many = await run(['show', 'AP-7.1-DEPTH']);
    expect(many.code).toBe(0);
    expect(many.stdout).toContain('3 fixtures match');
    expect(many.stdout).toContain('core/AP-7.1-DEPTH__deep-nesting');

    const none = await run(['show', 'no-such-fixture']);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('no fixture matching');
  });

  it('verifies the corpus', async () => {
    const result = await run(['verify']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^corpus OK: \d+ fixtures, \d+ rules$/m);
  });

  it('lists rules and explains one', async () => {
    expect((await run(['rules'])).stdout).toContain('AP-7.1-DEPTH');

    const explained = await run(['explain', 'AP-7.1-DEPTH']);
    expect(explained.code).toBe(0);
    expect(explained.stdout).toContain(
      'Clients MUST NOT recursively search deeper descendants for additional skills.',
    );
  });

  it('exits 2 on an unknown rule id', async () => {
    const result = await run(['explain', 'AP-9.9-NOPE']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no rule "AP-9.9-NOPE"');
  });
});
