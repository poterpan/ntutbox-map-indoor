import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campusModelSource } from '../src/data/models.js';

const BASE = 'https://models.example/models/v1';
const manifest = { schema_version: 1, crs: 'EPSG:3826', buildings: { A3T: { centroidEN: [302900, 2770500], file: 'A3T.0123456789ab.glb' } } };

function server({ expiresIn = 600, rejectFirst = false } = {}) {
  let clock = 1_800_000_000, minted = 0, rejected = false;
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization ?? null });
    const reply = (status, body, bytes) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => bytes });
    if (url === '/api/model-token') {
      minted++;
      return reply(200, { token: `tok${minted}`, expiresAt: clock + expiresIn, base: BASE });
    }
    if (rejectFirst && !rejected) { rejected = true; return reply(401, {}); }
    if (!init.headers?.Authorization) return reply(401, {});
    const rel = url.slice(BASE.length + 1);
    if (rel === 'current.json') return reply(200, { schema_version: 1, manifest: 'manifest.aaaaaaaaaaaa.json' });
    if (rel === 'manifest.aaaaaaaaaaaa.json') return reply(200, manifest);
    if (rel === 'A3T.0123456789ab.glb') return reply(200, null, new ArrayBuffer(8));
    return reply(404, {});
  };
  return { fetch, calls, now: () => clock, tick: s => { clock += s; }, minted: () => minted };
}

test('loads the manifest and a GLB with one token', async () => {
  const s = server();
  const src = campusModelSource({ fetch: s.fetch, now: s.now });
  assert.deepEqual(await src.load(), manifest);
  assert.equal((await src.glb('A3T')).byteLength, 8);
  assert.equal(await src.glb('A3T'), await src.glb('A3T')); // memoised
  assert.equal(s.minted(), 1);
  assert.ok(s.calls.filter(c => c.url.startsWith(BASE)).every(c => c.auth === 'Bearer tok1'));
});

test('refreshes a token that is about to expire', async () => {
  const s = server();
  const src = campusModelSource({ fetch: s.fetch, now: s.now });
  await src.load();
  s.tick(560); // inside the 60 s refresh margin
  await src.glb('A3T');
  assert.equal(s.minted(), 2);
});

test('retries once with a fresh token after a 401', async () => {
  const s = server({ rejectFirst: true });
  const src = campusModelSource({ fetch: s.fetch, now: s.now });
  await src.load();
  assert.equal(s.minted(), 2);
});

test('rejects unknown buildings, schemas and frames', async () => {
  const s = server();
  const src = campusModelSource({ fetch: s.fetch, now: s.now });
  await assert.rejects(src.glb('ZZ'), /no model for ZZ/);
  const bad = campusModelSource({ fetch: async url => url === '/api/model-token'
    ? { ok: true, json: async () => ({ token: 't', expiresAt: 2e9, base: BASE }) }
    : { ok: true, json: async () => ({ schema_version: 2, manifest: 'x' }) } });
  await assert.rejects(bad.load(), /schema 2/);
});

test('a refused token surfaces as an error and is not cached', async () => {
  let n = 0;
  const src = campusModelSource({ fetch: async () => (n++ === 0 ? { ok: false, status: 503 } : { ok: false, status: 404 }) });
  await assert.rejects(src.load(), /model token 503/);
  await assert.rejects(src.load(), /model token 404/);
});

test('a device clock far ahead of the server does not loop on refresh', async () => {
  const s = server();
  let minted = 0;
  const fetch = async (url, init) => {
    if (url === '/api/model-token') minted++;
    return s.fetch(url, init);
  };
  // server clock 1.8e9, device clock an hour ahead: expiresAt already looks past
  const src = campusModelSource({ fetch, now: () => s.now() + 3600 });
  await src.load();
  await src.glb('A3T');
  assert.equal(minted, 1);
});
