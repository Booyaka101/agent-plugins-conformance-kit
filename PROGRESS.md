# PROGRESS

Status: **v1.0.0 complete and publish-ready.** Not published: publishing to npm and
creating the GitHub repo are owner-operated, per the build constraints.

Last updated 2026-09-01, after a second senior review pass.

## Phase 0: source verification

Every external resource the brief depends on was fetched and checked before any code was
written. Nothing was blocked, and there is no cost barrier: the specification, both
schemas, the Agent Skills page, all five GitHub issues and the reference loader are public
and free, and the kit needs no API key, account or hosting.

| Source | Verified |
| --- | --- |
| `spec/1.0.0.md` | 200, 42,751 bytes, 640 lines. All five sentences the brief quotes appear verbatim, with backticks (`` `SKILL.md` ``, `` `extensions` ``). |
| `plugin.schema.json` | `required: ["$schema","name"]`, `additionalProperties: false`. |
| `mcp.schema.json` | `required: ["$schema","mcpServers"]`, three closed `$defs` variants. |
| `agentskills.io/specification` | name 1-64, lowercase alphanumeric and hyphens, no leading/trailing or consecutive hyphen, must match the parent directory; description 1-1024. |
| Client conformance checklist | 21 items across 4 headings, self-declared non-normative. |
| `@kuralle-agents/plugins` | 0.25.0, published 2026-08-25, Apache-2.0. `loadAgentPlugin(fs, root, options?)` returns `{ok:true, plugin}` or `{ok:false, rejection, diagnostics}`. |
| spec#77, codex#39895, oh-my-pi#8853, dotnet/skills#1087 | All open or closed as described, with the quoted text present. |
| EveryInc/compound-engineering-plugin#1411 | Real, closed. "loads 3 of 33 skills". Added as the sixth README source. |
| VS Code agent-plugins docs | "Invalid names cause the skill to be silently skipped." |

Two things measured rather than assumed:

- The reference loader was smoke-tested live before the adapter was designed. Rooting
  `NodeFileSystem` at the plugin's parent and passing `/<dirname>` is the form that works;
  rooting at the plugin itself makes every load fail `path-escapes-plugin-root`.
- The §4.1 symlink findings were re-checked on POSIX semantics using the loader's own
  `InMemoryFs`, not just Windows junctions, so they are not a platform artifact.

## What is verified working

Every number below was produced by a command run on this machine, not estimated.

- `npm test` - 476 tests, 8 files, all passing, from a wiped `node_modules` and `dist`.
- `npm run typecheck` - clean, with `noUnusedLocals`, `noUnusedParameters`,
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on.
- `npm run verify:sources` - 89/89 spec quotes verbatim, 14/14 Agent Skills constraints,
  21/21 checklist items, both schemas unchanged in the ways fixtures rely on.
- `apconform verify` - corpus OK, 133 fixtures, 89 rules.
- `apconform run --adapter adapters/kuralle.mjs` - 129 pass, 3 fail, 0 error, 1 skipped on
  Windows. On Linux the skipped fixture runs and passes, giving 130 pass, 3 fail.
- Against a deliberately naive loader (validate-and-reject plus recursive skill discovery)
  the suite reports 68 pass, 64 fail, including the exact issue #77 failure shape.
- `npm pack` - 551 files, 86.5 kB, 513 of them fixture files. No test files leak, and the
  README images are not shipped because it references them by absolute URL.
- Clean install of the tarball into a fresh directory, then running the shipped
  `adapters/kuralle.mjs` through the installed `apconform` binary: identical result.
- The composite action's shell body was extracted from `action.yml` and executed locally
  with GitHub's environment variables faked, against a real packed tarball through `npx`.
  Outputs (`passed=7 failed=6`), job summary, JSON report, JUnit XML and `fail-on-error`
  all behave. CI runs the action against its own freshly built tarball on every push.
- Error paths exercised by hand and in tests: missing adapter, adapter that is a
  directory, unlaunchable interpreter, non-JSON stdout, valid report with a non-zero exit,
  an adapter that never exits, a missing corpus root, a filter matching nothing, a bad
  `--only`, a non-positive `--concurrency`, an unknown rule id, a corrupt baseline.

Exit codes: 0 clean, 1 conformance failures or adapter errors, 2 could not run. All
verified directly rather than through a pipe.

## Findings

The suite found three real conformance defects in `@kuralle-agents/plugins` 0.25.0:

1. **§4.1 boundary rule 3** - a `skills/` entry linked outside the plugin root is followed
   and its skill is loaded. `loadSkillsComponent` has no containment check.
2. **§4.1 boundary rule 2** - the same gap for the `skills/` location itself.
3. **§5.2 via §8.1** - `extensions: { "com.example.client": "enabled" }` is reported and
   dropped rather than rejecting the plugin. `validateExtensions` applies the §8.1
   report-and-ignore exception to a member value, but the exception is only for a
   non-object `extensions` field.

The loader does enforce containment on `plugin.json` itself, so 1 and 2 read as an
oversight rather than a decision. Filing these upstream is the first distribution step.

## Deliberate design decisions a reviewer should know about

- **`rejected` is compared on rejectedness, not on the string.** The specification defines
  no rejection vocabulary, so asserting one would make the suite a naming quiz.
- **`skipped` mismatches are warnings, `reported` mismatches are failures.** §7.1 and
  §7.2.2 say a client SHOULD report a dropped component; §5.2 and §8.1 say it MUST report
  the two ignorable manifest fields. `--strict-reporting` promotes the warnings.
- **A fourth severity, `accept`, was added** alongside the brief's
  `fatal|report-and-ignore|skip-component`. Many rules require the client to load
  something, and labelling those with a failure-boundary severity would have been wrong.
- **`observability: "partial"` on 8 fixtures.** A load report cannot see subprocess
  environments or expanded placeholder values, so those fixtures say in writing what they
  do and do not assert instead of pretending to cover §9 fully.
- **`optional` and `atLeastOne` in `fixture.json`.** Where the specification permits more
  than one outcome, the fixture accepts both and records the choice as a note.
- **The corpus is generated but not shipped with its generator.** `fixtures/` is the
  artifact and is committed; `apconform verify` and the meta-tests keep it honest, so a
  second source of truth would only rot.
- **The specification text is not vendored.** The spec repository carries no LICENSE and
  GitHub reports `NOASSERTION`, so `rules.json` holds short normative sentences and
  `npm run verify:sources` checks them against upstream instead.

## Senior review pass, second round

Reviewing the code as a stranger, and then actually shipping it, turned up nine defects
that tests had not caught. All are fixed, and each has either a regression test or, for
the action, a CI job that runs it.

1. **Output was nondeterministic.** Fixtures finish out of order under concurrency, so two
   identical runs printed the same lines in different orders and could not be diffed.
   Verdicts are now released in corpus order as the prefix fills in, which keeps live
   progress. Asserted by running the corpus twice and comparing stdout byte for byte, and
   again at `--concurrency 1`.
2. **Value-taking flags accepted no value.** `--fixture --quiet` silently ran all 133
   fixtures instead of erroring, and `--json` with no path silently wrote nothing. Every
   such flag now goes through one validator. Covered by a table test over seven flags.
3. **`.cmd` and `.bat` adapters broke on paths with spaces.** With `shell: true` Node
   hands the line to cmd.exe unquoted, so an adapter under "Program Files" split at the
   space. Command and arguments are now quoted, and only for a shell launch.
4. **An adapter could take the runner down.** stdout was accumulated without limit. It is
   capped at 8 MB per stream, after which the child is killed and the fixture reports why.
5. **A third-party corpus could crash the differ.** `--fixtures <dir>` trusted
   `fixture.json` without checking `expect`. It is now validated at load and reported as a
   corpus error naming the file.
6. **The baseline view contradicted itself.** A failure the baseline already knew about
   printed as a red `FAIL` and was then summarised as "0 regressions, 6 known". Those
   lines now print as `KNOWN`, and the baseline is read before the run so a missing one
   fails in 0.1s rather than after the whole corpus.

7. **The GitHub Action had never been executed.** Extracting its shell body from
   `action.yml` and running it for real found that `npx` given an absolute path to a
   tarball exits 0 having done nothing: no output, no report, `passed=0 failed=0`. The
   action now copies a local tarball into its scratch directory and runs the relative
   spec, and CI has a job that runs the action against the tarball it just built, so a
   broken `action.yml` goes red before a release rather than after one.

8. **`.gitignore` was silently truncating the corpus.** `node_modules/` is unanchored, and
   the `AP-7.1-DEPTH__deep-nesting` fixture deliberately contains a `node_modules`
   directory, because a client must not discover skills inside a vendored plugin. Its
   `SKILL.md` was excluded from the repository, so anyone cloning would have got a fixture
   that passes without testing anything. `npm pack` was unaffected, because `files` in
   `package.json` does not use gitignore semantics, which is exactly why nothing caught
   it. The ignore rules are now anchored to the repository root, and a test compares
   `git ls-files fixtures` against the files on disk. That test was verified by putting
   the old rule back and watching it fail. A `.gitattributes` also pins the corpus to LF,
   because a CRLF checkout on Windows would change the bytes a client's parser sees.

9. **The corpus self-check failed on Linux only, and CI caught it.** The
   `AP-7.1-IMMEDIATE-CHILD__case-sensitive-filename` fixture ships
   `skills/beta/skill.md` on purpose: on Windows and macOS that is the same file as
   `SKILL.md`, on Linux it is a different one, and that difference is the fixture. But
   `verifyCorpus` demanded a `SKILL.md` for optional skills as well as required ones, so
   `apconform verify` failed on every Linux runner and took the `pack` job with it. Every
   local run had been on a case-insensitive filesystem, which is precisely why the matrix
   exists. An optional skill's file may now legitimately be absent, and when it is present
   the frontmatter is still checked. `test/verify.test.ts` covers `verifyCorpus` against
   synthetic corpora, including this case.

Checked and found not to be a problem: staging temp directories do not leak (three
consecutive full runs left zero behind; the four seen earlier were from runs killed
mid-flight).

## One bug worth calling out, because it was invisible

`"pretest": "npm run build"` never ran. This machine's `~/.npmrc` sets
`ignore-scripts=true`, which silently suppresses every `pre`/`post` lifecycle script with
no warning: `npm test` printed only `> vitest run`, which looks exactly like a pre-script
that produced no output. The e2e tests spawn `dist/cli.js`, so for a while they were
passing against a stale build and would have gone red on a clean CI checkout.

Fixed by chaining explicitly (`"test": "npm run build && vitest run"`) rather than relying
on a hook, and the CI `pack` job now runs `npm run build` instead of trusting `prepack` for
the same reason. Do not add `pre`/`post` scripts back to this package.

## Clone check

`difflib.SequenceMatcher` over the line lists of all 57 functions of five lines or more in
`src/`, `adapters/`, `examples/`, `scripts/` and `test/`. Two pairs are above 45%, neither
above the 60% threshold:

```
50.8%   src/diff.ts::compareReported  vs  src/diff.ts::compareSkipped
46.2%   src/cli.ts::optionalString    vs  src/cli.ts::requireString
```

`optionalString` and `requireString` are five lines each and differ in exactly the thing
that matters (absent is fine versus absent is an error). Merging them behind a boolean
would be longer and less readable, so they stay separate.

Under the 60% threshold, and the shared mechanisms were extracted rather than left
duplicated: `warnOnRuleIdMismatch`, `componentPaths` and `list`. Where I stopped: merging
the two into one driver would need `label`, `keyOf`, a tolerance set, a strict flag and a
sink selector, which is exactly the many-parameter driver the house rules warn against.
The residual similarity is the set-diff-and-report shape, and the two are not the same
workflow: one gates on MUSTs, the other warns on SHOULDs and carries a tolerance set.

Two duplications the check surfaced were fixed rather than argued with: an identical
four-line loop building `tolerated` and `eitherWay` in `compareSkipped`, and the rule-id
cross-check loop duplicated between the two functions.

## Features added during review

- **`--junit <file>`.** A conformance suite exists to live in someone's CI, so it should
  render there natively rather than only in its own output. Verified by parsing the result
  with a real XML parser, and the escaping is unit-tested including control characters,
  which are illegal in XML 1.0 and can arrive from an adapter's stderr.
- **`apconform show <fixture-id>`.** A verdict line names a rule; the next question is
  always what the fixture on disk contains. This prints the rule, the normative sentence,
  the plugin tree, the manifest and `mcp.json`, and the expected report. A partial id
  lists the matches.
- **`examples/naive-adapter.mjs`.** A deliberately non-conformant loader, written the way
  an implementer reaches for first: validate against the closed schema and reject, then
  walk `skills/` recursively. It scores 68 pass, 64 fail, and it makes the README's
  numbers reproducible by anyone.
- **`images/` and `npm run capture:images`.** The README now leads with a picture of a
  real run. Both images are rendered from captured output by a script, so they cannot
  drift into being an artist's impression of what the tool prints.

## What is left

Nothing for v1. Three things need the owner because an agent cannot do them:

1. `git init`, create `Booyaka101/agent-plugins-conformance-kit` and push. The repository
   URLs in `package.json` already point there and the name is free (404 on the API).
2. `npm publish`. The name `agent-plugins-conformance-kit` is unclaimed (404 on the
   registry). Decide on provenance before the first publish, because npm will not let a
   version be republished.
3. Optionally list the action on the GitHub Marketplace. The `action.yml` description is
   95 characters, under the 125-character limit that blocks listing.

## Next steps, in rough order of value

1. **File the three findings** against `kuralle/kuralle-agents`, one issue per boundary
   rule, with the fixture id and reproduction. Then comment on
   `agentplugins/agent-plugins-spec#77` with the two fixtures that encode it, since that
   issue is asking for exactly this and the maintainers are the audience.
2. **A second real adapter.** One adapter proves the contract works; two prove it is not
   shaped around one loader. VS Code and Codex are the interesting targets because the
   README already cites bugs in both.
3. **A `--offline` mode that proves `AP-5.2-NO-SCHEMA-FETCH`.** Today that fixture is only
   a real assertion if the whole run happens without network. Spawning the adapter with a
   blocked loopback proxy, or with a documented sandbox flag, would make it bite on demand.
4. **Fixtures for §9 subprocess behaviour**, which needs a second, optional contract: a
   launch report carrying the resolved `cwd`, `args`, `env` and the two reserved variables.
   That is a v1.1 conversation because it changes what an adapter has to implement, and it
   would let the three partial checklist items become full ones.
5. **Track the specification.** `verify:sources` already fails when a quote drifts. Running
   it on a schedule rather than only in CI would turn that into an early warning when
   1.0.1 or 1.1 lands.
