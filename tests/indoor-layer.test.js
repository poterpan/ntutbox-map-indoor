import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createIndoorLayer } from '../src/layer/index.js';
import { convertBuildings, convertFloor } from '../src/data/sources.js';
import { elevation, floorLayout, inplaceLayout, overviewIds, stackLayout } from '../src/layer/layout.js';
import { DEFAULT_PALETTE } from '../src/layer/geometry.js';

// Synthetic campus (no GIS data in this public repo): one 40 m × 20 m building "TB" with floors B1…5F in the
// published planar-cm frame. Classrooms (GIS 001) on B1, 1F and 4F; 2F, 3F and 5F only have a corridor.
const rect = (x, y, w, h) => [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
const FLOORS = ['B1', '1F', '2F', '3F', '4F', '5F'];
const buildingsDoc = {
  schema_version: 1,
  frame: { crs: 'EPSG:3826', origin: [302800, 2770400], unit: 'cm' },
  buildings: [{ id: 'TB', name: '測試大樓', short: '測試', campus: 'A', entrance: { bearing: 0 }, floors: ['5F', '1F', 'B1', '3F', '2F', '4F'], outline: [rect(0, 0, 4000, 2000)] }],
};
const ROOMS = { B1: ['B01'], '1F': ['101', '102'], '4F': ['401'] };
function floorDoc(floor) {
  const spaces = [{ id: `TB/${floor}/c`, c: '505', t: '走廊', g: [rect(0, 1500, 4000, 500)] }];
  (ROOMS[floor] || []).forEach((n, i) => spaces.push({ id: `TB/${floor}/${n}`, c: '001', n, t: '教室', g: [rect(i * 1200 + 100, 100, 1000, 1200)] }));
  spaces.push({ id: `TB/${floor}/s`, c: '503', t: '樓梯', g: [rect(3600, 100, 300, 600)] });
  // 2F: a named office (no classroom) and a storage room sharing its door number.
  if (floor === '2F') {
    spaces.push({ id: 'TB/2F/201', c: '005', n: '201', t: '學生輔導中心辦公室', te: 'Student Counseling Center', g: [rect(100, 100, 1000, 1200)] });
    spaces.push({ id: 'TB/2F/201#2', c: '005', n: '201', t: '儲藏室', g: [rect(1300, 100, 500, 500)] });
  }
  return { schema_version: 1, building: 'TB', floor, spaces };
}
function fixtureSource() {
  const campus = convertBuildings(buildingsDoc);
  return {
    frame: 'planar-cm',
    load: async () => campus,
    floor: async (id, floor) => (id === 'TB' && FLOORS.includes(floor) ? convertFloor(floorDoc(floor)) : null),
  };
}
const make = (extra = {}) => createIndoorLayer({ source: fixtureSource(), buildings: { TB: { name: '測試大樓', short: '測試', entranceBearing: 0 } }, ...extra });
const list = [
  { id: 'B1', index: 0, total: 1 }, { id: '1F', index: 1, total: 2 }, { id: '2F', index: 2, total: 0 },
  { id: '3F', index: 3, total: 0 }, { id: '4F', index: 4, total: 1 }, { id: '5F', index: 5, total: 0 },
];
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≠ ${b}`);
const run = (layer, seconds = 1) => { for (let t = 0; t < seconds; t += 1 / 60) layer.update(1 / 60); };

test('elevation: (index − index of 1F) × floorHeight + groundY, basements below ground', () => {
  close(elevation(list, '1F', { floorHeight: 3.2, groundY: 10 }), 10);
  close(elevation(list, 'B1', { floorHeight: 3.2, groundY: 10 }), 6.8);
  close(elevation(list, '4F', { floorHeight: 3.2, groundY: 0 }), 9.6);
  const noGround = [{ id: '2F', index: 0, total: 0 }, { id: '3F', index: 1, total: 4 }];
  close(elevation(noGround, '3F', { floorHeight: 3, groundY: 0 }), 0, 'without 1F the lowest overview floor stands on the ground');
  const inplace = inplaceLayout(list, { floorHeight: 3.2, groundY: 0 });
  assert.deepEqual([...inplace.keys()], FLOORS);
  close(inplace.get('5F'), 12.8);
});

test('stack layout: overview subset, skip gaps for floors without classrooms, hidden floors squeezed', () => {
  assert.deepEqual(overviewIds(list), ['B1', '1F', '4F']);
  const { y, shown, skips } = stackLayout(list, { gap: 10, skipExtra: .5 });
  assert.deepEqual(shown, ['B1', '1F', '4F']);
  close(y.get('B1'), 0); close(y.get('1F'), 10);
  close(y.get('4F'), 25, '2F–3F skipped: one slot plus skipExtra');
  assert.deepEqual(skips, [{ between: ['1F', '4F'], ids: ['2F', '3F'] }]);
  close(y.get('2F'), 15); close(y.get('3F'), 20); // interpolated between 1F and 4F
  close(y.get('5F'), 25 + 10 * .08);              // above the top shown floor: squeezed
  // A building without timetabled rooms shows every floor.
  assert.deepEqual(overviewIds(list.map(f => ({ ...f, total: 0 }))), FLOORS);
});

test('floor layout: focus at focusY, neighbours floorGap per storey', () => {
  const y = floorLayout(list, 'B1', { focusY: 0, floorGap: 3.2 });
  close(y.get('B1'), 0, 'a basement focus is lifted to focusY');
  close(y.get('1F'), 3.2); close(y.get('5F'), 16);
  const y2 = floorLayout(list, '4F', { focusY: 40, floorGap: 10 });
  close(y2.get('3F'), 30); close(y2.get('B1'), 0);
});

test('layer: load builds every floor, labels have stable ids, stack shows the overview subset', async () => {
  const layer = make({ floorHeight: 3, groundY: 1 });
  await layer.load('TB');
  assert.deepEqual(layer.floors('TB').map(f => [f.id, f.total]), [['B1', 1], ['1F', 2], ['2F', 0], ['3F', 0], ['4F', 1], ['5F', 0]]);
  close(layer.elevation('TB', 'B1'), -2);
  assert.equal(await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 8, skipExtra: .5 }), true);
  const box = layer.buildingBox('TB');
  const subset = new THREE.Box3();
  for (const id of ['B1', '1F', '4F']) subset.union(layer.floorBox('TB', id));
  assert.ok(box.equals(subset), 'stack box = union of the overview floors only');
  close(layer.floorBox('TB', '4F').min.y - layer.floorBox('TB', '1F').min.y, 12);
  layer.update(1 / 60);
  const labels = layer.labels();
  const ids = labels.map(l => l.id);
  for (const id of ['room:TB/1F/101', 'room:TB/4F/401', 'badge:TB/1F', 'badge:TB/4F', 'skip:TB/1F-4F', 'entrance:TB']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('badge:TB/2F'), 'no badge for a floor without classrooms');
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(labels.find(l => l.id === 'skip:TB/1F-4F').text, '2F–3F 沒有教室');
  assert.equal(labels.find(l => l.id === 'badge:TB/1F').opacity, 1);
  assert.equal(labels.find(l => l.id === 'room:TB/1F/101').opacity, 0, 'room labels only on the focused floor');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '1F', focusY: 5, floorGap: 3 });
  assert.deepEqual(ids, layer.labels().map(l => l.id), 'same ids after a presentation change');
  assert.equal(layer.labels().find(l => l.id === 'room:TB/1F/101').opacity, 1);
  close(layer.floorBox('TB', '1F').min.y - layer.floorBox('TB', 'B1').min.y, 3, 'floorGap between neighbours');
  close(layer.floorBox('TB', '4F').min.y - layer.floorBox('TB', '1F').min.y, 9);
  layer.dispose();
});

test('setPresentation: resolves true on landing, false when superseded; update reports motion', async () => {
  const layer = make();
  await layer.load('TB');
  const first = layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, animate: true, duration: 500 });
  assert.equal(layer.object.children[0].visible, true);
  layer.update(.1);
  const second = layer.setPresentation({ building: 'TB', mode: 'floor', floor: '4F', animate: true, duration: 300 });
  assert.equal(await first, false);
  let moving = true, frames = 0;
  while (moving && frames < 200) { moving = layer.update(1 / 60); frames++; }
  assert.equal(await second, true);
  assert.ok(frames > 15 && frames < 200, `settles (${frames} frames)`);
  assert.equal(layer.update(1 / 60), false, 'idle once landed and faded');
  assert.equal(layer.presentation.mode, 'floor');
  // Leaving: back to null hides the building after the flight.
  const leave = layer.setPresentation({ building: null, animate: true, duration: 200 });
  assert.equal(layer.object.children[0].visible, true, 'still visible while leaving');
  run(layer, .5);
  assert.equal(await leave, true);
  assert.equal(layer.object.children[0].visible, false);
  assert.deepEqual(layer.labels(), []);
  await assert.rejects(layer.setPresentation({ building: 'XX', mode: 'stack' }), /not loaded/);
  layer.dispose();
});

test('pick: a ray onto a room returns its key; stack picks the floor; empty space is null', async () => {
  const layer = make();
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '1F', focusY: 0, floorGap: 3.2 });
  layer.update(1 / 60);
  const ray = new THREE.Raycaster();
  const down = (x, z) => { ray.set(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)); return layer.pick(ray); };
  // Room 102 spans x 13–23 m, north 1–13 m → z −1…−13.
  const hit = down(18, -6);
  assert.equal(hit.kind, 'room');
  assert.equal(hit.key, 'TB/1F/102');
  assert.equal(hit.floor, '1F');
  assert.equal(down(20, -17.5).kind, 'space');
  assert.equal(down(100, 100), null);
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10 });
  const s = down(30, -17.5);
  assert.equal(s.floor, '4F', 'the top overview floor is hit first from above');
  assert.equal(layer.room('TB/1F/102').classNumber, '102');
  layer.dispose();
});

test('setOccupancy: recolours without rebuilding; a new room set rebuilds; emissive follows colour', async () => {
  const layer = make();
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '1F' });
  const roomMesh = key => { let m = null; layer.object.traverse(n => { if (n.userData?.key === key && n.isMesh) m = n; }); return m; };
  const hex = key => roomMesh(key).material[0].color.getHex();
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.unknown);
  const occ = new Map([['TB/1F/101', { status: 'free' }], ['TB/1F/102', { status: 'busy' }], ['TB/B1/B01', { status: 'soon' }], ['TB/4F/401', { status: 'free' }]]);
  assert.equal(layer.setOccupancy(occ), true, 'first real occupancy changes the room set');
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.free);
  assert.equal(hex('TB/1F/102'), DEFAULT_PALETTE.room);
  assert.equal(roomMesh('TB/1F/101').material[1].color.getHex(), DEFAULT_PALETTE.freeSide);
  const mesh = roomMesh('TB/1F/101');
  assert.equal(layer.setOccupancy(new Map([...occ, ['TB/1F/101', { status: 'soon' }]])), false, 'status-only change');
  assert.equal(roomMesh('TB/1F/101'), mesh, 'same mesh, not rebuilt');
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.soon);
  assert.equal(layer.room('TB/1F/101').status, 'soon');
  assert.deepEqual(layer.floors('TB').find(f => f.id === '1F'), { id: '1F', total: 2, available: 1, free: 0, unlocated: 0 });
  assert.equal(layer.labels().find(l => l.id === 'badge:TB/1F').kind, 'partial');
  layer.setEmissive(.5);
  const c = mesh.material[0].color, e = mesh.material[0].emissive;
  close(e.r, c.r * .5); close(e.g, c.g * .5);
  layer.setSelected('TB/1F/101');
  assert.notEqual(hex('TB/1F/101'), DEFAULT_PALETTE.soon, 'selection tints');
  layer.setSelected(null);
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.soon);
  layer.dispose();
});

test('dispose frees every geometry and material and detaches the group', async () => {
  const layer = make();
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '4F' });
  layer.setSelected('TB/4F/401');
  const scene = new THREE.Scene();
  scene.add(layer.object);
  const geometries = new Set(), materials = new Set();
  layer.object.traverse(n => { if (n.geometry) geometries.add(n.geometry); for (const m of [].concat(n.material || [])) materials.add(m); });
  assert.ok(geometries.size > 20);
  let g = 0, m = 0;
  geometries.forEach(x => x.addEventListener('dispose', () => g++));
  materials.forEach(x => x.addEventListener('dispose', () => m++));
  layer.dispose();
  assert.equal(g, geometries.size);
  assert.equal(m, materials.size);
  assert.equal(layer.object.parent, null);
  assert.equal(layer.object.children.length, 0);
  assert.equal(await layer.setPresentation({ building: null }), false);
});

test('stackFloors all: every floor in the overview, no skip markers, badges from badgeText (null hides)', async () => {
  assert.deepEqual(overviewIds(list, { all: true }), FLOORS);
  const { y, skips } = stackLayout(list, { gap: 10, all: true });
  assert.deepEqual(skips, []);
  close(y.get('5F'), 50);
  const layer = make({ stackFloors: 'all', badgeText: f => (f.id === '3F' ? null : f.id) });
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 8 });
  layer.update(1 / 60);
  const labels = layer.labels();
  assert.ok(!labels.some(l => l.role === 'skip'), 'no skip markers');
  assert.equal(labels.find(l => l.id === 'badge:TB/2F').text, '2F', 'floors without classrooms get a badge');
  assert.equal(labels.find(l => l.id === 'badge:TB/2F').opacity, 1);
  assert.equal(labels.find(l => l.id === 'badge:TB/3F').opacity, 0, 'badgeText null: no badge');
  const box = new THREE.Box3();
  for (const id of FLOORS) box.union(layer.floorBox('TB', id));
  assert.ok(layer.buildingBox('TB').equals(box), 'stack box spans every floor');
  close(layer.floorBox('TB', '5F').min.y - layer.floorBox('TB', 'B1').min.y, 40);
  assert.throws(() => make({ stackFloors: 'some' }), /stackFloors/);
  layer.dispose();
});

test('SpaceInfo: keys, space(), spaces(); default selectable = classrooms only', async () => {
  const layer = make();
  await layer.load('TB');
  const office = layer.space('TB/2F/201');
  assert.equal(office.type, '學生輔導中心辦公室');
  assert.equal(office.typeEn, 'Student Counseling Center');
  assert.equal(office.number, '201');
  assert.equal(office.category, '005');
  assert.equal(office.cls, 'service');
  assert.equal(office.selectable, false);
  assert.equal(layer.space('TB/2F/201#2').type, '儲藏室', 'a second space with the same number keeps its GIS id');
  assert.equal(layer.space('TB/1F/101').selectable, true);
  const all = layer.spaces('TB');
  assert.equal(new Set(all.map(s => s.key)).size, all.length);
  assert.ok(all.some(s => s.key === 'TB/2F/c' && s.cls === 'corridor'));
  assert.deepEqual(layer.spaces('XX'), []);
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '2F', focusY: 0, floorGap: 3.2 });
  layer.update(1 / 60);
  const ray = new THREE.Raycaster();
  ray.set(new THREE.Vector3(6, 50, -6), new THREE.Vector3(0, -1, 0));
  const hit = layer.pick(ray);
  assert.equal(hit.kind, 'space', 'not selectable by default');
  assert.equal(hit.space.key, 'TB/2F/201');
  layer.dispose();
});

test('host hooks: selectable, spaceClass, spaceLabel make a named office a room with a label and card data', async () => {
  const layer = make({
    stackFloors: 'all',
    selectable: s => s.cls === 'classroom' || (s.type && !/儲藏|走廊|樓梯/.test(s.type)),
    spaceClass: s => (s.cls === 'service' && s.type !== '儲藏室' ? 'room' : null),
    spaceLabel: s => (s.cls === 'classroom' ? { text: s.number } : s.selectable ? { text: s.type, priority: 2.7, kind: 'place', fadeIn: [4, 6] } : null),
  });
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '2F', focusY: 0, floorGap: 3.2 });
  layer.update(1 / 60);
  const ray = new THREE.Raycaster();
  ray.set(new THREE.Vector3(6, 50, -6), new THREE.Vector3(0, -1, 0));
  const hit = layer.pick(ray);
  assert.equal(hit.kind, 'room');
  assert.equal(hit.key, 'TB/2F/201');
  assert.equal(hit.cls, 'room');
  assert.equal(hit.space.type, '學生輔導中心辦公室');
  assert.equal(hit.object.material[0].color.getHex(), DEFAULT_PALETTE.place);
  assert.ok(layer.roomBox('TB/2F/201'));
  layer.setSelected('TB/2F/201');
  assert.notEqual(hit.object.material[0].color.getHex(), DEFAULT_PALETTE.place, 'selection tints');
  layer.setSelected(null);
  assert.equal(hit.object.material[0].color.getHex(), DEFAULT_PALETTE.place, 'and restores the place colour');
  const labels = layer.labels();
  const office = labels.find(l => l.id === 'room:TB/2F/201');
  assert.equal(office.text, '學生輔導中心辦公室');
  assert.equal(office.kind, 'place');
  assert.equal(office.priority, 2.7);
  assert.deepEqual(office.fadeIn, [4, 6]);
  assert.equal(office.opacity, 1);
  assert.ok(!labels.some(l => l.text === '樓梯'), 'spaceLabel replaces the default labels');
  assert.equal(labels.find(l => l.id === 'room:TB/1F/101').kind, 'unknown', 'classrooms keep their status kind');
  // Occupancy still recolours classrooms and leaves the office alone.
  layer.setOccupancy(new Map([['TB/1F/101', { status: 'free' }], ['TB/1F/102', { status: 'busy' }], ['TB/B1/B01', { status: 'busy' }], ['TB/4F/401', { status: 'busy' }]]));
  assert.equal(layer.labels().find(l => l.id === 'room:TB/1F/101').kind, 'free');
  assert.equal(layer.labels().find(l => l.id === 'room:TB/2F/201').kind, 'place');
  layer.dispose();
});
