// Usage: node tests/visual/compare.mjs <baselineDir> <candidateDir> [--threshold 0.1] [--diff <dir>]
// Pixel diff of same-named PNGs. Mismatch % = differing pixels / total. Exits 1 above threshold, on size change or missing file.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (pos.length < 2) { console.error('usage: compare.mjs <baselineDir> <candidateDir> [--threshold %] [--diff dir]'); process.exit(2); }
const [a, b] = pos.map(p => resolve(p));
const threshold = Number(flag('threshold', 0.1));
const diffDir = resolve(flag('diff', join(b, 'diff')));
mkdirSync(diffDir, { recursive: true });

const list = d => new Set(readdirSync(d).filter(f => f.endsWith('.png')));
const A = list(a), B = list(b);
let bad = 0, worst = 0;
for (const f of [...new Set([...A, ...B])].sort()) {
  if (!A.has(f) || !B.has(f)) { console.log(`MISSING ${f} (only in ${A.has(f) ? 'baseline' : 'candidate'})`); bad++; continue; }
  const x = PNG.sync.read(readFileSync(join(a, f))), y = PNG.sync.read(readFileSync(join(b, f)));
  if (x.width !== y.width || x.height !== y.height) { console.log(`SIZE    ${f} ${x.width}x${x.height} vs ${y.width}x${y.height}`); bad++; continue; }
  const diff = new PNG({ width: x.width, height: x.height });
  const n = pixelmatch(x.data, y.data, diff.data, x.width, x.height, { threshold: 0.1 });
  const pct = n / (x.width * x.height) * 100;
  worst = Math.max(worst, pct);
  const over = pct > threshold;
  if (over) bad++;
  if (n) writeFileSync(join(diffDir, f), PNG.sync.write(diff));
  console.log(`${over ? 'DIFF   ' : 'ok     '} ${f.padEnd(40)} ${pct.toFixed(4)}% (${n} px)`);
}
console.log(`worst ${worst.toFixed(4)}%, threshold ${threshold}% -> ${bad ? `${bad} failing` : 'pass'}`);
process.exit(bad ? 1 : 0);
