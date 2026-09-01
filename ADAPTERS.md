# Writing an adapter

An adapter is any executable that takes a plugin directory as `argv[2]` and prints one
JSON load report to stdout. That is the whole contract. The kit never imports your client.

```js
#!/usr/bin/env node
import { loadPlugin } from 'your-client';

const result = await loadPlugin(process.argv[2]);

console.log(JSON.stringify({
  rejected: result.ok ? null : result.reason,
  loaded: {
    skills: result.skills?.map((s) => s.name) ?? [],
    mcpServers: result.servers?.map((s) => s.name) ?? [],
  },
  skipped: result.dropped?.map((d) => ({ what: d.path })) ?? [],
  reported: result.warnings?.map((w) => ({ field: w.field })) ?? [],
}));
```

Run it:

```
npx apconform run --adapter ./my-adapter.mjs
```

## The load report

```json
{
  "rejected": null,
  "loaded": { "skills": ["alpha"], "mcpServers": ["api"] },
  "skipped": [{ "what": "skills/broken", "ruleId": "AS-NAME-DIR-MISMATCH" }],
  "reported": [{ "field": "hooks", "ruleId": "AP-5.2-UNKNOWN-FIELD" }]
}
```

`report.schema.json` in this package is the machine-readable version.

**`rejected`** is `null` when the plugin loaded, and any short string when it did not. The
runner compares null against non-null and nothing else, because the specification defines
no rejection vocabulary. Your reason string only shows up in failure output.

**`loaded.skills`** and **`loaded.mcpServers`** are names, not paths. Skill names come from
the frontmatter; server names are the member names in `mcp.json`. Order does not matter.

**`skipped`** lists components you dropped at a failure boundary. Use:

| Boundary | `what` |
| --- | --- |
| One skill | `skills/<directory-name>` |
| One MCP server entry | `mcp.json#<server-name>` |
| The whole skills component type | `skills` |
| The whole MCP component type | `mcp.json` |

Leading `./`, backslashes and trailing slashes are normalized, so `./skills\broken/` is
fine. Reporting a skipped component is a SHOULD in the specification, not a MUST, so a
mismatch here is a warning. `--strict-reporting` promotes it to a failure.

**`reported`** lists manifest fields you reported and ignored. There are exactly two rules
that produce entries here, and both say MUST report, so a mismatch is a failure:

- §5.2, an unknown top-level field. `field` is the field name.
- §8.1, an `extensions` value that is not an object. `field` is `extensions`.

**`ruleId`** is optional everywhere it appears. Supply one if you can map your diagnostics
onto this kit's rule ids (`apconform rules` lists them); a different id is reported as a
warning, never a failure. Most adapters leave it out.

## What the runner guarantees

- The plugin directory is an absolute path that exists.
- One process per fixture. Nothing is reused between fixtures.
- Your process is killed after `--timeout` milliseconds, 30 seconds by default.
- Anything on stderr is ignored unless the adapter also fails, in which case the last few
  lines are quoted in the error.
- A banner printed before the JSON is tolerated. The parser starts at the first `{`.

## Exit codes

Exit `0` after printing a report, including when the plugin was rejected: a rejection is a
result, not an adapter error. Exit non-zero only when you could not produce a report, and
put the reason on stderr.

## Non-Node adapters

The launcher picks an interpreter from the file extension: `.mjs`, `.cjs` and `.js` run
under the same Node as the runner, `.py` under `python3` (`python` on Windows), `.sh`
under `sh`, `.ps1` under `powershell`. A `.cmd` or `.bat` runs through the shell. Anything
else is executed directly, which is what a compiled binary needs.

Override it when the guess is wrong:

```
npx apconform run --adapter ./adapter.ts --adapter-exec "deno run -A"
```

## Fixtures that need staging

Four fixtures use a symlink that leaves the plugin root, which cannot be committed to git.
The runner copies those into a temp directory and creates the link there, so the path your
adapter receives is not always inside `fixtures/`. Read the directory you are given.

Windows refuses symlinks without Developer Mode or elevation. The runner falls back to a
junction for directory links, and reports `SKIP` with the reason for the one fixture that
needs a file link. Those fixtures run normally on Linux and macOS.

## Two examples in this package

`adapters/kuralle.mjs` targets the published `@kuralle-agents/plugins` loader. It is longer than twenty lines because that loader reports a bad MCP entry as one
diagnostic against `mcp.json` with the server name only in the prose, so the adapter
derives the skipped entries by subtracting what the loader returned from what `mcp.json`
declares. That kind of mapping is the adapter's job, and it is why the contract is a
report rather than a plugin API.

`examples/naive-adapter.mjs` is the opposite: a deliberately non-conformant loader written
the obvious way, kept so you can see what a failing run looks like before you have written
your own adapter. Do not use it as a client.
