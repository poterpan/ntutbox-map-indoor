// Downloads the published campus data chain into .cache/campus-v1/ (gitignored), preserving CDN paths:
// current.json -> manifest -> buildings + every indoor/<B>/<F>.json. Dev server serves it with CAMPUS_DATA=cache.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CAMPUS_CDN || 'https://cdn.ntutbox.com/campus/v1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'campus-v1');
// A normal app UA: the CDN blocks crawler-looking ones.
const headers = { 'User-Agent': 'NTUTBox-map-indoor-dev/1.0 (visual-regression snapshot)' };

async function get(rel) {
  const res = await fetch(`${BASE}/${rel}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${rel}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf;
}

const current = JSON.parse(await get('current.json'));
const manifest = JSON.parse(await get(current.manifest));
const wanted = Object.entries(manifest.files).filter(([k]) => k === 'buildings.json' || k.startsWith('indoor/'));
let n = 0;
for (let i = 0; i < wanted.length; i += 8) {
  await Promise.all(wanted.slice(i, i + 8).map(([, e]) => get(e.path).then(() => n++)));
}
console.log(`campus-v1 revision ${current.revision}: current.json + manifest + ${n} files -> ${OUT}`);
