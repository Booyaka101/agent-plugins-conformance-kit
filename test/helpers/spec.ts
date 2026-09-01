import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../../src/rules.js';

const SPEC_URL = 'https://raw.githubusercontent.com/agentplugins/agent-plugins-spec/main/spec/1.0.0.md';
const CACHE_DIR = join(packageRoot, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'spec-1.0.0.md');

/**
 * The published specification text, cached under .cache/ so a suite run costs one fetch.
 * Delete the cache (or run `npm run verify:sources`) to re-check against upstream.
 */
export async function fetchSpec(): Promise<string> {
  if (existsSync(CACHE_FILE)) return readFile(CACHE_FILE, 'utf8');

  let response: Response;
  try {
    response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(
      `could not fetch ${SPEC_URL} (${err instanceof Error ? err.message : String(err)}). ` +
        'This test verifies rules.json against the published specification and needs network access.',
    );
  }
  if (!response.ok) throw new Error(`${SPEC_URL} returned HTTP ${response.status}`);

  const text = await response.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, text);
  return text;
}

/** Section numbers the specification actually defines, from its own headings. */
export function specSections(spec: string): Set<string> {
  const sections = new Set<string>();
  for (const match of spec.matchAll(/^#{2,5} (\d+(?:\.\d+)*)[.\s]/gm)) {
    const number = match[1];
    if (number !== undefined) sections.add(number);
  }
  return sections;
}
