import type { Summary, Verdict } from './diff.js';
import { GROUPS } from './runner.js';

/** Control characters are illegal in XML 1.0, and an adapter's stderr can carry them. */
const ILLEGAL_XML = new RegExp("[\u0000-\b\u000b\f\u000e-\u001f]", 'g');

/** XML text content. Attributes get the quote forms too. */
function escapeXml(value: string): string {
  return value
    .replace(ILLEGAL_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const attr = (name: string, value: string | number): string => `${name}="${escapeXml(String(value))}"`;

/**
 * JUnit XML, so a conformance run renders natively in whatever CI the client already has
 * rather than only in this tool's own output.
 *
 * A fixture becomes one testcase named after its rule, with the corpus path as classname
 * so failures group by fixture directory. Warnings ride along in system-out because they
 * are SHOULD-level and must not turn a passing run red.
 */
export function toJUnitXml(verdicts: Verdict[], summary: Summary, specVersion: string): string {
  const suites = GROUPS.filter((group) => summary.byGroup[group].total > 0).map((group) => {
    const members = verdicts.filter((verdict) => verdict.group === group);
    const stats = summary.byGroup[group];
    const cases = members.map((verdict) => renderCase(verdict)).join('\n');
    return (
      `  <testsuite ${attr('name', `agent-plugins.${group}`)} ${attr('tests', stats.total)} ` +
      `${attr('failures', stats.fail)} ${attr('errors', stats.error)} ${attr('skipped', stats.skipped)}>\n` +
      `${cases}\n  </testsuite>`
    );
  });

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites ${attr('name', `agent-plugins-conformance-kit ${specVersion}`)} ` +
    `${attr('tests', summary.total)} ${attr('failures', summary.fail)} ` +
    `${attr('errors', summary.error)} ${attr('skipped', summary.skipped)}>\n` +
    `${suites.join('\n')}\n</testsuites>\n`
  );
}

function renderCase(verdict: Verdict): string {
  const open =
    `    <testcase ${attr('name', `${verdict.ruleId} (spec ${verdict.section})`)} ` +
    `${attr('classname', verdict.fixture)} ${attr('time', (verdict.durationMs ?? 0) / 1000)}>`;

  const body: string[] = [];
  if (verdict.status === 'fail') {
    body.push(
      `      <failure ${attr('message', verdict.failures[0] ?? 'conformance failure')} ` +
        `${attr('type', verdict.ruleId)}>${escapeXml(verdict.failures.join('\n'))}</failure>`,
    );
  }
  if (verdict.status === 'error') {
    body.push(
      `      <error ${attr('message', verdict.error ?? 'adapter error')} ` +
        `${attr('type', 'adapter')}>${escapeXml(verdict.error ?? '')}</error>`,
    );
  }
  if (verdict.status === 'skipped') {
    body.push(`      <skipped ${attr('message', verdict.error ?? 'not runnable here')}/>`);
  }
  const notes = [...verdict.warnings, ...verdict.notes];
  if (notes.length > 0) {
    body.push(`      <system-out>${escapeXml(notes.join('\n'))}</system-out>`);
  }

  return body.length === 0 ? `${open}</testcase>` : `${open}\n${body.join('\n')}\n    </testcase>`;
}
