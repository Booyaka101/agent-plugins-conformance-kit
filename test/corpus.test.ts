import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/runner.js';
import { loadRules, packageRoot, ruleIndex } from '../src/rules.js';
import { verifyCorpus } from '../src/verify.js';

const fixtures = await loadCorpus();
const table = loadRules();
const rules = ruleIndex(table);

describe('the fixture corpus', () => {
  it('ships enough core fixtures to be worth running', () => {
    expect(fixtures.filter((f) => f.group === 'core').length).toBeGreaterThanOrEqual(60);
  });

  it('has at least one fixture per rule', () => {
    const covered = new Set(fixtures.map((f) => f.ruleId));
    const uncovered = table.rules.filter((rule) => !covered.has(rule.id)).map((rule) => rule.id);
    expect(uncovered).toEqual([]);
  });

  it.each(fixtures.map((f) => [f.id, f] as const))('%s names a real rule', (_id, fixture) => {
    const rule = rules.get(fixture.ruleId);
    expect(rule, `${fixture.id} names unknown rule ${fixture.ruleId}`).toBeDefined();
    expect(fixture.confidence).toBe(rule?.confidence);
    expect(fixture.spec).toBe(rule?.section);
    expect(fixture.quote).toBe(rule?.quote);
  });

  it.each(fixtures.filter((f) => f.group !== 'regressions').map((f) => [f.id, f] as const))(
    '%s confidence matches its parent folder',
    (_id, fixture) => {
      expect(fixture.confidence).toBe(fixture.group);
      expect(basename(fixture.dir).split('__')[0]).toBe(fixture.ruleId);
    },
  );

  it('passes the corpus self-check', async () => {
    expect(await verifyCorpus(fixtures)).toEqual([]);
  });

  it('cites an issue on every regression fixture', () => {
    for (const fixture of fixtures.filter((f) => f.group === 'regressions')) {
      expect(fixture.issue, `${fixture.id} has no issue link`).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it('expects rejected=null on both spec issue #77 fixtures', () => {
    for (const id of ['core/AP-5.2-UNKNOWN-FIELD', 'core/AP-8.1-EXTENSIONS-NOT-OBJECT']) {
      const fixture = fixtures.find((f) => f.id === id);
      expect(fixture, `${id} is missing`).toBeDefined();
      expect(fixture?.expect.rejected).toBeNull();
      expect(fixture?.issue).toBe('https://github.com/agentplugins/agent-plugins-spec/issues/77');
    }
  });

  it('matches the brief\'s worked examples', () => {
    const unknownField = fixtures.find((f) => f.id === 'core/AP-5.2-UNKNOWN-FIELD');
    expect(unknownField?.expect).toEqual({
      rejected: null,
      loaded: { skills: [], mcpServers: [] },
      skipped: [],
      reported: [{ field: 'skills', ruleId: 'AP-5.2-UNKNOWN-FIELD' }],
    });

    const depth = fixtures.find((f) => f.id === 'core/AP-7.1-DEPTH');
    expect(depth?.expect.loaded.skills).toEqual(['alpha']);
  });
});

describe('the corpus as a shipped artifact', () => {
  // The corpus deliberately contains directories named node_modules and dist, because a
  // client must not discover skills inside them. An unanchored ignore rule drops those
  // files from the repository while leaving the fixture looking fine on the machine that
  // wrote it, and the fixture then passes without testing anything.
  it('has every fixture file tracked by git', () => {
    const tracked = spawnSync('git', ['ls-files', '-z', 'fixtures'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    if (tracked.status !== 0) {
      expect(tracked.stderr).toContain('not a git repository');
      return;
    }

    const inGit = new Set(tracked.stdout.split('\0').filter(Boolean));
    const onDisk = readdirSync(join(packageRoot, 'fixtures'), { recursive: true, encoding: 'utf8' })
      .map((entry) => `fixtures/${entry.split(sep).join('/')}`)
      .filter((path) => statSync(join(packageRoot, path)).isFile());

    expect(onDisk.filter((path) => !inGit.has(path))).toEqual([]);
  });

  it('keeps the vendored-plugin fixture actually vendored', () => {
    const nested = join(
      packageRoot,
      'fixtures/core/AP-7.1-DEPTH__deep-nesting/plugin/skills/vendor/node_modules/other-plugin/skills/omega/SKILL.md',
    );
    expect(existsSync(nested), 'the deep-nesting fixture lost its nested SKILL.md').toBe(true);
  });
});

describe('checklist.json', () => {
  it('maps every official checklist item onto at least one rule', async () => {
    const checklist = JSON.parse(await readFile(join(packageRoot, 'checklist.json'), 'utf8')) as {
      sections: Array<{ heading: string; items: Array<{ text: string; rules: string[]; coverage?: string; why?: string }> }>;
    };
    const problems: string[] = [];

    for (const section of checklist.sections) {
      for (const item of section.items) {
        if (item.rules.length === 0) problems.push(`${section.heading}: "${item.text}" has no rule`);
        for (const id of item.rules) {
          if (!rules.has(id)) problems.push(`${section.heading}: "${item.text}" names unknown rule ${id}`);
        }
        if (item.coverage !== undefined) {
          if (item.coverage !== 'partial') problems.push(`"${item.text}" has an unknown coverage value`);
          if (!item.why?.trim()) problems.push(`"${item.text}" is partial with no explanation`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
