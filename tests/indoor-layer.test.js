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
const close = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} ≠ ${b}`);
const near = (a, b, msg) => close(a, b, msg, 1e-5); // float32 geometry
const run = (layer, seconds = 1) => { for (let t = 0; t < seconds; t += 1 / 60) layer.update(1 / 60); };
// Stage 3 draws a floor as a few merged meshes coloured per vertex. Colour of the drawn fill straight below
// (x, z) on one floor: the top-face vertex colour of the merged mesh the ray hits first.
const fillHit = (layer, floor, x, z) => {
  const meshes = [];
  layer.object.traverse(n => { if (n.isMesh && n.userData.floorId === floor && (n.userData.part === 'base' || n.userData.part === 'cast')) meshes.push(n); });
  layer.object.updateMatrixWorld(true);
  return new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0)).intersectObjects(meshes, false)[0];
};
const hexAt = (layer, floor, x, z) => {
  const hit = fillHit(layer, floor, x, z);
  return new THREE.Color().fromArray(hit.object.geometry.attributes.color.array, hit.face.a * 3).getHex();
};

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

test('setOccupancy: recolours vertex colours without rebuilding; a new room set rebuilds; emissive follows colour', async () => {
  const layer = make();
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '1F' });
  // Room 101 spans x 1–11 m, north 1–13 m; 102 x 13–23 m.
  const hex = key => (key === 'TB/1F/101' ? hexAt(layer, '1F', 6, -6) : hexAt(layer, '1F', 18, -6));
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.unknown);
  const occ = new Map([['TB/1F/101', { status: 'free' }], ['TB/1F/102', { status: 'busy' }], ['TB/B1/B01', { status: 'soon' }], ['TB/4F/401', { status: 'free' }]]);
  assert.equal(layer.setOccupancy(occ), true, 'first real occupancy changes the room set');
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.free);
  assert.equal(hex('TB/1F/102'), DEFAULT_PALETTE.room);
  const hit = fillHit(layer, '1F', 6, -6);
  const mesh = hit.object, attr = mesh.geometry.attributes.color;
  // A side face of room 101 carries the side colour.
  const normals = mesh.geometry.attributes.normal;
  let side = -1;
  for (let v = 0; v < normals.count; v++) {
    const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, v);
    if (Math.abs(normals.getY(v)) < .1 && p.x > .9 && p.x < 11.1 && Math.abs(p.z + 1) < .01) { side = v; break; }
  }
  assert.ok(side >= 0);
  assert.equal(new THREE.Color().fromArray(attr.array, side * 3).getHex(), DEFAULT_PALETTE.freeSide);
  attr.clearUpdateRanges();
  const version = attr.version;
  assert.equal(layer.setOccupancy(new Map([...occ, ['TB/1F/101', { status: 'soon' }]])), false, 'status-only change');
  assert.equal(fillHit(layer, '1F', 6, -6).object, mesh, 'same mesh, not rebuilt');
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.soon);
  assert.ok(attr.version > version, 'colour attribute flagged for upload');
  const updated = attr.updateRanges.reduce((n, r) => n + r.count, 0);
  assert.ok(updated > 0 && updated < attr.array.length / 2, `only room 101's vertices are uploaded (${updated} of ${attr.array.length})`);
  assert.equal(layer.room('TB/1F/101').status, 'soon');
  assert.deepEqual(layer.floors('TB').find(f => f.id === '1F'), { id: '1F', total: 2, available: 1, free: 0, unlocated: 0 });
  assert.equal(layer.labels().find(l => l.id === 'badge:TB/1F').kind, 'partial');
  // Emissive is white × k on the floor's fill materials; the shader multiplies it by the vertex colour.
  layer.setEmissive(.5);
  close(mesh.material.emissive.r, .5); close(mesh.material.emissive.b, .5);
  assert.ok(mesh.material.vertexColors);
  const shader = { fragmentShader: '#include <emissivemap_fragment>' };
  mesh.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /totalEmissiveRadiance \*= vColor\.rgb/);
  layer.setSelected('TB/1F/101');
  assert.notEqual(hex('TB/1F/101'), DEFAULT_PALETTE.soon, 'selection tints');
  assert.equal(hex('TB/1F/102'), DEFAULT_PALETTE.room, 'other rooms untouched');
  layer.setHovered('TB/1F/102');
  assert.notEqual(hex('TB/1F/102'), DEFAULT_PALETTE.room, 'hover tints');
  layer.setHovered(null);
  layer.setSelected(null);
  assert.equal(hex('TB/1F/101'), DEFAULT_PALETTE.soon);
  assert.equal(hex('TB/1F/102'), DEFAULT_PALETTE.room);
  layer.dispose();
});

test('merged geometry: a few draw objects per floor, pick proxy maps triangles back to spaces, walls grow by scale', async () => {
  const layer = make({ stackFloors: 'all' });
  await layer.load('TB');
  const drawn = floor => { const n = []; layer.object.traverse(o => { if ((o.isMesh || o.isLine) && o.visible && o.userData.floorId === floor && !o.userData.proxy) n.push(o.userData.part ?? o.type); }); return n; };
  assert.deepEqual(drawn('1F').sort(), ['base', 'cast', 'edges', 'spaceEdges', 'walls'].sort(), 'one object per bucket');
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '1F', focusY: 0, floorGap: 3.2 });
  run(layer, 1);
  const ray = new THREE.Raycaster();
  const down = (x, z) => { ray.set(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)); return layer.pick(ray); };
  // Every point maps to the space under it, through the proxy's triangle → piece table.
  assert.equal(down(2, -2).key, 'TB/1F/101');
  assert.equal(down(10.5, -12.5).key, 'TB/1F/101');
  assert.equal(down(14, -2).key, 'TB/1F/102');
  const corridor = down(30, -17.5);
  assert.equal(corridor.kind, 'space');
  assert.equal(corridor.cls, 'corridor');
  assert.equal(corridor.space.key, 'TB/1F/c');
  const stair = down(37.5, -4);
  assert.equal(stair.cls, 'vertical');
  assert.equal(stair.space.key, 'TB/1F/s');
  assert.equal(down(30, -8).kind, 'floor', 'bare slab');
  assert.equal(corridor.object.userData.proxy, true);
  // A wall (on the edge between 101 and the corridor side, z = −13) is hit from the side on the focused floor.
  ray.set(new THREE.Vector3(6, .6, 5), new THREE.Vector3(0, 0, -1));
  const wall = layer.pick(ray);
  assert.equal(wall.kind, 'space');
  assert.equal(wall.cls, 'wall');
  assert.equal(wall.space, null);
  near(wall.point.z, -1 + .07, 'front face of the wall on north = 1 m');
  // Walls: one merged mesh, bottom at WALL.base, scaled to full height on the focused floor, squashed elsewhere.
  let walls1F = null, walls4F = null;
  layer.object.traverse(o => { if (o.userData.part === 'walls') { if (o.userData.floorId === '1F') walls1F = o; if (o.userData.floorId === '4F') walls4F = o; } });
  close(walls1F.scale.y, 1); close(walls1F.position.y, .18);
  close(walls4F.scale.y, .2);
  near(walls1F.geometry.boundingBox.min.y, 0);
  // Stack: the selectable room or the slab; corridors fall through to the slab.
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10 });
  layer.update(1 / 60);
  ray.set(new THREE.Vector3(30, 200, -17.5), new THREE.Vector3(0, -1, 0));
  const top = layer.pick(ray);
  assert.equal(top.kind, 'floor');
  assert.equal(top.floor, '5F');
  layer.dispose();
});

test('opaque at rest: overview fills switch to opaque once landed; hosts with renderOrderBase stay transparent', async () => {
  const fills = (layer, floor) => { const m = []; layer.object.traverse(o => { if (o.isMesh && o.userData.floorId === floor && ['base', 'cast', 'walls'].includes(o.userData.part)) m.push(o.material); }); return m; };
  const layer = make();
  await layer.load('TB');
  const warm = layer.object.getObjectByName('indoor-warmup');
  assert.ok(warm && warm.material.transparent === false, 'an opaque warm-up draw compiles the opaque program at load');
  const landed = layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, animate: true, duration: 300 });
  layer.update(1 / 60);
  assert.ok(fills(layer, '1F').every(m => m.transparent), 'transparent while flying');
  run(layer, 1);
  await landed;
  assert.ok(fills(layer, '1F').every(m => !m.transparent && m.depthWrite), 'opaque at rest');
  assert.equal(layer.object.getObjectByName('indoor-warmup'), undefined, 'warm-up removed after the first frames');
  layer.setHoveredFloor('4F');
  run(layer, 1);
  assert.ok(fills(layer, '1F').every(m => m.transparent && !m.depthWrite), 'hover-faded floors are transparent again');
  assert.ok(fills(layer, '4F').every(m => !m.transparent));
  await layer.setPresentation({ building: 'TB', mode: 'floor', floor: '1F', animate: false });
  layer.update(1 / 60);
  assert.ok(fills(layer, '1F').every(m => m.transparent), 'the focused floor draws in the transparent pass (after its neighbours)');
  layer.dispose();
  const host = make({ renderOrderBase: 10 });
  await host.load('TB');
  assert.equal(host.object.getObjectByName('indoor-warmup'), undefined);
  await host.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10 });
  run(host, .2);
  assert.ok(fills(host, '1F').every(m => m.transparent));
  host.dispose();
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
  assert.equal(hexAt(layer, '2F', 6, -6), DEFAULT_PALETTE.place);
  const box = layer.roomBox('TB/2F/201');
  near(box.min.x, 1); near(box.max.x, 11); near(box.min.y, .1); near(box.max.y, .17);
  layer.setSelected('TB/2F/201');
  assert.notEqual(hexAt(layer, '2F', 6, -6), DEFAULT_PALETTE.place, 'selection tints');
  layer.setSelected(null);
  assert.equal(hexAt(layer, '2F', 6, -6), DEFAULT_PALETTE.place, 'and restores the place colour');
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

// Tall buildings (docs/LAYER.md「高樓」): host grouping collapses runs into compact entries; a window scrolls.
const noClassrooms = floors => {
  const out = [];
  let run = null;
  for (const f of floors) {
    if (f.spaces.some(s => s.selectable)) { run = null; out.push(f.id); } else if (run) run.push(f.id); else { run = [f.id]; out.push(run); }
  }
  return out;
};

test('stackFloors grouping: collapsed runs are compact entries drawn by their floor nearest the ground', async () => {
  const layer = make({ stackFloors: noClassrooms });
  await layer.load('TB');
  assert.deepEqual(layer.stackEntries('TB').map(e => [e.id, e.floors.join(','), e.collapsed, e.label]), [
    ['B1', 'B1', false, 'B1'], ['1F', '1F', false, '1F'], ['2F', '2F,3F', true, '2F–3F'], ['4F', '4F', false, '4F'], ['5F', '5F', true, '5F'],
  ]);
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10 });
  layer.update(1 / 60);
  const base = id => layer.floorBox('TB', id).min.y - layer.floorBox('TB', 'B1').min.y;
  close(base('1F'), 10);
  close(base('2F'), 17.5, 'a collapsed entry takes half a slot');
  close(base('4F'), 25);
  close(base('5F'), 32.5);
  close(base('3F'), 21.25, 'a hidden member sits between its neighbours');
  const labels = layer.labels();
  const badge = labels.find(l => l.id === 'badge:TB/2F');
  assert.equal(badge.text, '2F–3F');
  assert.match(badge.kind, /collapsed/);
  assert.deepEqual(badge.floors, ['2F', '3F']);
  assert.ok(!labels.some(l => l.id === 'badge:TB/3F'), 'one badge per entry');
  assert.equal(labels.find(l => l.id === 'more:TB/above').opacity, 0, 'no hints without a window');
  // badgeText sees the run.
  const named = make({ stackFloors: noClassrooms, badgeText: f => (f.floors ? `${f.floors[0]}~${f.floors.at(-1)}` : f.id) });
  await named.load('TB');
  await named.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10 });
  named.update(1 / 60);
  assert.equal(named.labels().find(l => l.id === 'badge:TB/2F').text, '2F~3F');
  named.dispose();
  // An invalid grouping falls back to every floor.
  const err = console.error; console.error = () => {};
  const bad = make({ stackFloors: () => ['4F', '1F'] });
  await bad.load('TB');
  console.error = err;
  assert.equal(bad.stackEntries('TB').length, 6);
  bad.dispose();
  layer.dispose();
});

test('stack window: only the window shows, its bottom entry at the base; hints count the hidden floors; fractional edges fade', async () => {
  const layer = make({ stackFloors: noClassrooms });
  await layer.load('TB');
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, stackWindow: { start: 1, size: 3 } });
  run(layer, 1);
  assert.deepEqual(layer.presentation.stackWindow, { start: 1, size: 3 });
  const y0 = layer.floorBox('TB', '1F').min.y;
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10 });
  close(layer.floorBox('TB', 'B1').min.y, y0, 'the window\'s bottom entry stands where the first entry would');
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, stackWindow: { start: 1, size: 3 } });
  run(layer, 1);
  close(layer.floorBox('TB', '2F').min.y - y0, 7.5);
  close(layer.floorBox('TB', 'B1').min.y - y0, -10, 'B1 continues below, outside the window');
  const box = new THREE.Box3();
  for (const id of ['1F', '2F', '4F']) box.union(layer.floorBox('TB', id));
  assert.ok(layer.buildingBox('TB').equals(box), 'the stack box is the window');
  const labels = layer.labels();
  const op = id => labels.find(l => l.id === id).opacity;
  assert.equal(op('badge:TB/B1'), 0); assert.equal(op('badge:TB/5F'), 0);
  assert.equal(op('badge:TB/1F'), 1); assert.equal(op('badge:TB/4F'), 1);
  assert.equal(labels.find(l => l.id === 'more:TB/below').text, '下面還有 1 層');
  assert.equal(labels.find(l => l.id === 'more:TB/above').text, '上面還有 1 層');
  assert.equal(op('more:TB/below'), 1);
  // Picking skips floors outside the window: from above, 4F is the top visible floor.
  const ray = new THREE.Raycaster(new THREE.Vector3(30, 500, -17.5), new THREE.Vector3(0, -1, 0));
  assert.equal(layer.pick(ray).floor, '4F');
  // Scroll to the top (clamped), animated: lands, B1 and 1F out, 5F in.
  assert.equal(await (async () => { const p = layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, stackWindow: { start: 9, size: 3 }, animate: true, duration: 200 }); run(layer, .5); return p; })(), true);
  assert.deepEqual(layer.presentation.stackWindow, { start: 2, size: 3 });
  const l2 = layer.labels();
  assert.equal(l2.find(l => l.id === 'more:TB/below').text, '下面還有 2 層');
  assert.equal(l2.find(l => l.id === 'more:TB/above').opacity, 0);
  assert.equal(l2.find(l => l.id === 'badge:TB/5F').opacity, 1);
  // Dragging: a fractional start fades the edge entries.
  await layer.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, stackWindow: { start: 1.5, size: 3 } });
  layer.update(1 / 60);
  const l3 = layer.labels();
  close(l3.find(l => l.id === 'badge:TB/1F').opacity, .5);
  close(l3.find(l => l.id === 'badge:TB/5F').opacity, .5);
  close(layer.floorBox('TB', '1F').min.y - y0, -3.75, 'slid half an entry down');
  // The classrooms default ignores windows.
  const plain = make();
  await plain.load('TB');
  await plain.setPresentation({ building: 'TB', mode: 'stack', stackGap: 10, stackWindow: { start: 1, size: 2 } });
  assert.equal(plain.presentation.stackWindow, null);
  plain.dispose();
  layer.dispose();
});
