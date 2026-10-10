// Usage: node tests/visual/capture.mjs <outDir> [--url http://localhost:3000] [--only name,name]
// Starts vite (CAMPUS_DATA=cache) unless --url points at a running server, then screenshots the scenario matrix.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1]; };
const outDir = resolve(args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? 'visual-out');
const only = flag('only')?.split(',');
const PORT = 3000;
let base = flag('url');

// Pinned state: bundled fixtures, Wednesday period 3, no toast, no live models (needs network token), no debug.
const QS = 'fixture=1&day=3&period=3&static=1&models=0';

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// Each step runs in the page. animate:false everywhere except the last scenario, which exercises the flights.
const S = (name, building, steps) => ({ name, building, steps });
const SCENARIOS = [
  S('campus', 'A3T', [{ view: 'campus' }]),
  S('a3t-overview', 'A3T', [{ view: 'overview' }]),
  S('a3t-floor-2f', 'A3T', [{ view: 'floor', floor: '2F' }]),
  S('a3t-floor-5f-room', 'A3T', [{ view: 'floor', floor: '5F' }, { select: 'A3T/5F/501' }]),
  S('am-overview', 'AM', [{ view: 'overview' }]),
  S('am-floor-7f', 'AM', [{ view: 'floor', floor: '7F' }]),
  S('cb-overview', 'CB', [{ view: 'overview' }]),
  S('cb-floor-4f', 'CB', [{ view: 'floor', floor: '4F' }]),
  S('transitions-noanim', 'A3T', [{ view: 'floor', floor: '3F' }, { view: 'overview' }, { view: 'campus' }, { building: 'CB', view: 'overview' }, { view: 'floor', floor: '2F' }]),
  S('flight-animated', 'A3T', [{ view: 'floor', floor: '4F', animate: true }, { wait: true }, { view: 'overview', animate: true }]),
];

async function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT)], { env: { ...process.env, CAMPUS_DATA: 'cache' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout.on('data', d => { if (/Local:/.test(String(d))) ok(); });
    proc.on('exit', c => fail(new Error(`vite exited ${c}`)));
    setTimeout(() => fail(new Error('vite start timeout')), 30000);
  });
  base = `http://localhost:${PORT}`;
  return proc;
}

// Screenshot until two consecutive frames are byte-identical (animations/fades finished), max 12 tries.
async function stableShot(page, path) {
  let prev = null;
  for (let i = 0; i < 12; i++) {
    const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    if (prev && buf.equals(prev)) { await (await import('node:fs/promises')).writeFile(path, buf); return i; }
    prev = buf;
    await page.waitForTimeout(300);
  }
  throw new Error(`never stabilised: ${path}`);
}

const server = base ? null : await startServer();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
await mkdir(outDir, { recursive: true });
let failed = 0;
try {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    for (const sc of SCENARIOS) {
      const name = `${vpName}-${sc.name}`;
      if (only && !only.includes(name) && !only.includes(sc.name)) continue;
      const ctx = await browser.newContext({ ...vp, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', reducedMotion: 'reduce', timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      try {
        await page.goto(`${base}/?${QS}&building=${sc.building}&view=overview`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__map && window.__settled, null, { timeout: 30000 });
        await page.evaluate(() => window.__settled());
        for (const step of sc.steps) {
          if (step.wait) { await page.evaluate(() => window.__settled()); continue; }
          await page.evaluate(async st => {
            const m = window.__map;
            if (st.select) { if (!(await m.selectRoom(st.select, { animate: false }))) throw new Error('selectRoom refused ' + st.select); }
            else {
              const ok = await m.setView({ building: st.building, view: st.view, floor: st.floor ?? null, animate: st.animate ?? false });
              if (!ok) throw new Error('setView refused ' + JSON.stringify(st));
            }
            if (st.animate) return; // let the flight run; a following {wait} or setView handles it
            await window.__settled();
          }, step);
          // setView refuses while flying: give the animated flight room before the next step
          if (step.animate) await page.evaluate(() => window.__settled());
        }
        await page.evaluate(() => window.__settled());
        const tries = await stableShot(page, join(outDir, `${name}.png`));
        console.log(`ok   ${name}${tries > 1 ? ` (stabilised after ${tries})` : ''}${errors.length ? ` [page errors: ${errors.join('; ')}]` : ''}`);
      } catch (e) {
        failed++;
        console.error(`FAIL ${name}: ${e.message}`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
