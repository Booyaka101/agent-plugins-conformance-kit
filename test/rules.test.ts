import { describe, expect, it } from 'vitest';
import { loadRules } from '../src/rules.js';
import { fetchSpec, specSections } from './helpers/spec.js';

const table = loadRules();

describe('rules.json', () => {
  it('targets Agent Plugins 1.0.0 from the canonical source', () => {
    expect(table.specVersion).toBe('1.0.0');
    expect(table.specSource).toBe(
      'https://raw.githubusercontent.com/agentplugins/agent-plugins-spec/main/spec/1.0.0.md',
    );
  });

  it('has unique ids', () => {
    const ids = table.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(table.rules.map((rule) => [rule.id, rule] as const))('%s is well formed', (_id, rule) => {
    expect(rule.quote.trim().length).toBeGreaterThan(0);
    expect(rule.section).toMatch(/^\d+(\.\d+)*$/);
    expect(Object.keys(table.severities)).toContain(rule.severity);
    expect(Object.keys(table.confidence)).toContain(rule.confidence);
    if (rule.issue !== undefined) expect(rule.issue).toMatch(/^https:\/\/github\.com\//);
    if (rule.agentSkills !== undefined) {
      expect(rule.agentSkills.quote.trim().length).toBeGreaterThan(0);
      expect(rule.agentSkills.source).toBe('https://agentskills.io/specification');
    }
  });

  it('gives every disputed rule a reason to be disputed', () => {
    for (const rule of table.rules.filter((r) => r.confidence === 'disputed')) {
      expect(rule.note ?? rule.issue, `${rule.id} is disputed with no note or issue`).toBeTruthy();
    }
  });

  it('covers specification sections 4 through 11', () => {
    const covered = new Set(table.rules.map((rule) => rule.section.split('.')[0]));
    for (const top of ['4', '5', '6', '7', '8', '9', '10', '11']) {
      expect(covered, `no rule cites section ${top}`).toContain(top);
    }
  });
});

describe('rules.json against the published specification', () => {
  it('quotes every rule byte-identically and cites a real section', async () => {
    const spec = await fetchSpec();
    const sections = specSections(spec);
    const problems: string[] = [];

    for (const rule of table.rules) {
      if (!spec.includes(rule.quote)) {
        problems.push(`${rule.id}: quote is not a verbatim substring of spec/1.0.0.md`);
      }
      if (!sections.has(rule.section)) {
        problems.push(`${rule.id}: section ${rule.section} does not appear in the specification`);
      }
    }

    expect(problems).toEqual([]);
  });
});
