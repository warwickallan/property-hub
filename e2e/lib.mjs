// Shared helpers for the Property Hub browser journeys (puppeteer-core driving an installed Chrome/Chromium).
import fs from 'node:fs';
import path from 'node:path';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/pw-browsers/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a Chrome or Edge executable.');
  return found;
}

/** Results collector: each journey records PASS/FAIL lines; any failure or browser error fails the run. */
export class Results {
  constructor(name) { this.name = name; this.pass = 0; this.fail = 0; this.lines = []; }
  ok(cond, msg) {
    const line = `${cond ? 'PASS' : 'FAIL'} [${this.name}] ${msg}`;
    cond ? this.pass++ : this.fail++;
    this.lines.push(line);
    console.log(line);
  }
}

/** Wraps a page with the small vocabulary the journeys use. */
export function driver(page, { base, outDir, prefix }) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // 400/409 responses are the app's own validation refusals (shown to the user in an error box); the
  // journeys trigger some deliberately and assert the message. Anything else is a real browser error.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 40[09]/.test(m.text())) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => d.accept());
  fs.mkdirSync(outDir, { recursive: true });

  const d = {
    page, errors,
    text: () => page.$eval('body', (b) => b.innerText),
    within: (sel) => page.$eval(sel, (el) => el.innerText),
    shot: (name, opts = {}) => page.screenshot({ path: path.join(outDir, `${prefix}-${name}.png`), fullPage: true, ...opts }),
    go: async (hash) => { await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle0' }); await wait(350); },
    api: (url) => page.evaluate((u) => fetch(u).then((r) => r.json()), url),
    /** Click the first element matching `sel` whose text matches `re`. */
    clickText: async (sel, re, scope = 'body') => {
      const done = await page.evaluate((sel, src, flags, scope) => {
        const root = document.querySelector(scope) || document.body;
        const el = [...root.querySelectorAll(sel)].find((e) => new RegExp(src, flags).test((e.innerText || e.textContent || '').trim()));
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }, sel, re.source, re.flags, scope);
      if (!done) throw new Error(`No ${sel} matching ${re} in ${scope}`);
      await wait(400);
    },
    /** Set a React-controlled input/select/textarea value. */
    setVal: async (sel, value) => {
      await page.$eval(sel, (el, value) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      }, value);
      await wait(250);
    },
    selectByText: async (sel, re) => {
      const v = await page.$eval(sel, (el, src, flags) => {
        const o = [...el.options].find((o) => new RegExp(src, flags).test(o.text));
        return o ? o.value : null;
      }, re.source, re.flags);
      if (v === null) throw new Error(`No option ${re} in ${sel}`);
      await d.setVal(sel, v);
    },
    noHorizontalScroll: () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  };
  return d;
}

/** Route browser downloads into `dir` and return a function that waits for a new file. */
export async function enableDownloads(page, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: page.browserContext().id });
  return async (name, timeout = 8000) => {
    const file = path.join(dir, name);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
      await wait(150);
    }
    throw new Error(`Download ${name} did not arrive`);
  };
}
