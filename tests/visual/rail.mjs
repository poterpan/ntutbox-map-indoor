// Usage: node tests/visual/rail.mjs [outDir] [--url http://localhost:3300]
// Floor rail and compass of the viewer at fixed container sizes: the course site's real panes (620×640 desktop,
// 358×478 phone, both compact) and a large container (1000×760). For A3T, CB and AM on a single floor it checks:
// buttons never squeeze (height ≥ 28 compact / 36 full), the rail stays within the container, 全部 can be reached,
// the active floor is scrolled into view, with a mock full-width bottom sheet (?sheet=) the rail and compass stay above it,
// (scrolling the rail to the top shows it), the rail does not overlap the compass, and .compact follows the
// container size. Starts vite on 3300 with CAMPUS_DATA=cache unless --url. Exit 1 on any failure.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1]; };
const outArg = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const outDir = outArg ? resolve(outArg) : null;
let base = flag('url'), server = null;
if (!base) {
  server = spawn('npx', ['vite', '--port', '3300', '--strictPort'], { env: { ...process.env, CAMPUS_DATA: 'cache' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { server.stdout.on('data', d => { if (/Local:/.test(String(d))) ok(); }); setTimeout(() => fail(new Error('vite start timeout')), 30000); });
  base = 'http://localhost:3300';
}
if (outDir) await mkdir(outDir, { recursive: true });
const PANES = {
  'desktop-620x640': { w: 620, h: 640, compact: true, vp: { viewport: { width: 1280, height: 800 } } },
  'phone-358x478': { w: 358, h: 478, compact: true, vp: { viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  'large-1000x760': { w: 1000, h: 760, compact: false, vp: { viewport: { width: 1280, height: 800 } } },
  // A full-width bottom sheet over the phone pane (the course site's panel at peek / half height)
  'phone-358x478-sheet150': { w: 358, h: 478, compact: true, sheet: 150, vp: { viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  'phone-358x478-sheet239': { w: 358, h: 478, compact: true, sheet: 239, vp: { viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
};
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
try {
  for (const [pane, P] of Object.entries(PANES)) for (const [bid, floor] of P.sheet ? [['A3T', 'B1'], ['CB', 'B1'], ['AM', '2F']] : [['A3T', '4F'], ['CB', '4F'], ['AM', '7F']]) {
    const ctx = await browser.newContext({ ...P.vp, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}/?fixture=1&day=3&period=3&static=1&models=0&building=${bid}&view=overview${P.sheet ? `&sheet=${P.sheet}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__map && window.__settled, null, { timeout: 60000 });
    await page.addStyleTag({ content: `#scene { inset: auto !important; left: 0 !important; top: 0 !important; width: ${P.w}px !important; height: ${P.h}px !important; }` });
    await page.evaluate(() => window.__settled());
    await page.evaluate(async ([b, f]) => { await window.__map.setView({ building: b, view: 'floor', floor: f, animate: false }); await window.__settled(); }, [bid, floor]);
    const m = await page.evaluate((sheet) => {
      const root = document.querySelector('.indoor-map'), rail = root.querySelector('.floor-rail'), comp = root.querySelector('.compass');
      const c = root.getBoundingClientRect(), r = rail.getBoundingClientRect(), cr = comp.getBoundingClientRect();
      const btns = [...rail.querySelectorAll('.floor-button')];
      { const a = rail.querySelector('.floor-button.active').getBoundingClientRect(), rr = rail.getBoundingClientRect(); window.__activeVisible = a.top >= rr.top - 0.5 && a.bottom <= rr.bottom + 0.5; }
      const minH = Math.min(...btns.map(b => b.getBoundingClientRect().height));
      rail.scrollTop = 0;
      const all = rail.querySelector('.floor-button.all').getBoundingClientRect();
      const allVisible = all.top >= r.top - 1 && all.bottom <= r.bottom + 1;
      const compVisible = getComputedStyle(comp).opacity !== '0';
      // The active floor (re-measured after the rail was scrolled to the top above) must be revealed on render:
      const act = rail.querySelector('.floor-button.active');
      const coverTop = c.bottom - (sheet || 0);
      return {
        aboveSheet: !sheet || (r.bottom <= coverTop + 0.5 && (!compVisible || cr.bottom <= coverTop + 0.5)),
        activeVisibleOnRender: window.__activeVisible ?? null,
        compact: root.classList.contains('compact'), rail: [Math.round(r.width), Math.round(r.height)], minButtonH: Math.round(minH),
        inside: r.top >= c.top && r.bottom <= c.bottom && r.right <= c.right, allVisible, scrolls: rail.scrollHeight > rail.clientHeight + 1,
        overlapCompass: compVisible && r.bottom > cr.top && r.top < cr.bottom && r.right > cr.left && r.left < cr.right,
      };
    }, P.sheet || 0);
    const ok = m.aboveSheet && m.activeVisibleOnRender !== false && m.compact === P.compact && m.minButtonH >= (P.compact ? 28 : 36) && m.inside && m.allVisible && !m.overlapCompass;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${pane} ${bid} ${floor} ${JSON.stringify(m)}`);
    if (outDir) await page.locator('#scene').screenshot({ path: join(outDir, `rail-${pane}-${bid}.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
