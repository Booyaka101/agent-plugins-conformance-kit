# Changelog

## 1.0.0 - 2026-09-01

First release.

- 89 rules covering sections 4 through 11 of Agent Plugins 1.0.0, each carrying the
  normative sentence verbatim. `npm run verify:sources` proves every quote is still a
  byte-identical substring of the published `spec/1.0.0.md`.
- 133 fixtures: 125 core, 4 disputed, 4 ported from real bug reports
  (openai/codex#39895, can1357/oh-my-pi#8853, dotnet/skills#1087 in both its
  as-published and `$schema`-added forms).
- `apconform` CLI with `run`, `list`, `rules`, `explain`, `show` and `verify`.
- The load report contract and `report.schema.json`, documented in ADAPTERS.md.
- Two adapters for two independently written clients. `adapters/kuralle.mjs` drives
  `@kuralle-agents/plugins` 0.25.0 and finds two conformance defects: §4.1 boundary rules
  2 and 3 are not enforced for `skills/`. `adapters/pi.mjs` drives `pi-agent-plugins`
  0.1.8, which passes all 133, including those two. Running both is what tells a wrong
  fixture apart from a wrong client, and it corrected three fixtures before release:
  two required a remote MCP entry to be activated when the rule was only that headers and
  urls are not expanded, and `AP-8.1-EXTENSIONS-MEMBER-OBJECTS` moved from `core` to
  `disputed` because both clients read §8.1 the other way.
- `optional.rejected` and `optional.reported` in `fixture.json`, for cases where the
  specification can be read two ways and implementations actually differ.
- `--baseline` and `--update-baseline`, so a client with known failures can gate on
  regressions rather than on the total.
- A composite GitHub Action at `action.yml`.
- `checklist.json`, mapping every item on the official non-normative client checklist onto
  the rules that cover it and naming the three items a load report can only cover partly.
- `examples/naive-adapter.mjs`, a deliberately non-conformant loader that shows what the
  suite catches. It scores 68 pass, 64 fail.
- `npm run capture:images`, which regenerates the README images from real command output.
- `--junit <file>`, so a run renders natively in CI rather than only in this tool's output.
- `apconform show <fixture-id>`, which prints the rule, the normative sentence, the plugin
  tree on disk and the expected report for one fixture.
