// Host harness (not part of the package): proves that IndoorLayer embeds in a host's own three.js scene the
// way map.ntutbox.com will use it — Y-up perspective camera, the host's lights and fog, an on-demand render
// loop driven by layer.update(dt), picking through layer.pick and DOM labels through createLabelOverlay.
// Open /dev/layer.html?building=A3T (with `npm run dev`, or CAMPUS_DATA=cache for the offline snapshot).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createIndoorLayer, createLabelOverlay, campusCdnSource } from '../src/index.js';
import '../src/viewer/indoor-map.css';
import { parsePeriods, slotAt, buildOccupancy } from './course-occupancy.js';
import fixtureRooms from './fixtures/rooms-115-1.json';
import fixturePeriods from './fixtures/periods-115-1.json';

const params = new URLSearchParams(location.search);
const BUILDING = params.get('building') || 'A3T';
const stage = document.getElementById('stage');
const info = document.getElementById('info');
const floorSelect = document.getElementById('floor');

// ---- the host's own scene ----
const SKY = 0xdfe7ef;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 220, 700);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8d9aa8, 1.7));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 1, far: 400 });
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xcfd8cf, roughness: 1 }));
ground.position.y = -.05;
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 3000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.maxPolarAngle = .55; // near top-down orbit
controls.minPolarAngle = .15;

// ---- the indoor layer ----
const periods = parsePeriods(fixturePeriods);
const occupancy = buildOccupancy(fixtureRooms, periods, slotAt(periods, 3, '3')).map;
const source = campusCdnSource('/campus-data');
const { buildings } = await source.load();
const layer = createIndoorLayer({ source, buildings, occupancy, floorHeight: 3.2, groundY: 0, fog: true, shadows: { cast: true, receive: true } });
scene.add(layer.object);
const overlay = createLabelOverlay(document.getElementById('labels'), {
  onBadgeClick: l => go('floor', l.floor),
});
await layer.load(BUILDING);
const floors = layer.floors(BUILDING);
for (const f of floors.slice().reverse()) floorSelect.append(new Option(`${f.id}${f.total ? ` · ${f.available}/${f.total}` : ''}`, f.id));
const firstWithRooms = floors.find(f => f.total > 0)?.id ?? floors[0].id;
floorSelect.value = params.get('floor') || [...floors].sort((a, b) => b.available - a.available)[0]?.id || firstWithRooms;

// ---- on-demand loop: render only while the camera, the controls or the layer are moving ----
let raf = 0, last = performance.now(), camTween = null, idleWaiters = [];
function requestRender() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
function frame(now) {
  raf = 0;
  const dt = (now - last) / 1000;
  last = now;
  let moving = layer.update(dt);
  if (camTween) {
    const k = Math.min(1, (now - camTween.t0) / camTween.ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    controls.target.lerpVectors(camTween.from.target, camTween.to.target, e);
    camera.position.lerpVectors(camTween.from.pos, camTween.to.pos, e);
    if (k >= 1) camTween = null;
    moving = true;
  }
  controls.update();
  renderer.render(scene, camera);
  overlay.update(camera, layer.labels());
  if (moving) requestRender();
  else { const w = idleWaiters; idleWaiters = []; w.forEach(r => r()); }
}
controls.addEventListener('change', requestRender);
const idle = () => new Promise(r => { idleWaiters.push(r); requestRender(); });

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(stage);
resize();

// Frame a box from above (slightly south, so the near-top-down view still reads as 3D).
function frameBox(box, animate) {
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const fit = Math.max(size.x / camera.aspect, size.z, size.y * .8) * .5 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = fit * 1.25 + size.y * .5;
  const pos = c.clone().add(new THREE.Vector3(0, Math.cos(.38), Math.sin(.38)).multiplyScalar(dist));
  sun.target.position.copy(c);
  sun.position.copy(c).add(new THREE.Vector3(60, 120, 45));
  if (!animate) { controls.target.copy(c); camera.position.copy(pos); camTween = null; }
  else camTween = { t0: performance.now(), ms: 650, from: { target: controls.target.clone(), pos: camera.position.clone() }, to: { target: c, pos } };
  requestRender();
}

// Stack gap for a perspective view from above: about a third of the footprint's longer side.
function stackGap() {
  const pts = layer.outlinePoints(BUILDING);
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  return Math.max(8, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * .3);
}

let mode = null;
async function go(next, floor = floorSelect.value, { animate = true } = {}) {
  mode = next;
  if (next === 'floor') floorSelect.value = floor;
  document.querySelectorAll('#bar button').forEach(b => b.classList.toggle('active', b.dataset.mode === next));
  layer.setSelected(null);
  const landed = layer.setPresentation({ building: BUILDING, mode: next, floor, stackGap: stackGap(), animate });
  frameBox(next === 'floor' ? layer.floorBox(BUILDING, floor) : layer.buildingBox(BUILDING), animate);
  info.textContent = `${buildings[BUILDING]?.name ?? BUILDING} · ${next}${next === 'floor' ? ` ${floor}` : ''}`;
  const ok = await landed;
  await idle();
  return ok;
}

document.querySelectorAll('#bar button').forEach(b => b.addEventListener('click', () => go(b.dataset.mode)));
floorSelect.addEventListener('change', () => go('floor', floorSelect.value));

// Tap: rooms select (the layer's selection visual), a floor in the stack opens it.
const raycaster = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = layer.pick(raycaster);
  if (mode === 'stack' && hit) { go('floor', hit.floor); return; }
  if (hit?.kind === 'room') {
    const room = layer.room(hit.key);
    layer.setSelected(hit.key);
    info.textContent = `${room.buildingName} ${room.floorId} ${room.classNumber} · ${room.status}${room.occupancy?.freeUntil ? ` · 沒排課到 ${room.occupancy.freeUntil}` : ''}`;
  } else {
    layer.setSelected(null);
    info.textContent = hit ? `${hit.floor} ${hit.cls ?? hit.kind}` : '—';
  }
  requestRender();
});

window.__harness = { layer, go, idle, select: key => { layer.setSelected(key); requestRender(); return idle(); } };
// Start where the outdoor transition starts: the building at its real heights, then the stack.
await go('inplace', floorSelect.value, { animate: false });
window.__harnessReady = true;
