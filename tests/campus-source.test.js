import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campusCdnSource, convertFloor, convertBuildings } from '../src/data/sources.js';

const BASE = 'https://cdn.example/campus/v1';
const square = (x, y, s = 500) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
const buildingsDoc = {
  schema_version: 1,
  frame: { crs: 'EPSG:3826', origin: [302800, 2770400], unit: 'cm' },
  buildings: [
    { id: 'A3T', name: '第三教學大樓', short: '三教', campus: 'A', entrance: { bearing: 0, verified: true }, floors: ['1F', '2F'], outline: [square(0, 0, 5000)] },
    { id: 'BI', name: '用水處理室', campus: 'A', outline: [square(9000, 0)] },
  ],
};
const floorDoc = { schema_version: 1, building: 'A3T', floor: '2F', spaces: [
  { id: 'A3T/2F/201', c: '001', n: '201', t: '教室', g: [square(0, 0, 1000)] },
  { id: 'A3T/2F/~ab12cd34', c: '030', t: '走廊', g: [square(1000, 0, 200)] },
] };

function fakeFetch(files) {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    const rel = url.slice(BASE.length + 1);
    if (!(rel in files)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(files[rel]) };
  };
  fn.calls = calls;
  return fn;
}

const published = {
  'current.json': { schema_version: 1, revision: 3, manifest: 'manifest.aaa.json', update_sequence: 1146 },
  'manifest.aaa.json': { files: {
    'buildings.json': { path: 'buildings.bbb.json' },
    'indoor/A3T/2F.json': { path: 'indoor/A3T/2F.ccc.json' },
  } },
  'buildings.bbb.json': buildingsDoc,
  'indoor/A3T/2F.ccc.json': floorDoc,
};

test('convertBuildings: index only lists indoor buildings, footprints keep every building', () => {
  const { buildingIndex, buildingsData, buildings } = convertBuildings(buildingsDoc);
  assert.deepEqual(buildingIndex.buildings.map(b => [b.buildingId, b.floorIds]), [['A3T', ['1F', '2F']]]);
  assert.deepEqual(buildingsData.features.map(f => f.properties.buildingId), ['A3T', 'BI']);
  assert.equal(buildingsData.features[0].geometry.type, 'MultiPolygon');
  assert.deepEqual(buildings.A3T, { name: '第三教學大樓', short: '三教', entranceBearing: 0, entranceConfirmed: true });
  assert.equal(buildings.BI, undefined);
});

test('convertFloor: short keys become the properties the engine reads', () => {
  const { features } = convertFloor(floorDoc);
  const room = features[0].properties;
  assert.equal(room.classNumber, '201');
  assert.equal(room.name, '教室');
  assert.equal(room.category1, '001');
  assert.equal(room.buildingId, 'A3T');
  assert.equal(room.floorId, '2F');
  assert.equal(room.areaSquareMeters, 100); // 10 m × 10 m
  assert.equal(features[1].properties.classNumber, null);
});

test('campusCdnSource follows current.json → manifest → hashed files and caches', async () => {
  const fetch = fakeFetch(published);
  const src = campusCdnSource(BASE, { fetch });
  assert.equal(src.frame, 'planar-cm');
  const loaded = await src.load();
  assert.equal(loaded.current.revision, 3);
  assert.deepEqual(Object.keys(loaded.buildings), ['A3T']);
  const floor = await src.floor('A3T', '2F');
  assert.equal(floor.features.length, 2);
  await src.floor('A3T', '2F');
  await src.load();
  assert.deepEqual(fetch.calls.map(u => u.slice(BASE.length + 1)),
    ['current.json', 'manifest.aaa.json', 'buildings.bbb.json', 'indoor/A3T/2F.ccc.json']);
});

test('campusCdnSource: a floor missing from the manifest is null, not an error', async () => {
  const src = campusCdnSource(BASE, { fetch: fakeFetch(published) });
  assert.equal(await src.floor('A3T', '1F'), null);
});

test('campusCdnSource refuses an unknown schema and lets a later load retry', async () => {
  const files = { ...published, 'current.json': { ...published['current.json'], schema_version: 2 } };
  const src = campusCdnSource(BASE, { fetch: fakeFetch(files) });
  await assert.rejects(src.load(), /schema 2/);
  files['current.json'] = published['current.json'];
  assert.equal((await src.load()).current.revision, 3);
});

test('mergeBuildings: one building with the union of floors and every member\'s spaces', async () => {
  const { mergeBuildings } = await import('../src/data/sources.js');
  const sq = (x, s = 100) => [[[x, 0], [x + s, 0], [x + s, s], [x, s], [x, 0]]];
  const feat = (b, f, n, x) => ({ type: 'Feature', properties: { spaceId: `${b}/${f}/${n}`, buildingId: b, floorId: f, classNumber: n }, geometry: { type: 'MultiPolygon', coordinates: [sq(x)] } });
  const calls = [];
  const base = {
    frame: 'planar-cm',
    load: async () => ({
      buildingIndex: { buildings: [
        { buildingId: 'D1', floorIds: ['1F', '2F', 'R1'] },
        { buildingId: 'D2', floorIds: ['B1', '1F', '2F', '3F'] },
        { buildingId: 'X', floorIds: ['1F'] },
      ] },
      buildingsData: { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { buildingId: 'D1' }, geometry: { type: 'MultiPolygon', coordinates: [sq(0, 500)] } },
        { type: 'Feature', properties: { buildingId: 'D2' }, geometry: { type: 'Polygon', coordinates: sq(1000, 500) } },
      ] },
      buildings: { D1: { name: '一' }, D2: { name: '二' }, X: { name: 'X' } },
    }),
    floor: async (b, f) => { calls.push(`${b}/${f}`); return { type: 'FeatureCollection', features: [feat(b, f, b === 'D1' ? '101' : '201', b === 'D1' ? 0 : 1000)] }; },
  };
  const src = mergeBuildings(base, { D1: ['D2'] });
  assert.equal(src.frame, 'planar-cm');
  const data = await src.load();
  assert.deepEqual(data.buildingIndex.buildings.map(b => [b.buildingId, b.floorIds]), [['D1', ['B1', '1F', '2F', '3F', 'R1']], ['X', ['1F']]]);
  assert.equal(data.buildingsData.features.find(f => f.properties.buildingId === 'D1').geometry.coordinates.length, 2);
  const f1 = await src.floor('D1', '1F');
  assert.deepEqual(f1.features.map(f => [f.properties.buildingId, f.properties.spaceId, f.properties.sourceBuildingId]),
    [['D1', 'D1/1F/101', undefined], ['D1', 'D2/1F/201', 'D2']]);
  // only members that have the floor are asked for it
  calls.length = 0;
  assert.equal((await src.floor('D1', 'R1')).features.length, 1);
  assert.equal((await src.floor('D1', 'B1')).features[0].properties.sourceBuildingId, 'D2');
  assert.deepEqual(calls, ['D1/R1', 'D2/B1']);
  // other buildings pass through
  assert.equal((await src.floor('X', '1F')).features[0].properties.buildingId, 'X');
});
