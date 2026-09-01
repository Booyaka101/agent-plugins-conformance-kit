#!/usr/bin/env node
// Renders captured terminal output to an SVG, so the README shows what the tool actually
// printed rather than a retyped approximation.
//
//   node scripts/render-terminal.mjs <captured.txt> <out.svg> "window title"
//
// Input is read verbatim. Nothing is invented here: run the command, redirect it to a
// file, render that file.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output, title = 'apconform'] = process.argv;
if (!input || !output) {
  process.stderr.write('usage: render-terminal.mjs <captured.txt> <out.svg> [title]\n');
  process.exit(2);
}

const COLOURS = {
  bg: '#12141a',
  chrome: '#1b1e26',
  text: '#c9d1d9',
  dim: '#6e7681',
  pass: '#3fb950',
  fail: '#f85149',
  warn: '#d29922',
  skip: '#8b949e',
  info: '#58a6ff',
};

const CHAR_WIDTH = 8.05;
const LINE_HEIGHT = 20;
const PAD_X = 18;
const PAD_TOP = 46;
const PAD_BOTTOM = 18;

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Colour a line by its verdict prefix, and dim the summary block. */
function colourFor(line) {
  if (line.startsWith('FAIL ') || line.startsWith('REGRESSION ')) return COLOURS.fail;
  if (line.startsWith('WARN ')) return COLOURS.warn;
  if (line.startsWith('PASS ') || line.startsWith('FIXED ')) return COLOURS.pass;
  if (line.startsWith('SKIP ') || line.startsWith('GONE ')) return COLOURS.skip;
  if (line.startsWith('ERROR ')) return COLOURS.fail;
  if (line.startsWith('$ ')) return COLOURS.info;
  if (/^(core|disputed|regressions|total|baseline)\s/.test(line)) return COLOURS.text;
  return COLOURS.dim;
}

const lines = readFileSync(input, 'utf8').replace(/\r/g, '').replace(/\s+$/, '').split('\n');
const widest = lines.reduce((max, line) => Math.max(max, line.length), 0);
const width = Math.ceil(PAD_X * 2 + widest * CHAR_WIDTH);
const height = PAD_TOP + lines.length * LINE_HEIGHT + PAD_BOTTOM;

const dots = ['#ff5f57', '#febc2e', '#28c840']
  .map((fill, i) => `<circle cx="${20 + i * 18}" cy="18" r="6" fill="${fill}"/>`)
  .join('');

const body = lines
  .map((line, i) => {
    if (line.length === 0) return '';
    const y = PAD_TOP + i * LINE_HEIGHT;
    const weight = /^(total|baseline)\s/.test(line) ? ' font-weight="600"' : '';
    // Per-element, because xml:space on the group does not reach the children and the
    // summary columns are aligned with runs of spaces.
    return `<text xml:space="preserve" x="${PAD_X}" y="${y}" fill="${colourFor(line)}"${weight}>${escape(line)}</text>`;
  })
  .filter(Boolean)
  .join('\n    ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="13">
  <rect width="${width}" height="${height}" rx="8" fill="${COLOURS.bg}"/>
  <rect width="${width}" height="36" rx="8" fill="${COLOURS.chrome}"/>
  <rect y="28" width="${width}" height="8" fill="${COLOURS.chrome}"/>
  ${dots}
  <text x="${width / 2}" y="22" fill="${COLOURS.dim}" font-size="12" text-anchor="middle">${escape(title)}</text>
  <g>
    ${body}
  </g>
</svg>
`;

writeFileSync(output, svg);
process.stdout.write(`${output}  ${width}x${height}  ${lines.length} lines\n`);
