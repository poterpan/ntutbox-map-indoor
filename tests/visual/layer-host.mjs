// Usage: node tests/visual/layer-host.mjs <outDir> [--url http://localhost:3100] [--building A3T] [--floor 2F]
// Screenshots the IndoorLayer host harness (dev/layer.html) in its inplace, stack and floor presentations,
// plus a picked room. Starts vite on port 3100 with CAMPUS_DATA=cache unless --url is given.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1]; };
const outDir = resolve(args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? 'visual-out/host');
const building = flag('building') || 'A3T';
const floorArg = flag('floor');
const PORT = 3100;
let base = flag('url');

async function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { env: { ...process.env, CAMPUS_DATA: 'cache' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout.on('data', d => { if (/Local:/.test(String(d))) ok(); });
    proc.on('exit', c => fail(new Error(`vite exited ${c}`)));
    setTimeout(() => fail(new Error('vite start timeout')), 30000);
  });
  base = `http://localhost:${PORT}`;
  return proc;
}

const server = base ? null : await startServer();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
await mkdir(outDir, { recursive: true });
let failed = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/dev/layer.html?building=${building}${floorArg ? `&floor=${floorArg}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__harnessReady, null, { timeout: 30000 });
  const shot = async name => {
    await page.waitForTimeout(300);
    await writeFile(join(outDir, `host-${name}.png`), await page.screenshot({ animations: 'disabled' }));
    console.log(`ok   host-${name}`);
  };
  await shot('inplace');
  if (!(await page.evaluate(() => window.__harness.go('stack')))) throw new Error('stack did not land');
  await shot('stack');
  if (!(await page.evaluate(() => window.__harness.go('floor')))) throw new Error('floor did not land');
  await shot('floor');
  // Pick the room under the centre of the largest room label's position and select it.
  const picked = await page.evaluate(async () => {
    const { layer } = window.__harness;
    const room = layer.labels().filter(l => l.role === 'room' && l.key && l.opacity > .5).sort((a, b) => b.priority - a.priority)[0];
    if (!room) return null;
    await window.__harness.select(room.key);
    return room.key;
  });
  if (picked) await shot('floor-selected');
  if (errors.length) { failed++; console.error(`page errors: ${errors.join('; ')}`); }
  await ctx.close();
} catch (e) {
  failed++;
  console.error(`FAIL ${e.message}`);
} finally {
  await browser.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
