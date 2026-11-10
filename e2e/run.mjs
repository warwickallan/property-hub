// Repeatable browser acceptance run: `npm run e2e`.
// Starts the built app on a throwaway data folder (fresh fictional seed), runs the P0 and P1 journeys
// in separate browser contexts, prints PASS/FAIL per step, and exits non-zero on any failure or browser error.
// Screenshots and downloaded CSVs go to e2e/output/ (git-ignored).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { driver, enableDownloads, findChrome, Results, wait } from './lib.mjs';
import p0 from './p0-journey.mjs';
import p1 from './p1-journey.mjs';
import p11 from './p11-journey.mjs';
import v2 from './v2-journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e', 'output');
const PORT = Number(process.env.E2E_PORT ?? 3099);
const BASE = `http://127.0.0.1:${PORT}`;
const only = process.argv.slice(2);

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ missing: run `npm run build` first (npm run e2e does this for you).');
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-e2e-'));

const server = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'server', 'index.ts')], {
  cwd: ROOT, env: { ...process.env, PH_DATA_DIR: dataDir, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => (serverLog += b));
server.stderr.on('data', (b) => (serverLog += b));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/status`)).ok) return;
    } catch { /* not up yet */ }
    await wait(200);
  }
  throw new Error(`Server did not start:\n${serverLog}`);
}

const journeys = [
  ['p0', p0],
  ['p1', p1],
  ['p11', p11],
  ['v2', v2],
].filter(([n]) => !only.length || only.includes(n));

let failed = 0;
const all = [];
let browser;
try {
  await waitForServer();
  console.log(`App on ${BASE} with fresh data in ${dataDir}`);
  browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--disable-gpu', '--hide-scrollbars', '--no-sandbox'] });
  for (const [name, fn] of journeys) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const d = driver(page, { base: BASE, outDir: OUT, prefix: name });
    const r = new Results(name);
    const awaitDownload = await enableDownloads(page, path.join(OUT, `${name}-downloads`));
    try {
      await fn(d, r, { tmpDir: dataDir, awaitDownload });
    } catch (e) {
      r.ok(false, `exception: ${e.message}`);
      await d.shot('99-failure').catch(() => {});
    }
    for (const e of d.errors) r.ok(false, `browser ${e}`);
    failed += r.fail;
    all.push(r);
    await ctx.close();
  }
} catch (e) {
  console.error(e.message);
  failed++;
} finally {
  await browser?.close();
  await new Promise((res) => { server.once('exit', res); server.kill(); });
}

const summary = all.map((r) => `${r.name}: ${r.pass} passed, ${r.fail} failed`).join('\n');
fs.writeFileSync(path.join(OUT, 'results.txt'), `${all.flatMap((r) => r.lines).join('\n')}\n\n${summary}\n`);
console.log(`\n${summary}\nScreenshots and results: ${OUT}`);
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly; temp dir */ }
process.exit(failed ? 1 : 0);
