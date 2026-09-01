import { describe, expect, it } from 'vitest';
import { toJUnitXml } from '../src/junit.js';
import { summarize } from '../src/diff.js';
import type { Verdict, VerdictStatus } from '../src/diff.js';

const verdict = (over: Partial<Verdict> & { status: VerdictStatus }): Verdict => ({
  fixture: 'core/AP-7.1-DEPTH',
  ruleId: 'AP-7.1-DEPTH',
  section: '7.1',
  confidence: 'core',
  group: 'core',
  observability: 'report',
  failures: [],
  warnings: [],
  notes: [],
  durationMs: 250,
  ...over,
});

const xmlFor = (verdicts: Verdict[]) => toJUnitXml(verdicts, summarize(verdicts), '1.0.0');

describe('toJUnitXml', () => {
  it('counts each status in the right attribute', () => {
    const xml = xmlFor([
      verdict({ status: 'pass' }),
      verdict({ fixture: 'core/b', status: 'fail', failures: ['expected x'] }),
      verdict({ fixture: 'core/c', status: 'error', error: 'adapter died' }),
      verdict({ fixture: 'core/d', status: 'skipped', error: 'needs a symlink' }),
    ]);
    expect(xml).toContain('tests="4" failures="1" errors="1" skipped="1"');
    expect(xml).toContain('<failure ');
    expect(xml).toContain('<error ');
    expect(xml).toContain('<skipped ');
  });

  it('groups fixtures into a suite per corpus group', () => {
    const xml = xmlFor([
      verdict({ status: 'pass' }),
      verdict({ fixture: 'regressions/codex-39895', group: 'regressions', status: 'pass' }),
    ]);
    expect(xml).toContain('name="agent-plugins.core"');
    expect(xml).toContain('name="agent-plugins.regressions"');
    // A group with nothing in it must not produce an empty suite.
    expect(xml).not.toContain('agent-plugins.disputed');
  });

  it('escapes the five XML entities in both text and attributes', () => {
    const xml = xmlFor([
      verdict({ status: 'fail', failures: ['expected <a> & "b" and \'c\''] }),
    ]);
    expect(xml).toContain('message="expected &lt;a&gt; &amp; &quot;b&quot; and &apos;c&apos;"');
    expect(xml).not.toMatch(/>expected <a>/);
  });

  it('strips control characters, which are illegal in XML 1.0', () => {
    const nasty = "bad\u0000byte\u0007bell\u001funit";
    const xml = xmlFor([verdict({ status: 'error', error: nasty })]);
    expect(xml).toContain('badbytebellunit');
    expect([...xml].filter((c) => c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c))).toEqual([]);
  });

  it('puts warnings and notes in system-out so they cannot fail a build', () => {
    const xml = xmlFor([
      verdict({ status: 'pass', warnings: ['expected skipped to contain [x]'], notes: ['omits the optional "y"'] }),
    ]);
    expect(xml).toContain('<system-out>');
    expect(xml).toContain('omits the optional &quot;y&quot;');
    expect(xml).toContain('failures="0"');
  });

  it('reports time in seconds', () => {
    expect(xmlFor([verdict({ status: 'pass', durationMs: 1500 })])).toContain('time="1.5"');
  });

  it('is well-formed enough to parse', () => {
    const xml = xmlFor([
      verdict({ status: 'fail', failures: ['a < b'] }),
      verdict({ fixture: 'disputed/x', group: 'disputed', status: 'pass', notes: ['n & m'] }),
    ]);
    // Node has no XML parser, so check the shape a parser depends on.
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(xml.trimEnd().endsWith('</testsuites>')).toBe(true);
    const opens = (xml.match(/<testcase /g) ?? []).length;
    const closes = (xml.match(/<\/testcase>/g) ?? []).length + (xml.match(/><\/testcase>/g) ?? []).length;
    expect(opens).toBe(2);
    expect(closes).toBeGreaterThanOrEqual(opens);
  });
});
