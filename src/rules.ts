import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Severity = 'fatal' | 'report-and-ignore' | 'skip-component' | 'accept';
export type Confidence = 'core' | 'disputed';

export interface Rule {
  id: string;
  /** Specification section, e.g. "7.2.1". */
  section: string;
  severity: Severity;
  confidence: Confidence;
  /** Verbatim sentence from spec/1.0.0.md. Byte-identical, checked by `npm run verify:sources`. */
  quote: string;
  /** For skill frontmatter rules, the Agent Skills constraint the client applies at discovery time. */
  agentSkills?: { quote: string; source: string };
  issue?: string;
  note?: string;
}

export interface RuleTable {
  specVersion: string;
  specSource: string;
  agentSkillsSource: string;
  severities: Record<Severity, string>;
  confidence: Record<Confidence, string>;
  rules: Rule[];
}

/** Repository root when running from source, package root when installed. */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url));

let cached: RuleTable | undefined;

export function loadRules(): RuleTable {
  if (!cached) {
    const path = new URL('../rules.json', import.meta.url);
    cached = JSON.parse(readFileSync(path, 'utf8')) as RuleTable;
  }
  return cached;
}

export function ruleIndex(table: RuleTable = loadRules()): Map<string, Rule> {
  return new Map(table.rules.map((rule) => [rule.id, rule]));
}
