#!/usr/bin/env node
// Conformance adapter for @kuralle-agents/plugins.
//
//   npm install @kuralle-agents/plugins
//   npx apconform run --adapter adapters/kuralle.mjs
//
// Maps loadAgentPlugin's { ok, plugin } / { ok, rejection } result onto the load report
// contract in ADAPTERS.md. See that file for the twenty-line version.

import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const pluginDir = process.argv[2];
if (!pluginDir) {
  process.stderr.write('usage: kuralle.mjs <plugin-directory>\n');
  process.exit(2);
}

let loadAgentPlugin;
let nodeFileSystem;
try {
  ({ loadAgentPlugin } = await import('@kuralle-agents/plugins'));
  ({ nodeFileSystem } = await import('@kuralle-agents/fs/node'));
} catch (err) {
  process.stderr.write(
    `this adapter needs @kuralle-agents/plugins and @kuralle-agents/fs installed.\n` +
      `  npm install @kuralle-agents/plugins\n${err?.message ?? err}\n`,
  );
  process.exit(2);
}

// The loader takes a virtual path inside a FileSystem, and NodeFileSystem confines every
// operation to its own root. Rooting it at the plugin's parent leaves an escaping link
// resolvable but outside the plugin root, which is what §4.1 is about.
const fs = nodeFileSystem(dirname(pluginDir));
const root = `/${basename(pluginDir)}`;

/** §5.2 and §8.1 are the two report-and-ignore rules, and both name a manifest field. */
const REPORTED = [
  { section: '5.2', rule: 'unknown-top-level-field', ruleId: 'AP-5.2-UNKNOWN-FIELD', field: fieldFromMessage },
  { section: '8.1', rule: 'extensions-not-an-object', ruleId: 'AP-8.1-EXTENSIONS-NOT-OBJECT', field: () => 'extensions' },
];

function fieldFromMessage(message) {
  return message.match(/"([^"]+)"/)?.[1] ?? null;
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const result = await loadAgentPlugin(fs, root);

  if (!result.ok) {
    report({
      rejected: `${result.rejection.section}/${result.rejection.rule}`,
      loaded: { skills: [], mcpServers: [] },
      skipped: [],
      reported: [],
    });
    process.exit(0);
  }

  const { plugin } = result;
  const skills = (await plugin.skills.list()).map((skill) => skill.name);
  const mcpServers = plugin.mcpServers.map((server) => server.name);

  const skipped = [];
  const reported = [];

  for (const diagnostic of plugin.diagnostics) {
    const rule = REPORTED.find((r) => r.section === diagnostic.section && r.rule === diagnostic.rule);
    if (rule) {
      const field = rule.field(diagnostic.message);
      if (field !== null) reported.push({ field, ruleId: rule.ruleId });
      continue;
    }
    // §7.1: origin is the plugin-relative SKILL.md path, and the skill is its directory.
    if (diagnostic.section === '7.1' && diagnostic.origin.endsWith('/SKILL.md')) {
      skipped.push({ what: diagnostic.origin.slice(0, -'/SKILL.md'.length) });
      continue;
    }
    // §6.2: the whole component location was rejected.
    if (diagnostic.section === '6.2') {
      skipped.push({ what: diagnostic.origin });
    }
  }

  // The loader reports a bad MCP entry as one diagnostic against mcp.json with the server
  // name only in the prose, so derive the skipped entries from what it did not return.
  const declared = await declaredServers(join(pluginDir, 'mcp.json'));
  if (declared === 'unreadable') {
    if (!skipped.some((entry) => entry.what === 'mcp.json')) skipped.push({ what: 'mcp.json' });
  } else if (declared !== null) {
    if (mcpServers.length === 0 && declared.length > 0 && mcpDisabled(plugin.diagnostics)) {
      skipped.push({ what: 'mcp.json' });
    } else {
      for (const name of declared) {
        if (!mcpServers.includes(name)) skipped.push({ what: `mcp.json#${name}` });
      }
    }
  }

  report({ rejected: null, loaded: { skills, mcpServers }, skipped, reported });
} catch (err) {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
}

/**
 * Server names declared in mcp.json: an array, `null` when the file is absent, and
 * `'unreadable'` when it is present but not a document this adapter can read names from.
 */
async function declaredServers(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const parsed = JSON.parse(text);
    const servers = parsed?.mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return 'unreadable';
    return Object.keys(servers);
  } catch {
    return 'unreadable';
  }
}

/** True when a diagnostic disabled MCP for the whole plugin rather than one entry. */
function mcpDisabled(diagnostics) {
  return diagnostics.some(
    (d) =>
      d.origin === 'mcp.json' &&
      (d.rule === 'mcp-config-invalid' || d.rule === 'mcp-config-version-mismatch'),
  );
}
