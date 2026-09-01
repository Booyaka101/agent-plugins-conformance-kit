#!/usr/bin/env node
// Conformance adapter for pi-agent-plugins, the second independently written 1.0.0
// client the corpus is checked against.
//
//   npm install pi-agent-plugins
//   npx apconform run --adapter adapters/pi.mjs
//
// Running the corpus against two clients written by different people is what tells a
// wrong fixture apart from a wrong client. Three corpus bugs were found this way.
//
// That package ships TypeScript source with no build step, and Node refuses to strip
// types for files under node_modules, so the source is staged beside node_modules once
// and imported from there. Nothing else about it is unusual.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = process.argv[2];
if (!pluginDir) {
  process.stderr.write('usage: pi.mjs <plugin-directory>\n');
  process.exit(2);
}

let loadPlugin;
try {
  loadPlugin = (await import(pathToFileURL(strippableSource()).href)).loadPlugin;
} catch (err) {
  process.stderr.write(
    'this adapter needs pi-agent-plugins installed, and Node 22.6+ for --experimental-strip-types.\n' +
      '  npm install pi-agent-plugins\n' +
      `  node --experimental-strip-types ...\n${err?.message ?? err}\n`,
  );
  process.exit(2);
}

const report = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

try {
  const result = loadPlugin(pluginDir, { scope: 'project' });

  // A rejection is the shape that carries diagnostics and no manifest.
  if (!result || result.manifest === undefined) {
    const first = result?.diagnostics?.[0];
    report({
      rejected: first ? `${first.section}/${first.message}` : 'rejected',
      loaded: { skills: [], mcpServers: [] },
      skipped: [],
      reported: [],
    });
    process.exit(0);
  }

  const skills = result.skills.map((skill) => skill.dir);
  const mcpServers = result.mcpServers.map((server) => server.name);
  const diagnostics = result.diagnostics ?? [];

  const skipped = [];
  const reported = [];

  for (const d of diagnostics) {
    if (d.section === '5.2' && /unknown/i.test(d.message)) {
      const field = d.component ?? d.message.match(/"([^"]+)"/)?.[1];
      if (field) reported.push({ field, ruleId: 'AP-5.2-UNKNOWN-FIELD' });
      continue;
    }
    if (d.section === '8.1') {
      reported.push({ field: 'extensions', ruleId: 'AP-8.1-EXTENSIONS-NOT-OBJECT' });
      continue;
    }
    if (d.section === '7.1' && d.component) skipped.push({ what: `skills/${d.component}` });
    else if (d.section === '6.2') {
      skipped.push({ what: /mcp/i.test(d.message) ? 'mcp.json' : 'skills' });
    }
  }

  // This client names the server in prose rather than in a field, so the skipped entries
  // are derived from what mcp.json declares minus what came back.
  const declared = await declaredServers(join(pluginDir, 'mcp.json'));
  if (declared === 'unreadable') {
    if (!skipped.some((entry) => entry.what === 'mcp.json')) skipped.push({ what: 'mcp.json' });
  } else if (declared !== null) {
    const mcpDisabled = diagnostics.some(
      (d) => /mcp\.json/i.test(d.message ?? '') && /invalid|unsupported|mismatch|disabl/i.test(d.message ?? ''),
    );
    if (mcpServers.length === 0 && declared.length > 0 && mcpDisabled) {
      if (!skipped.some((entry) => entry.what === 'mcp.json')) skipped.push({ what: 'mcp.json' });
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
 * The loader source, copied out of node_modules so Node will strip its types. It is
 * staged as a sibling of node_modules rather than in a temp directory, because the source
 * imports `yaml` and resolution has to be able to walk up and find it.
 */
function strippableSource() {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve('pi-agent-plugins/package.json'));
  const projectRoot = dirname(dirname(packageDir));
  const { version } = require('pi-agent-plugins/package.json');

  const staged = join(projectRoot, '.cache', `apconform-pi-src-${version}`);
  if (!existsSync(join(staged, 'loader.ts'))) {
    mkdirSync(staged, { recursive: true });
    cpSync(join(packageDir, 'src'), staged, { recursive: true });
  }
  return join(staged, 'loader.ts');
}

async function declaredServers(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const servers = JSON.parse(text)?.mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return 'unreadable';
    return Object.keys(servers);
  } catch {
    return 'unreadable';
  }
}
