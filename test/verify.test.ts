import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/runner.js';
import { loadRules } from '../src/rules.js';
import { skillName, verifyCorpus } from '../src/verify.js';

const PS = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const table = loadRules();

/**
 * verifyCorpus also asserts that every rule has a fixture, which is a property of the real
 * corpus. A synthetic corpus of one fixture gets a table of the one rule it names.
 */
const RULE_ID = 'AP-7.1-IMMEDIATE-CHILD';
const oneRule = { ...table, rules: table.rules.filter((rule) => rule.id === RULE_ID) };

const skillFile = (name: string) =>
  `---\nname: ${name}\ndescription: A fixture skill for the corpus self-check tests.\n---\n\nBody.\n`;

describe('skillName', () => {
  it('reads the frontmatter name', () => {
    expect(skillName(skillFile('alpha'))).toBe('alpha');
  });

  it.each([
    ['no frontmatter', '# alpha\n\nJust a heading.\n'],
    ['unterminated frontmatter', '---\nname: alpha\n'],
    ['a sequence rather than a mapping', '---\n- alpha\n---\n\nBody.\n'],
    ['a non-string name', '---\nname:\n  first: alpha\ndescription: x\n---\n\nBody.\n'],
  ])('returns null for %s', (_label, source) => {
    expect(skillName(source)).toBeNull();
  });

  it('tolerates a BOM and CRLF', () => {
    expect(skillName(`﻿---\r\nname: alpha\r\ndescription: x\r\n---\r\n\r\nBody.\r\n`)).toBe('alpha');
  });
});

describe('verifyCorpus against a synthetic corpus', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'apconform-verify-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Writes one fixture and returns the loaded corpus for it. */
  async function corpus(name: string, fixture: unknown, files: Record<string, string>) {
    const dir = join(root, 'core', name);
    for (const [rel, content] of Object.entries(files)) {
      const target = join(dir, 'plugin', rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2));
    return loadCorpus({ root, groups: ['core'] });
  }

  const base = (over: Record<string, unknown> = {}) => {
    const rule = oneRule.rules[0];
    return {
      ruleId: rule?.id,
      confidence: rule?.confidence,
      spec: rule?.section,
      quote: rule?.quote,
      title: 'a fixture',
      rationale: 'because',
      observability: 'report',
      expect: { rejected: null, loaded: { skills: ['alpha'], mcpServers: [] }, skipped: [], reported: [] },
      ...over,
    };
  };

  it('accepts a well-formed fixture', async () => {
    const fixtures = await corpus('AP-7.1-IMMEDIATE-CHILD', base(), {
      'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
      'skills/alpha/SKILL.md': skillFile('alpha'),
    });
    expect(await verifyCorpus(fixtures, oneRule)).toEqual([]);
  });

  it('reports an expected skill whose SKILL.md is missing', async () => {
    const fixtures = await corpus('AP-7.1-IMMEDIATE-CHILD', base(), {
      'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
    });
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining('expects skill "alpha" but'),
    ]);
  });

  it('reports a SKILL.md whose frontmatter name disagrees with the directory', async () => {
    const fixtures = await corpus('AP-7.1-IMMEDIATE-CHILD', base(), {
      'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
      'skills/alpha/SKILL.md': skillFile('not-alpha'),
    });
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems[0]?.message).toContain('declares name "not-alpha"');
  });

  // The case-sensitivity fixture ships skills/beta/skill.md, which is the same file as
  // SKILL.md on Windows and macOS and a different one on Linux. Requiring the file to
  // exist made the whole corpus self-check fail on Linux only.
  it('does not require a file for an optional skill', async () => {
    const fixtures = await corpus(
      'AP-7.1-IMMEDIATE-CHILD',
      base({ optional: { skills: ['beta'] } }),
      {
        'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
        'skills/alpha/SKILL.md': skillFile('alpha'),
        'skills/beta/skill.md': skillFile('beta'),
      },
    );
    expect(await verifyCorpus(fixtures, oneRule)).toEqual([]);
  });

  it('still checks an optional skill that does have a SKILL.md', async () => {
    const fixtures = await corpus(
      'AP-7.1-IMMEDIATE-CHILD',
      base({ optional: { skills: ['beta'] } }),
      {
        'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
        'skills/alpha/SKILL.md': skillFile('alpha'),
        'skills/beta/SKILL.md': skillFile('wrong-name'),
      },
    );
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems[0]?.message).toContain('declares name "wrong-name"');
  });

  it('reports an expected MCP server that mcp.json does not declare', async () => {
    const fixtures = await corpus(
      'AP-7.1-IMMEDIATE-CHILD',
      base({ expect: { rejected: null, loaded: { skills: [], mcpServers: ['api'] }, skipped: [], reported: [] } }),
      {
        'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
        'mcp.json': JSON.stringify({ mcpServers: { other: {} } }),
      },
    );
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems[0]?.message).toContain('expects MCP server "api"');
  });

  it('reports a skipped entry that names nothing on disk', async () => {
    const fixtures = await corpus(
      'AP-7.1-IMMEDIATE-CHILD',
      base({
        expect: {
          rejected: null,
          loaded: { skills: ['alpha'], mcpServers: [] },
          skipped: [{ what: 'skills/ghost' }],
          reported: [],
        },
      }),
      {
        'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
        'skills/alpha/SKILL.md': skillFile('alpha'),
      },
    );
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems[0]?.message).toContain('expects to skip "skills/ghost"');
  });

  it('reports a skipped entry in an unknown shape', async () => {
    const fixtures = await corpus(
      'AP-7.1-IMMEDIATE-CHILD',
      base({
        expect: {
          rejected: null,
          loaded: { skills: ['alpha'], mcpServers: [] },
          skipped: [{ what: 'agents/reviewer' }],
          reported: [],
        },
      }),
      {
        'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
        'skills/alpha/SKILL.md': skillFile('alpha'),
      },
    );
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems[0]?.message).toContain('is not one of skills, mcp.json');
  });

  it('reports a partial fixture with no explanation', async () => {
    const fixtures = await corpus(
      'AP-7.1-IMMEDIATE-CHILD',
      base({ observability: 'partial' }),
      {
        'plugin.json': JSON.stringify({ $schema: PS, name: 'demo' }),
        'skills/alpha/SKILL.md': skillFile('alpha'),
      },
    );
    const problems = await verifyCorpus(fixtures, oneRule);
    expect(problems.map((p) => p.message)).toContain(
      'observability is "partial" but no observabilityNote explains what is not asserted',
    );
  });
});
