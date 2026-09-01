#!/usr/bin/env node
// A DELIBERATELY NON-CONFORMANT loader, for demonstrating what the suite catches.
//
// This is not a client and must not be used as one. It is written the way an implementer
// reaches for first: validate plugin.json against the published closed schema, reject on
// any validation failure, then walk skills/ recursively. Both of those are wrong, and the
// suite says so:
//
//   npx apconform run --adapter examples/naive-adapter.mjs --quiet
//   ...
//   total          68 pass   64 fail    0 error    1 skipped
//
// The interesting line is the one spec issue #77 is about:
//
//   FAIL AP-5.2-UNKNOWN-FIELD (spec 5.2) expected rejected=null, got rejected="additional-properties"

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: naive-adapter.mjs <plugin-directory>\n');
  process.exit(2);
}

const PERMITTED = [
  '$schema', 'name', 'version', 'description', 'author',
  'homepage', 'repository', 'license', 'keywords', 'extensions',
];
const CANONICAL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

const reject = (reason) => {
  console.log(JSON.stringify({
    rejected: reason,
    loaded: { skills: [], mcpServers: [] },
    skipped: [],
    reported: [],
  }));
  process.exit(0);
};

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
} catch {
  reject('manifest-missing-or-invalid');
}

if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  reject('not-an-object');
}
// Wrong: §5.2 requires an unknown top-level field to be reported and ignored.
for (const key of Object.keys(manifest)) {
  if (!PERMITTED.includes(key)) reject('additional-properties');
}
if (manifest.$schema !== CANONICAL) reject('bad-schema');
// Wrong: periods are legal in an Agent Plugins name, and the length bound is unchecked.
if (typeof manifest.name !== 'string' || !/^[a-z0-9-]+$/.test(manifest.name)) reject('bad-name');
// Wrong: §8.1 requires a non-object extensions to be reported and ignored.
if (manifest.extensions !== undefined && typeof manifest.extensions !== 'object') {
  reject('bad-extensions');
}

// Wrong: §7.1 forbids searching below the immediate children of skills/.
const skills = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    try {
      statSync(join(child, 'SKILL.md'));
      const name = readFileSync(join(child, 'SKILL.md'), 'utf8').match(/^name:\s*(.+)$/m)?.[1]?.trim();
      if (name) skills.push(name);
    } catch {
      // not a skill directory
    }
    walk(child);
  }
}
walk(join(root, 'skills'));

// Wrong: no per-entry validation, so every declared server is reported as loaded.
let mcpServers = [];
try {
  mcpServers = Object.keys(JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')).mcpServers ?? {});
} catch {
  // no mcp.json, or unreadable
}

console.log(JSON.stringify({
  rejected: null,
  loaded: { skills, mcpServers },
  skipped: [],
  reported: [],
}));
