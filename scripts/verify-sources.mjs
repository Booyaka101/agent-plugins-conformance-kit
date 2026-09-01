#!/usr/bin/env node
// Checks the kit still agrees with its sources. Run it in CI and before a release.
//
//   npm run verify:sources
//
// Fails if a rules.json quote has drifted from the published specification, if a
// checklist item this kit claims to cover has changed wording, or if either JSON schema
// no longer has the shape the fixtures assert against.

import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const rules = read('rules.json');
const checklist = read('checklist.json');

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

async function get(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': 'agent-plugins-conformance-kit/verify-sources' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Visible text of an HTML page, whitespace-collapsed. */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Markup decides spacing on a rendered page: `hyphens (<code>--</code>)` reads as
// "hyphens ( -- )" once tags become separators. Comparing without whitespace still
// catches any wording change while ignoring where the author put a <code> span.
const squash = (text) => text.replace(/\s+/g, '');

// --- the specification ------------------------------------------------------
try {
  const spec = await get(rules.specSource);
  let drifted = 0;
  const sections = new Set(
    [...spec.matchAll(/^#{2,5} (\d+(?:\.\d+)*)[.\s]/gm)].map((match) => match[1]),
  );
  for (const rule of rules.rules) {
    if (!spec.includes(rule.quote)) {
      fail(`${rule.id}: quote is no longer a verbatim substring of the specification`);
      drifted++;
    }
    if (!sections.has(rule.section)) {
      fail(`${rule.id}: section ${rule.section} no longer appears in the specification`);
    }
  }
  notes.push(`specification: ${rules.rules.length - drifted}/${rules.rules.length} quotes verbatim`);
} catch (err) {
  fail(`could not read ${rules.specSource}: ${err.message}`);
}

// --- Agent Skills -----------------------------------------------------------
const skillRules = rules.rules.filter((rule) => rule.agentSkills);
try {
  const text = squash(textOf(await get(rules.agentSkillsSource)));
  let drifted = 0;
  for (const rule of skillRules) {
    if (!text.includes(squash(rule.agentSkills.quote))) {
      fail(`${rule.id}: Agent Skills constraint "${rule.agentSkills.quote}" is not on the page any more`);
      drifted++;
    }
  }
  notes.push(`agent skills: ${skillRules.length - drifted}/${skillRules.length} constraints present`);
} catch (err) {
  fail(`could not read ${rules.agentSkillsSource}: ${err.message}`);
}

// --- the non-normative client checklist -------------------------------------
const items = checklist.sections.flatMap((section) => section.items);
try {
  const text = squash(textOf(await get(checklist.source)));
  let drifted = 0;
  for (const item of items) {
    if (!text.includes(squash(item.text))) {
      fail(`checklist item "${item.text}" is not on the published checklist any more`);
      drifted++;
    }
  }
  notes.push(`checklist: ${items.length - drifted}/${items.length} items present`);
} catch (err) {
  fail(`could not read ${checklist.source}: ${err.message}`);
}

// --- the two JSON schemas ---------------------------------------------------
const SCHEMAS = [
  {
    url: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    check(schema) {
      if (schema.additionalProperties !== false) return 'additionalProperties is no longer false';
      if (JSON.stringify(schema.required) !== JSON.stringify(['$schema', 'name'])) {
        return `required is ${JSON.stringify(schema.required)}, expected ["$schema","name"]`;
      }
      return null;
    },
  },
  {
    url: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    check(schema) {
      if (JSON.stringify(schema.required) !== JSON.stringify(['$schema', 'mcpServers'])) {
        return `required is ${JSON.stringify(schema.required)}, expected ["$schema","mcpServers"]`;
      }
      const variants = Object.keys(schema.$defs ?? {});
      for (const name of ['stdioServer', 'streamableHttpServer', 'sseServer']) {
        if (!variants.includes(name)) return `$defs no longer defines ${name}`;
      }
      return null;
    },
  },
];

for (const { url, check } of SCHEMAS) {
  try {
    const schema = JSON.parse(await get(url));
    const problem = check(schema);
    if (problem) fail(`${url}: ${problem}`);
    else notes.push(`schema: ${url.split('/').pop()} unchanged in the ways fixtures rely on`);
  } catch (err) {
    fail(`could not read ${url}: ${err.message}`);
  }
}

// --- report -----------------------------------------------------------------
for (const note of notes) process.stdout.write(`ok   ${note}\n`);
for (const problem of problems) process.stdout.write(`FAIL ${problem}\n`);

if (problems.length > 0) {
  process.stdout.write(`\n${problems.length} source problem${problems.length === 1 ? '' : 's'}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nall sources agree\n`);
}
