/** The load report contract. One adapter invocation produces exactly one of these. */
export interface LoadReport {
  /** `null` when the plugin loaded, otherwise a short client-defined reason. */
  rejected: string | null;
  loaded: { skills: string[]; mcpServers: string[] };
  skipped: SkippedEntry[];
  reported: ReportedEntry[];
}

export interface SkippedEntry {
  /** `skills/<dir>`, `mcp.json#<name>`, `skills`, or `mcp.json`. */
  what: string;
  ruleId?: string;
}

export interface ReportedEntry {
  /** The manifest field name, e.g. `skills` or `extensions`. */
  field: string;
  ruleId?: string;
}

export type ParseResult =
  | { ok: true; report: LoadReport }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function stringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push(`${path}[${i}] must be a string`);
      continue;
    }
    out.push(item);
  }
  return out;
}

function entryList<K extends string>(
  value: unknown,
  path: string,
  key: K,
  errors: string[],
): Array<{ [P in K]: string } & { ruleId?: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const out: Array<{ [P in K]: string } & { ruleId?: string }> = [];
  for (const [i, item] of value.entries()) {
    if (!isObject(item)) {
      errors.push(`${path}[${i}] must be an object`);
      continue;
    }
    const name = item[key];
    if (typeof name !== 'string') {
      errors.push(`${path}[${i}].${key} must be a string`);
      continue;
    }
    const ruleId = item['ruleId'];
    if (ruleId !== undefined && typeof ruleId !== 'string') {
      errors.push(`${path}[${i}].ruleId must be a string when present`);
      continue;
    }
    const entry = { [key]: name } as { [P in K]: string } & { ruleId?: string };
    if (typeof ruleId === 'string') entry.ruleId = ruleId;
    out.push(entry);
  }
  return out;
}

/**
 * Parses adapter stdout. Tolerates a UTF-8 BOM and leading log noise before the
 * JSON object, because plenty of runtimes print a banner nobody asked for.
 */
export function parseLoadReport(stdout: string): ParseResult {
  const text = stdout.replace(/^﻿/, '').trim();
  if (text.length === 0) return { ok: false, error: 'adapter printed nothing on stdout' };

  const start = text.indexOf('{');
  if (start === -1) {
    return { ok: false, error: `adapter stdout is not JSON: ${preview(text)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `adapter stdout is not valid JSON (${reason}): ${preview(text)}` };
  }

  return validateLoadReport(parsed);
}

export function validateLoadReport(parsed: unknown): ParseResult {
  if (!isObject(parsed)) return { ok: false, error: 'load report must be a JSON object' };

  const errors: string[] = [];

  const rejectedRaw = parsed['rejected'];
  let rejected: string | null = null;
  if (rejectedRaw === undefined) {
    errors.push('missing required key "rejected" (use null when the plugin loaded)');
  } else if (rejectedRaw === null || typeof rejectedRaw === 'string') {
    rejected = rejectedRaw;
  } else {
    errors.push('"rejected" must be a string or null');
  }

  const loadedRaw = parsed['loaded'];
  let skills: string[] = [];
  let mcpServers: string[] = [];
  if (!isObject(loadedRaw)) {
    errors.push('missing required object "loaded" with "skills" and "mcpServers" arrays');
  } else {
    skills = stringArray(loadedRaw['skills'], 'loaded.skills', errors);
    mcpServers = stringArray(loadedRaw['mcpServers'], 'loaded.mcpServers', errors);
  }

  const skipped = entryList(parsed['skipped'], 'skipped', 'what', errors);
  const reported = entryList(parsed['reported'], 'reported', 'field', errors);

  for (const key of Object.keys(parsed)) {
    if (!['rejected', 'loaded', 'skipped', 'reported'].includes(key)) {
      errors.push(`unknown key "${key}" in load report`);
    }
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, report: { rejected, loaded: { skills, mcpServers }, skipped, reported } };
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}...` : oneLine;
}
