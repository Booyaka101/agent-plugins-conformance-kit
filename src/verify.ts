import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import YAML from 'yaml';
import { validateLoadReport } from './report.js';
import { normalizeWhat, type Fixture } from './diff.js';
import { loadRules, ruleIndex, type RuleTable } from './rules.js';
import { isDirectory } from './runner.js';

export interface Problem {
  where: string;
  message: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Frontmatter `name`, or null when there is no parseable mapping with a string name. */
export function skillName(source: string): string | null {
  const match = source.replace(/^﻿/, '').match(FRONTMATTER);
  if (!match?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1], { schema: 'failsafe' });
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const name = (parsed as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name.trim() : null;
}

/**
 * Checks the corpus describes itself honestly: every fixture names a real rule, sits in
 * the folder its confidence implies, and expects component names that exist on disk.
 */
export async function verifyCorpus(
  fixtures: Fixture[],
  table: RuleTable = loadRules(),
): Promise<Problem[]> {
  const rules = ruleIndex(table);
  const problems: Problem[] = [];
  const add = (where: string, message: string) => problems.push({ where, message });

  for (const fixture of fixtures) {
    const rule = rules.get(fixture.ruleId);
    if (!rule) {
      add(fixture.id, `names unknown rule ${fixture.ruleId}`);
      continue;
    }
    if (fixture.confidence !== rule.confidence) {
      add(fixture.id, `confidence "${fixture.confidence}" does not match rule ${rule.id} ("${rule.confidence}")`);
    }
    if (fixture.spec !== rule.section) {
      add(fixture.id, `spec "${fixture.spec}" does not match rule ${rule.id} (section ${rule.section})`);
    }
    if (fixture.quote !== rule.quote) {
      add(fixture.id, `quote does not match rule ${rule.id}`);
    }
    if (fixture.group === 'core' || fixture.group === 'disputed') {
      if (fixture.confidence !== fixture.group) {
        add(fixture.id, `sits in fixtures/${fixture.group}/ but declares confidence "${fixture.confidence}"`);
      }
      const dirName = basename(fixture.dir);
      const [expectedRule] = dirName.split('__');
      if (expectedRule !== fixture.ruleId) {
        add(fixture.id, `directory name should start with the rule id ${fixture.ruleId}`);
      }
    }
    if (!fixture.title?.trim()) add(fixture.id, 'title is empty');
    if (!fixture.rationale?.trim()) add(fixture.id, 'rationale is empty');
    if (fixture.observability !== 'report' && fixture.observability !== 'partial') {
      add(fixture.id, `observability must be "report" or "partial"`);
    }
    if (fixture.observability === 'partial' && !fixture.observabilityNote?.trim()) {
      add(fixture.id, 'observability is "partial" but no observabilityNote explains what is not asserted');
    }

    const shape = validateLoadReport(fixture.expect);
    if (!shape.ok) add(fixture.id, `expect does not satisfy the load report contract: ${shape.error}`);

    await checkAgainstDisk(fixture, add);
  }

  const covered = new Set(fixtures.map((f) => f.ruleId));
  for (const rule of table.rules) {
    if (!covered.has(rule.id)) add('rules.json', `rule ${rule.id} has no fixture`);
  }

  return problems;
}

async function checkAgainstDisk(
  fixture: Fixture,
  add: (where: string, message: string) => void,
): Promise<void> {
  const plugin = join(fixture.dir, 'plugin');
  const linked = new Set((fixture.links ?? []).map((link) => normalizeWhat(link.path)));

  for (const name of [...fixture.expect.loaded.skills, ...(fixture.optional?.skills ?? [])]) {
    if (linked.has(`skills/${name}`)) continue;
    const path = join(plugin, 'skills', name, 'SKILL.md');
    if (!existsSync(path)) {
      add(fixture.id, `expects skill "${name}" but ${join('skills', name, 'SKILL.md')} does not exist`);
      continue;
    }
    const declared = skillName(await readFile(path, 'utf8'));
    if (declared !== name) {
      add(fixture.id, `expects skill "${name}" but its SKILL.md declares name ${JSON.stringify(declared)}`);
    }
  }

  const declaredServers = await mcpServerNames(join(plugin, 'mcp.json'));
  const wantedServers = [...fixture.expect.loaded.mcpServers, ...(fixture.optional?.mcpServers ?? [])];
  if (declaredServers !== null) {
    for (const name of wantedServers) {
      if (!declaredServers.has(name)) {
        add(fixture.id, `expects MCP server "${name}" but mcp.json does not declare it`);
      }
    }
  } else if (wantedServers.length > 0 && !linked.has('mcp.json')) {
    add(fixture.id, `expects MCP servers ${wantedServers.join(', ')} but mcp.json is absent or unparseable`);
  }

  for (const entry of fixture.expect.skipped) {
    const what = normalizeWhat(entry.what);
    if (linked.has(what) || what === 'skills' || what === 'mcp.json') continue;
    if (what.startsWith('skills/')) {
      const dir = join(plugin, what);
      if (!(await isDirectory(dir))) {
        add(fixture.id, `expects to skip "${what}" but that directory does not exist`);
      }
      continue;
    }
    if (what.startsWith('mcp.json#')) {
      const name = what.slice('mcp.json#'.length);
      if (declaredServers !== null && !declaredServers.has(name)) {
        add(fixture.id, `expects to skip MCP server "${name}" but mcp.json does not declare it`);
      }
      continue;
    }
    add(fixture.id, `skipped entry "${entry.what}" is not one of skills, mcp.json, skills/<dir>, mcp.json#<name>`);
  }
}

/** Server names from a fixture's mcp.json, or null when there is nothing parseable to read. */
async function mcpServerNames(path: string): Promise<Set<string> | null> {
  if (!existsSync(path) || (await isDirectory(path))) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const servers = (parsed as Record<string, unknown>)['mcpServers'];
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    return new Set(Object.keys(servers));
  } catch {
    return null;
  }
}
