import { describe, expect, it } from 'vitest';
import { diffReport, formatVerdictLines, normalizeWhat, summarize } from '../src/diff.js';
import type { Fixture, Verdict } from '../src/diff.js';
import type { LoadReport } from '../src/report.js';

const fixture = (overrides: Partial<Fixture> = {}): Fixture => ({
  id: 'core/AP-5.2-UNKNOWN-FIELD',
  group: 'core',
  dir: '/corpus/core/AP-5.2-UNKNOWN-FIELD',
  ruleId: 'AP-5.2-UNKNOWN-FIELD',
  confidence: 'core',
  spec: '5.2',
  title: 'unknown field',
  rationale: 'because',
  quote: 'Clients MUST report and ignore each unknown field',
  observability: 'report',
  expect: {
    rejected: null,
    loaded: { skills: [], mcpServers: [] },
    skipped: [],
    reported: [{ field: 'skills', ruleId: 'AP-5.2-UNKNOWN-FIELD' }],
  },
  ...overrides,
});

const report = (overrides: Partial<LoadReport> = {}): LoadReport => ({
  rejected: null,
  loaded: { skills: [], mcpServers: [] },
  skipped: [],
  reported: [],
  ...overrides,
});

describe('rejected', () => {
  it('passes when both agree the plugin loaded', () => {
    const verdict = diffReport(fixture(), report({ reported: [{ field: 'skills' }] }));
    expect(verdict.status).toBe('pass');
    expect(verdict.failures).toEqual([]);
  });

  it('fails, in the message the brief specifies, when a loadable plugin is rejected', () => {
    const verdict = diffReport(fixture(), report({ rejected: 'schema' }));
    expect(verdict.status).toBe('fail');
    expect(formatVerdictLines(verdict)[0]).toBe(
      'FAIL AP-5.2-UNKNOWN-FIELD (spec 5.2) expected rejected=null, got rejected="schema"',
    );
  });

  it('fails when a plugin that must be rejected loads', () => {
    const f = fixture({
      expect: { rejected: 'required-field-missing', loaded: { skills: [], mcpServers: [] }, skipped: [], reported: [] },
    });
    const verdict = diffReport(f, report());
    expect(verdict.failures).toEqual(['expected rejected=<non-null>, got rejected=null']);
  });

  it('does not compare rejection strings, only rejectedness', () => {
    const f = fixture({
      expect: { rejected: 'required-field-missing', loaded: { skills: [], mcpServers: [] }, skipped: [], reported: [] },
    });
    expect(diffReport(f, report({ rejected: 'E_MANIFEST_42' })).status).toBe('pass');
  });

  it('fails a rejected plugin that still loaded components', () => {
    const f = fixture({
      expect: { rejected: 'invalid-json', loaded: { skills: [], mcpServers: [] }, skipped: [], reported: [] },
    });
    const verdict = diffReport(f, report({ rejected: 'invalid-json', loaded: { skills: ['alpha'], mcpServers: [] } }));
    expect(verdict.failures[0]).toContain('expected a rejected plugin to load nothing');
  });
});

describe('loaded names', () => {
  const withSkills = (skills: string[], extra: Partial<Fixture> = {}) =>
    fixture({
      expect: { rejected: null, loaded: { skills, mcpServers: [] }, skipped: [], reported: [] },
      ...extra,
    });

  it('is order insensitive', () => {
    const verdict = diffReport(withSkills(['alpha', 'beta']), report({ loaded: { skills: ['beta', 'alpha'], mcpServers: [] } }));
    expect(verdict.status).toBe('pass');
  });

  it('fails on a missing skill', () => {
    const verdict = diffReport(withSkills(['alpha', 'beta']), report({ loaded: { skills: ['alpha'], mcpServers: [] } }));
    expect(verdict.failures).toEqual(['expected loaded.skills to contain [beta], got [alpha]']);
  });

  it('fails on a skill that should not have been discovered', () => {
    const verdict = diffReport(withSkills(['alpha']), report({ loaded: { skills: ['alpha', 'beta'], mcpServers: [] } }));
    expect(verdict.failures).toEqual(['expected loaded.skills not to contain [beta], got [alpha, beta]']);
  });

  it('reports both directions at once', () => {
    const verdict = diffReport(withSkills(['alpha']), report({ loaded: { skills: ['gamma'], mcpServers: [] } }));
    expect(verdict.failures).toHaveLength(2);
  });

  it('separates the two channels', () => {
    const f = fixture({
      expect: { rejected: null, loaded: { skills: ['alpha'], mcpServers: ['api'] }, skipped: [], reported: [] },
    });
    const verdict = diffReport(f, report({ loaded: { skills: ['api'], mcpServers: ['alpha'] } }));
    expect(verdict.failures).toHaveLength(4);
  });
});

describe('optional components', () => {
  const f = fixture({
    expect: { rejected: null, loaded: { skills: ['alpha'], mcpServers: [] }, skipped: [], reported: [] },
    optional: { skills: ['beta'] },
  });

  it('passes whether the optional skill loads', () => {
    expect(diffReport(f, report({ loaded: { skills: ['alpha'], mcpServers: [] } })).status).toBe('pass');
    expect(diffReport(f, report({ loaded: { skills: ['alpha', 'beta'], mcpServers: [] } })).status).toBe('pass');
  });

  it('records which way the client went', () => {
    expect(diffReport(f, report({ loaded: { skills: ['alpha', 'beta'], mcpServers: [] } })).notes).toEqual([
      'loaded.skills includes the optional "beta"',
    ]);
    expect(diffReport(f, report({ loaded: { skills: ['alpha'], mcpServers: [] } })).notes).toEqual([
      'loaded.skills omits the optional "beta"',
    ]);
  });

  it('still requires the non-optional skill', () => {
    expect(diffReport(f, report({ loaded: { skills: ['beta'], mcpServers: [] } })).status).toBe('fail');
  });

  it('tolerates the optional component appearing in skipped', () => {
    const verdict = diffReport(f, report({ loaded: { skills: ['alpha'], mcpServers: [] }, skipped: [{ what: 'skills/beta' }] }));
    expect(verdict.warnings).toEqual([]);
  });
});

describe('atLeastOne', () => {
  const f = fixture({
    expect: { rejected: null, loaded: { skills: ['alpha'], mcpServers: ['api'] }, skipped: [], reported: [] },
    atLeastOne: { skills: ['alpha'], mcpServers: ['api'] },
  });

  it('accepts a skills-only client', () => {
    expect(diffReport(f, report({ loaded: { skills: ['alpha'], mcpServers: [] } })).status).toBe('pass');
  });

  it('accepts an MCP-only client', () => {
    expect(diffReport(f, report({ loaded: { skills: [], mcpServers: ['api'] } })).status).toBe('pass');
  });

  it('fails a client that loads neither', () => {
    const verdict = diffReport(f, report());
    expect(verdict.failures).toEqual([
      'expected at least one of [mcpServers:api, skills:alpha] to load, got none',
    ]);
  });
});

describe('reported fields', () => {
  it('fails when a MUST-report field is missing', () => {
    const verdict = diffReport(fixture(), report());
    expect(verdict.failures).toEqual(['expected reported fields to contain [skills], got []']);
  });

  it('fails on a field the client invented', () => {
    const verdict = diffReport(fixture(), report({ reported: [{ field: 'skills' }, { field: 'name' }] }));
    expect(verdict.failures).toEqual(['expected reported fields not to contain [name], got [name, skills]']);
  });

  it('warns rather than fails on a different rule id', () => {
    const verdict = diffReport(fixture(), report({ reported: [{ field: 'skills', ruleId: 'X-1' }] }));
    expect(verdict.status).toBe('pass');
    expect(verdict.warnings).toEqual([
      'reported "skills" carries ruleId "X-1", expected "AP-5.2-UNKNOWN-FIELD"',
    ]);
  });

  it('accepts an omitted rule id', () => {
    expect(diffReport(fixture(), report({ reported: [{ field: 'skills' }] })).warnings).toEqual([]);
  });
});

describe('skipped components', () => {
  const f = fixture({
    expect: {
      rejected: null,
      loaded: { skills: ['alpha'], mcpServers: [] },
      skipped: [{ what: 'skills/broken', ruleId: 'AS-NAME-DIR-MISMATCH' }],
      reported: [],
    },
  });
  const loadedAlpha = { loaded: { skills: ['alpha'], mcpServers: [] } };

  it('warns rather than fails, because reporting a skip is a SHOULD', () => {
    const verdict = diffReport(f, report(loadedAlpha));
    expect(verdict.status).toBe('pass');
    expect(verdict.warnings).toEqual(['expected skipped to contain [skills/broken], got []']);
  });

  it('fails under --strict-reporting', () => {
    const verdict = diffReport(f, report(loadedAlpha), { strictReporting: true });
    expect(verdict.status).toBe('fail');
    expect(verdict.warnings).toEqual([]);
  });

  it('passes when the client reports the skip', () => {
    const verdict = diffReport(f, report({ ...loadedAlpha, skipped: [{ what: 'skills/broken' }] }));
    expect(verdict.warnings).toEqual([]);
  });

  it('normalizes separators and a leading ./', () => {
    const verdict = diffReport(f, report({ ...loadedAlpha, skipped: [{ what: './skills\\broken/' }] }));
    expect(verdict.warnings).toEqual([]);
  });
});

describe('normalizeWhat', () => {
  it.each([
    ['skills/broken', 'skills/broken'],
    ['./skills/broken', 'skills/broken'],
    ['skills\\broken', 'skills/broken'],
    ['skills/broken/', 'skills/broken'],
    ['mcp.json#api', 'mcp.json#api'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeWhat(input)).toBe(expected);
  });
});

describe('formatVerdictLines', () => {
  it('appends a locator only when the fixture is a variant', () => {
    const plain = diffReport(fixture(), report({ rejected: 'x' }));
    expect(formatVerdictLines(plain)[0]).not.toContain('(core/');

    const variant = diffReport(
      fixture({ id: 'core/AP-5.2-UNKNOWN-FIELD__multiple' }),
      report({ rejected: 'x' }),
    );
    expect(formatVerdictLines(variant)[0]).toContain('(core/AP-5.2-UNKNOWN-FIELD__multiple)');
  });
});

describe('summarize', () => {
  it('counts by status and by group', () => {
    const base = diffReport(fixture(), report({ reported: [{ field: 'skills' }] }));
    const failed = diffReport(fixture(), report({ rejected: 'x' }));
    const errored: Verdict = { ...base, status: 'error', group: 'regressions', error: 'boom' };
    const summary = summarize([base, failed, errored]);

    expect(summary).toMatchObject({ total: 3, pass: 1, fail: 1, error: 1, skipped: 0 });
    expect(summary.byGroup.core).toMatchObject({ total: 2, pass: 1, fail: 1 });
    expect(summary.byGroup.regressions).toMatchObject({ total: 1, error: 1 });
  });
});
