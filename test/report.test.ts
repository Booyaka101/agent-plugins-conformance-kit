import { describe, expect, it } from 'vitest';
import { parseLoadReport, validateLoadReport } from '../src/report.js';

const valid = {
  rejected: null,
  loaded: { skills: ['alpha'], mcpServers: [] },
  skipped: [],
  reported: [],
};

describe('parseLoadReport', () => {
  it('parses a well-formed report', () => {
    const result = parseLoadReport(JSON.stringify(valid));
    expect(result).toEqual({ ok: true, report: valid });
  });

  it('tolerates a BOM and surrounding whitespace', () => {
    const result = parseLoadReport(`﻿\n  ${JSON.stringify(valid)}  \n`);
    expect(result.ok).toBe(true);
  });

  it('tolerates a banner printed before the JSON', () => {
    const result = parseLoadReport(`loading plugin...\n${JSON.stringify(valid)}`);
    expect(result.ok).toBe(true);
  });

  it('names the problem when stdout is empty', () => {
    expect(parseLoadReport('   ')).toEqual({ ok: false, error: 'adapter printed nothing on stdout' });
  });

  it('names the problem when stdout is not JSON', () => {
    const result = parseLoadReport('everything is fine');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('not JSON');
  });

  it('names the problem when the JSON is truncated', () => {
    const result = parseLoadReport('{ "rejected": null, "loaded": ');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('not valid JSON');
  });

  it('truncates a very long preview', () => {
    const result = parseLoadReport('x'.repeat(5000));
    expect(result.ok === false && result.error.length).toBeLessThan(300);
  });
});

describe('validateLoadReport', () => {
  it.each([
    [{}, 'missing required key "rejected"'],
    [{ rejected: null }, 'missing required object "loaded"'],
    [{ rejected: 7, loaded: { skills: [], mcpServers: [] } }, '"rejected" must be a string or null'],
    [
      { rejected: null, loaded: { skills: 'alpha', mcpServers: [] } },
      'loaded.skills must be an array of strings',
    ],
    [
      { rejected: null, loaded: { skills: [1], mcpServers: [] } },
      'loaded.skills[0] must be a string',
    ],
    [
      { ...valid, skipped: [{ ruleId: 'X' }] },
      'skipped[0].what must be a string',
    ],
    [
      { ...valid, reported: [{ field: 'x', ruleId: 9 }] },
      'reported[0].ruleId must be a string when present',
    ],
    [{ ...valid, extra: true }, 'unknown key "extra"'],
  ])('rejects %j', (input, message) => {
    const result = validateLoadReport(input);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain(message);
  });

  it('rejects a JSON array', () => {
    expect(validateLoadReport([])).toEqual({ ok: false, error: 'load report must be a JSON object' });
  });

  it('defaults skipped and reported to empty when omitted', () => {
    const result = validateLoadReport({ rejected: null, loaded: { skills: [], mcpServers: [] } });
    expect(result).toEqual({
      ok: true,
      report: { rejected: null, loaded: { skills: [], mcpServers: [] }, skipped: [], reported: [] },
    });
  });

  it('collects every problem rather than stopping at the first', () => {
    const result = validateLoadReport({ rejected: 7, loaded: { skills: 1, mcpServers: 2 } });
    expect(result.ok === false && result.error.split('; ')).toHaveLength(3);
  });
});
