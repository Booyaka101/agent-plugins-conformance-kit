#!/usr/bin/env node
// A perfect client, for testing the runner rather than a loader.
//
// It reads the fixture's own expectation and prints it back, so a suite run against this
// adapter must be all green. That makes it a test of the runner and of the corpus
// agreeing with itself, and it is why it lives in test/ rather than in adapters/.
//
//   APCONFORM_ECHO_BREAK=1  print a deliberately wrong report
//   APCONFORM_ECHO_JUNK=1   print something that is not a load report
//   APCONFORM_ECHO_EXIT=n   exit with status n after printing
//   APCONFORM_ECHO_HANG=1   never exit
//   APCONFORM_ECHO_FLOOD=1  print without end

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginDir = process.argv[2];
if (!pluginDir) {
  process.stderr.write('usage: echo-adapter.mjs <plugin-directory>\n');
  process.exit(2);
}

if (process.env.APCONFORM_ECHO_HANG === '1') {
  setInterval(() => {}, 1000);
} else if (process.env.APCONFORM_ECHO_FLOOD === '1') {
  const block = 'x'.repeat(1024 * 1024);
  const pump = () => {
    while (process.stdout.write(block)) {
      // keep going until the pipe applies back pressure
    }
    process.stdout.once('drain', pump);
  };
  pump();
} else if (process.env.APCONFORM_ECHO_JUNK === '1') {
  process.stdout.write('Loading plugin...\nno report for you\n');
} else {
  const fixture = JSON.parse(readFileSync(join(pluginDir, '..', 'fixture.json'), 'utf8'));
  const report = fixture.expect;
  if (process.env.APCONFORM_ECHO_BREAK === '1') {
    report.rejected = report.rejected === null ? 'broken-on-purpose' : null;
    report.loaded.skills = [...report.loaded.skills, 'phantom'];
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const exit = Number(process.env.APCONFORM_ECHO_EXIT ?? 0);
if (exit !== 0) process.exit(exit);
