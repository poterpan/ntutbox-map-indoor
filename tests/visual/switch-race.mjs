// Usage: node tests/visual/switch-race.mjs [--url http://localhost:3200]
// Viewer regression: tap building A, then B while A is still loading (A's floors delayed). B must win; A must not
// take over (or unload B) when its data finally arrives. Starts vite on 3200 with CAMPUS_DATA=cache unless --url.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1]; };
let base = flag('url');
let server = null;
if (!base) {
  server = spawn('npx', ['vite', '--port', '3200', '--strictPort'], { env: { ...process.env, CAMPUS_DATA: 'cache' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { server.stdout.on('data', d => { if (/Local:/.test(String(d))) ok(); }); setTimeout(() => fail(new Error('vite start timeout')), 30000); });
  base = 'http://localhost:3200';
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?fixture=1&day=3&period=3&static=1&models=0&building=A3T&view=overview`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__map && window.__settled, null, { timeout: 30000 });
  await page.evaluate(() => window.__settled());
  // CB's floors arrive 2.5 s late; AM's immediately.
  await page.route(/\/campus-data\/indoor\/CB\//, async route => { await new Promise(r => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
  const res = await page.evaluate(async () => {
    const m = window.__map;
    const a = m.setView({ building: 'CB', view: 'overview', animate: false });
    await new Promise(r => setTimeout(r, 50));
    const b = await m.setView({ building: 'AM', view: 'overview', animate: false });
    const afterB = m.getView().building;
    await a;
    await new Promise(r => setTimeout(r, 300));
    await window.__settled();
    return { b, afterB, final: m.getView().building, view: m.getView().view };
  });
  ok = res.afterB === 'AM' && res.final === 'AM' && !errors.length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} switch race: ${JSON.stringify(res)}${errors.length ? ` errors: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
  server?.kill();
}
process.exit(ok ? 0 : 1);
