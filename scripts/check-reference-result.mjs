#!/usr/bin/env node
// Pins the reference-loader result the README publishes.
//
//   node scripts/check-reference-result.mjs kuralle-report.json
//
// The kit's own CI should not go red because someone else's loader has a bug, but it
// should go red when that result changes, because then the README is wrong. The loader is
// pinned in devDependencies, so any change here is either a version bump, an adapter
// change, or a corpus change.

import { readFileSync } from 'node:fs';

// The three defects described in the README. Skipped fixtures are excluded, so this holds
// on Windows (where the file-symlink fixture cannot run) as well as on Linux.
const EXPECTED_FAILURES = [
  'core/AP-4.1-BOUNDARY-COMPONENT-LOCATION',
  'core/AP-4.1-BOUNDARY-SKILL',
  'core/AP-8.1-EXTENSIONS-MEMBER-OBJECTS',
];

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: check-reference-result.mjs <report.json>\n');
  process.exit(2);
}

const report = JSON.parse(readFileSync(path, 'utf8'));
const actual = report.verdicts
  .filter((verdict) => verdict.status === 'fail')
  .map((verdict) => verdict.fixture)
  .sort();

const errored = report.verdicts.filter((verdict) => verdict.status === 'error');

process.stdout.write(
  `${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.error} error, ${report.summary.skipped} skipped\n`,
);
for (const fixture of actual) process.stdout.write(`  fail ${fixture}\n`);
for (const verdict of report.verdicts.filter((v) => v.status === 'skipped')) {
  process.stdout.write(`  skip ${verdict.fixture}: ${verdict.error}\n`);
}

if (errored.length > 0) {
  process.stderr.write(`\nthe adapter errored on ${errored.length} fixture(s), which is an adapter bug:\n`);
  for (const verdict of errored) process.stderr.write(`  ${verdict.fixture}: ${verdict.error}\n`);
  process.exit(1);
}

if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_FAILURES)) {
  process.stderr.write(
    `\nthe reference loader result changed.\n  expected: ${EXPECTED_FAILURES.join(', ')}\n  actual:   ${actual.join(', ') || '(none)'}\n\n` +
      'Update the "Real output" section of README.md and EXPECTED_FAILURES here.\n',
  );
  process.exit(1);
}

process.stdout.write('\nreference loader result unchanged\n');
