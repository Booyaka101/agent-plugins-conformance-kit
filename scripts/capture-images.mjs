#!/usr/bin/env node
// Regenerates the README images from real command output.
//
//   npm run build && node scripts/capture-images.mjs
//
// Every image is a render of what the commands below actually printed on this machine.
// The SVGs are produced with no dependencies. The PNGs, which is what npm renders since
// it strips SVG from READMEs, need a Chrome listening on 9222:
//
//   chrome --remote-debugging-port=9222
//
// Without it the SVGs are still rewritten and the script says the PNGs are now stale.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const images = join(root, 'images');
const cli = join(root, 'dist', 'cli.js');
mkdirSync(images, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'apconform-images-'));

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return `${result.stdout}${result.stderr}`;
}

function render(name, shown, output, title) {
  const capture = join(scratch, `${name}.txt`);
  writeFileSync(capture, `$ ${shown}\n${output}`);
  const svg = join(images, `${name}.svg`);
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'render-terminal.mjs'), capture, svg, title],
    { encoding: 'utf8' },
  );
  process.stdout.write(result.stdout || result.stderr);
  return svg;
}

const naive = join(root, 'examples', 'naive-adapter.mjs');
const baselineFile = join(scratch, 'conformance-baseline.json');

const shots = [];

shots.push(
  render(
    'run-kuralle',
    'apconform run --adapter adapters/kuralle.mjs --quiet',
    run(['run', '--adapter', join(root, 'adapters', 'kuralle.mjs'), '--quiet']),
    'apconform run - @kuralle-agents/plugins 0.25.0',
  ),
);

// Record a baseline for the deliberately non-conformant example, then show the ratchet
// reporting those failures as known rather than gating on them.
run(['run', '--adapter', naive, '--only', 'core', '--fixture', 'AP-5.2', '--baseline', baselineFile, '--update-baseline', '--quiet']);
shots.push(
  render(
    'baseline',
    'apconform run --adapter ./adapter.mjs --baseline conformance-baseline.json --quiet',
    run(['run', '--adapter', naive, '--only', 'core', '--fixture', 'AP-5.2', '--baseline', baselineFile, '--quiet']),
    'apconform run --baseline',
  ),
);

rmSync(scratch, { recursive: true, force: true });

// --- PNG, via a Chrome that is already running -------------------------------
const CDP = 'http://127.0.0.1:9222';
const reachable = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

if (!reachable) {
  process.stdout.write(
    `\nno Chrome on ${CDP}, so images/*.png were not regenerated and are now stale.\n` +
      'Start Chrome with --remote-debugging-port=9222 and run this again.\n',
  );
  process.exit(1);
}

const tab = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json();
await new Promise((r) => setTimeout(r, 600));
const page = await openPage(tab.webSocketDebuggerUrl);

try {
  for (const svgPath of shots) {
    const svg = readFileSync(svgPath, 'utf8');
    const width = Number(svg.match(/width="(\d+)"/)?.[1]);
    const height = Number(svg.match(/height="(\d+)"/)?.[1]);
    const html = join(tmpdir(), `apconform-shot-${width}x${height}.html`);
    writeFileSync(
      html,
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#12141a}svg{display:block}</style>${svg}`,
    );

    await page.send('Page.navigate', { url: `file:///${html.replace(/\\/g, '/')}` });
    await new Promise((r) => setTimeout(r, 900));
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 400));

    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 2 },
    });
    const png = svgPath.replace(/\.svg$/, '.png');
    writeFileSync(png, Buffer.from(data, 'base64'));
    rmSync(html, { force: true });
    process.stdout.write(`${png}  ${width * 2}x${height * 2}\n`);
  }
} finally {
  page.socket.close();
  await fetch(`${CDP}/json/close/${tab.id}`);
}

/**
 * Just enough DevTools Protocol to navigate and screenshot: a websocket, a request id and
 * a pending map. Pulling in a driver for three calls would be more code, not less.
 */
async function openPage(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', () => rej(new Error(`could not open ${wsUrl}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timed out: ${method}`));
      }, 30_000);
    });

  return { socket, send };
}
