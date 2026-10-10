import * as THREE from 'three';
import { campusCdnSource } from '../data/sources.js';
import { allCoords, createProjector, geoBounds } from '../data/frame.js';
import { DEFAULT_BUILDINGS, loadCampus, toOccupancyMap } from '../data/indoor.js';
import { createIndoorLayer } from '../layer/indoor-layer.js';
import { centroidOfGeometry, extrudeUp, materialPair, ringsFromGeometry, shapeFromRings } from '../layer/geometry.js';
import { createLabelOverlay, defaultLabelClass } from '../overlay/label-overlay.js';

// Standalone indoor map viewer. One instance per container:
//   const map = createIndoorMap(el, { source, buildings, onViewChange, onRoomSelect, … });
//   source: src/data/sources.js. Defaults to the published campus data (campusCdnSource).
//   map.setOccupancy(…); map.setView({ building, view, floor }); map.destroy();
// The viewer owns the renderer, the orthographic camera rig, gestures, the floor rail, the compass, lights
// and the campus white model. The indoor floors are an IndoorLayer (src/layer) and the in-canvas labels a
// label overlay (src/overlay); the viewer only decides what they present. Everything else (titles, legend,
// building picker, room sheet, campus card) belongs to the host and is driven by callbacks.
// The reasoning behind the interaction model and its constants is in docs/DESIGN.md; the split in docs/LAYER.md.

// Campus <-> building flight: the selected white block dissolves while its floors appear at their real
// heights (`CAMPUS_FLOOR_HEIGHT` per storey) and then spread into the overview stack.
const CAMPUS_FLOOR_HEIGHT = 3.2;

export function createIndoorMap(container, options = {}) {
const opts = {
  source: null,
  buildings: DEFAULT_BUILDINGS,
  initialBuilding: 'A3T',
  initialView: 'overview', // 'campus' | 'overview' | 'floor'
  preload: [],             // building ids to fetch in the background
  debug: false,
  tapEmptyToExit: true,
  campusRadiusM: 250,      // campus white model: campus "A" plus indoor buildings within this radius
  getInsets: null,         // () => { top, right, bottom, left } px covered by host UI over the canvas
  models: null,            // campusModelSource(): 3D building models replacing the white model where available
  ...options,
};
const BUILDINGS = opts.buildings;
const source = opts.source ?? campusCdnSource();
// Coordinates arrive either as WGS84 degrees or as integer cm in one planar frame (source.frame).
const FRAME = source.frame ?? 'lonlat';
// Models are placed by their EPSG:3826 centroid, so they need the planar frame and its published origin.
const modelSource = opts.models ?? null;
const emit = (name, payload) => {
  try { opts[name]?.(payload); } catch (err) { console.error(`[indoor-map] ${name} handler failed`, err); }
};
// Every listener registered by the engine goes through `on`, so destroy() removes them all at once.
const ac = new AbortController();
const on = (target, type, fn, o = {}) => target.addEventListener(type, fn, { ...o, signal: ac.signal });
let destroyed = false, started = false, rafId = 0;

let buildingId = BUILDINGS[opts.initialBuilding] ? opts.initialBuilding : Object.keys(BUILDINGS)[0];

// Campus white model and stage colours; the indoor palette lives in the layer (src/layer/geometry.js).
const COLORS = {
  bg: 0xf0f2f6,
  ground: 0xe7eaf0,
  campus: 0xf8f8f8,
  campusSide: 0xd9dee6,
  selected: 0x9fc7f5,
  selectedSide: 0x70a6df,
};

// The engine draws into its own element filling the host container, so it never changes the host's
// classes or styles (the host keeps whatever position / size it gave the container).
const root = document.createElement('div');
root.className = 'indoor-map'; // styles: src/viewer/indoor-map.css (imported by the host)
container.appendChild(root);
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);

const camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 1000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.03;
root.appendChild(renderer.domElement);

// Engine-owned overlays inside the container.
const railEl = document.createElement('div');
railEl.className = 'floor-rail';
railEl.style.display = 'none';
root.appendChild(railEl);
const compassEl = document.createElement('button');
compassEl.type = 'button';
compassEl.className = 'compass hidden';
compassEl.setAttribute('aria-label', '指北針，點一下轉回正門方向');
compassEl.innerHTML = '<span class="dial"><i>▲</i><b>N</b></span>';
root.appendChild(compassEl);
// In-canvas labels: the layer's room / floor labels plus the campus building names.
let hoverFloor = null, readyFloor = null;
const overlay = createLabelOverlay(root, {
  classFor: l => {
    let c = defaultLabelClass(l);
    if (l.role === 'badge' && hoverFloor && l.floor === hoverFloor) c += ' hover';
    if (l.role === 'badge' && readyFloor === l.floor) c += ' ready';
    return c;
  },
  onBadgeClick: l => { if (currentView === 'stacked') showFloor(l.floor); },
  onBadgeHover: l => setStackHover(l ? l.floor : null),
});


// World frame (shared with the campus 3D map): Y-up metres, x = E − 302800, y = height, z = −(N − 2770400).
// North is −Z. Planar-cm sources are already relative to that origin (see project()).
const hemi = new THREE.HemisphereLight(0xffffff, 0xaeb7c4, 2.15);
// The sky colour has always come from the north (the default +Y of the former Z-up frame); kept as-is so
// the frame change is pixel-identical.
hemi.position.set(0, 0, -1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(45, 80, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -130;
sun.shadow.camera.right = 130;
sun.shadow.camera.top = 130;
sun.shadow.camera.bottom = -130;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
// Shadow-map texel grid oriented north-up, as before the frame change.
sun.shadow.camera.up.set(0, 0, -1);
scene.add(sun);

scene.add(sun.target);

// Source coordinates → ground [x, z]. A lonlat source has no published origin; it is projected around a
// fixed reference (the campus centre, set once in start()).
let LONLAT_REF = null;
const project = createProjector(FRAME, () => LONLAT_REF);

// The indoor floors of the current building: built once per building by the layer. Moving between the
// floor overview and a single floor is a layer presentation change plus a camera flight.
const layer = createIndoorLayer({
  source,
  buildings: BUILDINGS,
  occupancy: opts.occupancy,
  floorHeight: CAMPUS_FLOOR_HEIGHT,
  groundY: 0,
  shadows: { cast: true, receive: true },
  lonlatOrigin: () => LONLAT_REF,
  onError: e => emit('onError', e),
});
const campusGroup = new THREE.Group();
scene.add(layer.object, campusGroup);

let buildingIndex;
let buildingsData;
let currentFloor = null;
let currentView = 'stacked'; // 'stacked' (floor overview) | 'floor3d' (single floor) | 'campus'
// Where the map opens: the floor overview answers "which floor has room" before anything else.
const ENTRY_VIEW = { campus: 'campus', overview: 'stacked', floor: 'floor3d' }[opts.initialView] || 'stacked';
let clickTargets = []; // campus white-model blocks (the building views pick through the layer)
let selectedRoom = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// Camera rig: `heading` is the ground bearing that points to screen-up (0 = north-up),
// `tilt` is the angle away from straight top-down. Keeping screen-up aligned with the tilt
// direction is what stops the floor from rendering as a skewed parallelogram.
// For the building views the preset heading is an offset on top of the entrance heading (see
// entranceHeading), so the canonical orientation is the same on every screen and every floor.
// `overscan` (single floor): the default framing is zoomed in slightly past "whole floor visible", so the
// edges are cropped a little and people naturally try to pinch/zoom; zooming out to see the whole floor
// is always possible without leaving the floor (see floorMinZoom).
// Constants were tuned visually in the browser with ?debug (see setupDebugPanel).
const VIEW_PRESETS = {
  floor3d: { heading: 0, tilt: 0.59, pad: 0.04, overscan: 1.12 },
  stacked: { heading: 0.14, tilt: 1.22, portraitTilt: 1.05, pad: 0.04 },
  campus: { heading: 0, tilt: 0.80, pad: 0.03 },
};

const viewState = {
  target: new THREE.Vector3(),
  heading: 0,
  tilt: 0.42,
  distance: 400,
  orthoHeight: 45,
  zoom: 1,
  userAdjusted: false,
  isDragging: false,
  moved: false,
  lastX: 0,
  lastY: 0,
};

function clearGroup(group) {
  while (group.children.length) {
    const obj = group.children.pop();
    // Campus models share their geometry with the cached template (cloned into every campus build);
    // disposing it here would free buffers the next build still uses. Only their material copies go.
    const shared = !!obj.userData?.model;
    obj.traverse?.(n => {
      if (!shared) n.geometry?.dispose?.();
      if (Array.isArray(n.material)) n.material.forEach(m => m.dispose?.());
      else n.material?.dispose?.();
    });
  }
}

// Host occupancy → layer. A change in the set of rooms rebuilds the building (walls, labels) and puts the
// view back where it was; a change of statuses only recolours.
function setOccupancy(value) {
  const rebuilt = layer.setOccupancy(toOccupancyMap(value));
  if (!started || !layer.isLoaded(buildingId)) return;
  if (rebuilt) {
    const view = currentView, floor = focusFloor;
    if (view === 'floor3d' && hasFloor(floor)) showFloor(floor, { animate: false });
    else if (view === 'stacked') showOverview({ animate: false });
    else emit('onViewChange', viewInfo());
  } else {
    renderFloorRail();
    emit('onViewChange', viewInfo());
  }
  if (selectedRoom) {
    if (layer.room(selectedRoom.key)) showRoomSheet(selectedRoom.key); else hideRoomSheet();
  }
}

// ---------------------------------------------------------------------------------------------
// Building: overview (exploded floors) <-> single floor
// ---------------------------------------------------------------------------------------------

// Overview layout. The floor gap is derived from the overview camera: a floor whose extent along the
// screen-up ground direction is E, seen at tilt t, is only fully visible above the next floor when
// gap >= E·cot(t); `gapRatio` adds the white space that makes each floor read as its own card.
// Only floors with classrooms appear in the overview. Runs of floors without classrooms collapse into
// a marker ("7F–13F 沒有教室") with `skipExtra` × gap of extra gap, so a tall building still fits a phone.
// On a single floor every floor spreads back to an even, physical order (accordion-style), so the
// faint neighbours really are the floors directly above and below.
const STACK_LAYOUT = { gapRatio: 1.42, skipExtra: .45 };
// Flights between views (camera and layer presentation together).
const FOCUS_LAYOUT = { durationMs: 650 };
// Semantic zoom: zooming *in* on the overview enters the floor under the fingers/cursor; zooming *out*
// past the fitted single floor returns to the overview. Both rubber-band before they trigger.
// Single floor zoom is relative to the default (overscanned) framing. The free range starts a bit below
// "whole floor visible" (`minMargin`), so the whole floor can always be seen with room around it. Only
// past that does it rubber-band, and only a clearly deliberate pull (`exitRatio` of the minimum, after
// banding) flies back to the overview.
// The same idea chains upward: zooming out on the floor overview (`exitScale`) flies back to the campus,
// and zooming in on a campus building with indoor data flies into its overview.
const SEMANTIC_ZOOM = { enterScale: 1.32, exitScale: .7, rubber: .45, minMargin: .9, exitRatio: .85, maxZoom: 3.5 };
// Campus is a map: pan / zoom / rotate freely (pitch fixed). Entering a building is tied to how big it
// is on screen, not to gesture scale, so zooming to explore an area never drops you into a building:
//   readyFill  – a building with indoor data this large (share of the visible area) is highlighted and
//                its card appears ("準備進入");
//   enterFill  – keep zooming in until it nearly fills the view and it flies in (zoom-in only, so
//                panning across a big building at high zoom does not trigger);
//   landFill   – coming back out of a building, the campus lands centred on it at this size.
//   readyVisible – only a building that is (mostly) on screen can be "ready"; a huge neighbour that is
//                half off-screen must not steal the selection;
//   entering also requires the zoom centre (cursor / pinch midpoint) to be on that building.
// Floor overview of tall buildings: the stack is small on a phone, so the overview zooms and pans like a
// map (pitch and heading stay locked) to look at a few floors without entering any.
// Thresholds use the floor card's share of the view HEIGHT, i.e. how many floors are on screen: width
// does not work (tall stacks are height-limited, floors stay narrow; on phones width hits the pan limit).
//   readyHeight .25 ≈ three floors visible: the floor nearest the centre lights up (badge "ready");
//   enterHeight .45 ≈ one floor fills half the view: a zoom-in centred on it flies into it.
// Zooming out below 1 rubber-bands and, pulled past exitRatio, flies back to the campus.
const OVERVIEW_NAV = { maxZoom: 10, readyHeight: .25, enterHeight: .45, exitRatio: .85, panSlack: .15 };
//   Selection is about where the user is looking, not about size: a big building half off-centre must not
//   win over the small one in the middle (CB and HR did). So:
//   focusRegion – candidates must overlap this share of the view around the focus point (the zoom centre
//                 for 0.6 s after a zoom, else the centre of the visible area);
//   score       – fill × centrality (1 at the focus point, 0 half a view-diagonal away); best score wins;
//   readyGain / enterGain – small buildings never span 60 % of the view, so "zoomed this many times past
//                 the campus framing" also counts (whichever is reached first).
const CAMPUS_NAV = {
  minZoom: 1, maxZoom: 24, readyFill: .6, readyVisible: .7, enterFill: .92, landFill: .4,
  focusRegion: .3, readyGain: 8, enterGain: 14, anchorMs: 600,
};

let focusFloor = null;
let focusY = 0;                // base height of the focused floor in the single-floor layout
let presentedPortrait = null;  // stage orientation the current stack gap was computed for
let overviewHeading = 0;       // per building, set by stackParams
let campusBlend = 0; // 1 = campus white model, 0 = inside a building; tweened with the camera
let layerFlight = 0, layerFlying = false; // the layer's presentation flight (resolves on landing)
// Lon/lat bounds of the campus white model, in the source's own units (ground plane extent).
let campusBounds = null;
let campusMats = []; // { m, base, kind: 'selected' | 'other' | 'ground', mesh }
let campusBuildings = new Map(); // indoor buildingId -> { meshes, box, label, modelMats }
let campusFocus = null; // { id, via: 'tap' | 'zoom' | 'return' } – highlighted building with its card
let lastCampusBlend = null;
let campusLabels = [];
let campusBuilt = false;
let frameInfo = null;  // { crs, origin: [E, N] metres } of a planar-cm source
let campusGen = 0;     // bumped on every campus (re)build; stale model loads check it and drop out

const B = () => BUILDINGS[buildingId];

// Heading that puts the main entrance at the bottom of the screen, looking into the building.
// Entrance bearing β points from the building towards the entrance: (sin β, cos β). Screen-up must be the
// opposite direction, (-sin β, -cos β) = (-sin h, cos h)  =>  h = π - β.
function entranceHeading() {
  return Math.PI - (B().entranceBearing || 0) * Math.PI / 180;
}

// Lowest zoom allowed on a single floor without rubber-banding.
function floorMinZoom() {
  return (fittedPose?.containZoom ?? 1) * SEMANTIC_ZOOM.minMargin;
}

// Floors of the current building, bottom to top, with their timetable stats.
function floorStats() {
  return layer.floors(buildingId);
}
function hasFloor(id) {
  return !!id && floorStats().some(f => f.id === id);
}
function overviewFloorIds() {
  const all = floorStats();
  const withRooms = all.filter(f => f.total > 0).map(f => f.id);
  // A building with no timetabled rooms (行政大樓, 圖書館…) still has an overview: all of its floors.
  return withRooms.length ? withRooms : all.map(f => f.id);
}

function isPortraitStage() {
  return root.clientWidth < root.clientHeight;
}
function overviewTilt(portrait = isPortraitStage()) {
  const p = VIEW_PRESETS.stacked;
  return portrait ? p.portraitTilt : p.tilt;
}

// Stack layout for the overview camera: the floor gap that keeps every floor visible above the next at the
// overview tilt, and the screen-right ground direction the floor badges line up against.
function stackParams() {
  const portrait = presentedPortrait = isPortraitStage();
  // Entrance at the bottom (plan A), plus the overview's slight oblique offset.
  const heading = overviewHeading = entranceHeading() + VIEW_PRESETS.stacked.heading;
  // Ground [x, z] directions of screen-up and screen-right (north is −z).
  const up = [-Math.sin(heading), -Math.cos(heading)], right = [Math.cos(heading), -Math.sin(heading)];
  const us = layer.outlinePoints(buildingId).map(p => p[0] * up[0] + p[1] * up[1]);
  const uMin = Math.min(...us), uMax = Math.max(...us);
  const gap = (uMax - uMin) / Math.tan(overviewTilt(portrait)) * STACK_LAYOUT.gapRatio;
  return { gap, right };
}

// Single floor: even spacing, anchored so the lowest overview floor stays where it is in the stack.
function floorFocusY(floorId, gap) {
  const all = floorStats();
  const first = overviewFloorIds()[0];
  const base = first ? all.findIndex(f => f.id === first) : 0;
  return (all.findIndex(f => f.id === floorId) - base) * gap;
}

// mode: 'stack' | 'floor' | null (campus: the building leaves).
function present(mode, floor, animate) {
  const p = { building: null, animate, duration: FOCUS_LAYOUT.durationMs };
  if (mode) {
    const { gap, right } = stackParams();
    Object.assign(p, { building: buildingId, mode, floor, stackGap: gap, skipExtra: STACK_LAYOUT.skipExtra, screenRight: right, floorGap: gap });
    if (mode === 'floor') p.focusY = focusY = floorFocusY(floor, gap);
  }
  const gen = ++layerFlight;
  layerFlying = !!animate;
  layer.setPresentation(p).then(
    () => { if (gen === layerFlight) layerFlying = false; },
    err => { if (gen === layerFlight) layerFlying = false; console.error('[indoor-map] presentation failed', err); },
  );
}

// Every label drawn by the overlay: the layer's (room numbers, facilities, floor badges, skip markers),
// then the campus building names.
function labelList() {
  const own = layer.labels();
  if (!campusLabels.length) return own;
  const out = own.slice();
  for (const l of campusLabels) {
    l.kind = campusFocus?.id === l.building ? 'selected-building' : 'building';
    l.opacity = campusBlend;
    out.push(l);
  }
  return out;
}

// Campus white model: everything fades with the flight; the selected building dissolves first.
function updateCampusFade() {
  if (campusBlend === lastCampusBlend) return;
  lastCampusBlend = campusBlend;
  campusGroup.visible = campusBlend > .004;
  const selected = THREE.MathUtils.smoothstep(campusBlend, .55, .95);
  for (const { m, base, kind, mesh } of campusMats) {
    const k = kind === 'selected' ? selected : campusBlend;
    m.opacity = base * k;
    m.depthWrite = k > .6;
    if (mesh) mesh.castShadow = k > .6; // no shadows from buildings that are fading away
  }
}

function badgeWidth() {
  overlay.sync(labelList());
  return overlay.maxWidth(l => l.role === 'badge' || l.role === 'skip');
}

// Keep the shadow-casting light (and its shadow frustum) centred on what is being looked at.
// `y`: height of the shadow focus. The light comes from the south-east, high up.
function aimSun(center, y = 0) {
  sun.target.position.set(center.x, y, center.z);
  sun.position.set(center.x + 45, y + 80, center.z + 35);
}

function showOverview({ animate = true } = {}) {
  currentView = 'stacked';
  focusFloor = null;
  hoverFloor = null;
  endGesture(true);
  hideRoomSheet();
  present('stack', null, animate);
  const box = layer.buildingBox(buildingId);
  aimSun(box.getCenter(new THREE.Vector3()), 0);
  updateChrome();
  goToPose(computeFit(box, 'stacked', { leftExtra: badgeWidth() + 4 }), animate, { locked: animate });
}

function showFloor(floorId, { animate = true } = {}) {
  if (!hasFloor(floorId)) return;
  currentView = 'floor3d';
  focusFloor = currentFloor = floorId;
  hoverFloor = null;
  endGesture(true);
  hideRoomSheet();
  present('floor', floorId, animate);
  const box = layer.floorBox(buildingId, floorId);
  aimSun(box.getCenter(new THREE.Vector3()), focusY);
  updateChrome();
  goToPose(computeFit(box, 'floor3d'), animate, { locked: animate });
}

// Hovering (or pressing, on touch) a floor in the overview keeps it solid and fades the others.
function setStackHover(floorId) {
  if (currentView !== 'stacked' || floorId === hoverFloor) return;
  hoverFloor = floorId;
  layer.setHoveredFloor(floorId);
  renderer.domElement.style.cursor = floorId ? 'pointer' : '';
}

async function switchBuilding(id, { view = 'stacked', floor = null } = {}) { // view: 'stacked' | 'floor3d' | 'keep'
  if (!BUILDINGS[id] || destroyed) return;
  try {
    await layer.load(id);
  } catch (error) {
    emit('onError', { type: 'building-load-failed', building: id, error });
    return;
  }
  if (destroyed) return;
  const previous = buildingId;
  buildingId = id;
  // One building at a time, as before the layer split: the previous one's geometry is freed (its floor
  // data stays cached in the layer).
  if (previous !== id) layer.unload(previous);
  // Campus is rebuilt so the dissolving block is the new building.
  clearGroup(campusGroup); campusLabels = []; campusMats = []; campusBuildings = new Map(); campusBuilt = false; lastCampusBlend = null; campusGen++;
  if (view === 'keep') {
    if (currentView === 'campus') { buildCampus(); clickTargets = campusClickTargets(); updateChrome(); }
    return;
  }
  if (view === 'floor3d') showFloor(floor && hasFloor(floor) ? floor : defaultFloorId(), { animate: false });
  else showOverview({ animate: false });
}

// Floor to open when none is asked for: the one with the most rooms free per the timetable.
function defaultFloorId() {
  let best = null, bestN = -1;
  const stats = new Map(floorStats().map(f => [f.id, f]));
  for (const id of overviewFloorIds()) {
    const n = stats.get(id).available;
    if (n > bestN) { bestN = n; best = id; }
  }
  return best || floorStats()[0]?.id;
}

// Campus -> building: switch the data if needed, then fly into the overview.
let enteringBuilding = null;
async function enterBuildingFromCampus(id) {
  if (isFlying() || enteringBuilding) return;
  enteringBuilding = id;
  try {
    if (id !== buildingId) {
      // Normally preloaded already; if not, say so instead of looking unresponsive.
      const slow = setTimeout(() => { if (!destroyed) emit('onLoading', { building: id }); }, 150);
      await switchBuilding(id, { view: 'keep' });
      clearTimeout(slow);
    }
    if (!destroyed && currentView === 'campus') showOverview();
  } finally {
    enteringBuilding = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Campus white model (separate scene space; transition into the building is a later task)
// ---------------------------------------------------------------------------------------------

function estimateBuildingHeight(id) {
  const item = buildingIndex?.buildings?.find(b => b.buildingId === id);
  if (!item) return 10;
  const above = (item.floorIds || []).filter(f => /^\d+F$/.test(f)).map(f => +f.replace('F',''));
  return Math.max(6, (above.length ? Math.max(...above) : 2) * 3.2);
}

function createCampusBuilding(feature) {
  const id = feature.properties.buildingId;
  const selected = id === buildingId; // dissolves into its floors during a flight
  const hasIndoor = !!BUILDINGS[id];
  const entry = hasIndoor ? { meshes: [], box: new THREE.Box3(), label: null } : null;
  const h = estimateBuildingHeight(id);
  for (const rings of ringsFromGeometry(feature.geometry)) {
    const shape = shapeFromRings(rings, project);
    if (!shape) continue;
    const geom = extrudeUp(shape, { depth: h, bevelEnabled: true, bevelSize: .08, bevelThickness: .08, bevelSegments: 1 });
    const mats = materialPair(COLORS.campus, COLORS.campusSide);
    const mesh = new THREE.Mesh(geom, mats);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { building: feature, selected, height: h };
    campusGroup.add(mesh);
    if (entry) { entry.meshes.push(mesh); geom.computeBoundingBox(); entry.box.union(geom.boundingBox); }
    for (const m of mats) { m.transparent = true; campusMats.push({ m, base: 1, kind: selected ? 'selected' : 'other', mesh }); }
  }
  if (hasIndoor) {
    const c = centroidOfGeometry(feature.geometry, project).setY(h + 1.1);
    const area = Number(feature.properties.buildingAreaSquareMeters) || 0;
    // Overlay label (local = position: campus labels are already in world coordinates).
    entry.label = {
      id: `campus:${id}`, local: c, position: c, text: BUILDINGS[id].short || BUILDINGS[id].name, kind: 'building', role: 'campus',
      building: id, area, priority: 2 + Math.min(area, 20000) / 40000, opacity: 0,
    };
    campusLabels.push(entry.label);
    campusBuildings.set(id, entry);
  }
}


// Campus white model: campus "A" plus indoor buildings close to it (AM sits on campus "C", 180 m from the
// centre of A). Farther campuses (B dorms and 億光 at 330–410 m, D 隆玉 at 1.1 km) would shrink the main
// campus to nothing; those buildings are reached through the host's building picker instead.
let campusFeatureCache = null, campusBox = null;
function campusFeatures() {
  if (campusFeatureCache) return campusFeatureCache;
  const centroid = f => {
    const pts = allCoords(f.geometry);
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  };
  const a = buildingsData.features.filter(f => f.properties.campusId === 'A');
  const cs = a.map(centroid);
  const c = [cs.reduce((s, p) => s + p[0], 0) / cs.length, cs.reduce((s, p) => s + p[1], 0) / cs.length];
  const [cx, cz] = project(c);
  const near = f => {
    const [x, z] = project(centroid(f));
    return Math.hypot(x - cx, z - cz) <= opts.campusRadiusM;
  };
  return (campusFeatureCache = buildingsData.features.filter(f => f.properties.campusId === 'A' || (BUILDINGS[f.properties.buildingId] && near(f))));
}

function campusClickTargets() {
  return campusGroup.children.filter(m => m.userData.building);
}

function buildCampus() {
  const main = campusFeatures();
  main.forEach(f => createCampusBuilding(f));
  const [x0, z0] = project([campusBounds.minLon, campusBounds.minLat]);
  const [x1, z1] = project([campusBounds.maxLon, campusBounds.maxLat]);
  const groundMat = new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1, transparent: true });
  campusMats.push({ m: groundMat, base: 1, kind: 'ground' });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x1 - x0) + 35, Math.abs(z1 - z0) + 35).rotateX(-Math.PI / 2), groundMat);
  ground.position.set((x0 + x1) / 2, -.08, (z0 + z1) / 2);
  ground.receiveShadow = true;
  campusGroup.add(ground);
  campusBuilt = true;
  campusBox = null;
  lastCampusBlend = null;
  applyCampusFocusStyle();
  attachModels(++campusGen);
}

// ---- campus 3D models ----
// A building with a model keeps its white-model extrusion, hidden, as the tap target (stretched to the
// model's height), so picking, focus and entering work exactly as before. Without models — no source,
// a lonlat source, or any load failure — the white model simply stays.
const modelTemplates = new Map(); // id -> Promise<THREE.Object3D> parsed once, cloned into each campus build
const MODEL_CONCURRENCY = 3;
let gltfLoader = null;

function modelTemplate(id) {
  if (!modelTemplates.has(id)) {
    const p = (async () => {
      const [{ GLTFLoader }, buf] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        modelSource.glb(id),
      ]);
      gltfLoader ??= new GLTFLoader();
      return (await gltfLoader.parseAsync(buf, '')).scene;
    })();
    p.catch(() => modelTemplates.delete(id));
    modelTemplates.set(id, p);
  }
  return modelTemplates.get(id);
}

async function attachModels(gen) {
  if (!modelSource || FRAME !== 'planar-cm' || !frameInfo?.origin) return;
  let manifest;
  try {
    manifest = await modelSource.load();
  } catch (error) {
    if (gen === campusGen && !destroyed) emit('onModelsError', { type: 'models-unavailable', error });
    return;
  }
  if (gen !== campusGen || destroyed) return;
  if (manifest.crs !== frameInfo.crs) {
    emit('onModelsError', { type: 'models-frame-mismatch', error: new Error(`${manifest.crs} ≠ ${frameInfo.crs}`) });
    return;
  }
  // Nearest the campus centre first: the middle of the view fills in before the edges.
  const ids = [...new Set(campusFeatures().map(f => f.properties.buildingId))].filter(id => manifest.buildings[id]);
  const dist = id => {
    const [x, z] = modelPosition(manifest.buildings[id].centroidEN);
    const [cx, cz] = campusCenter();
    return Math.hypot(x - cx, z - cz) - (id === campusFocus?.id ? 1e6 : 0);
  };
  ids.sort((a, b) => dist(a) - dist(b));
  let loaded = 0;
  const failed = [];
  const worker = async () => {
    for (let id; (id = ids.shift());) {
      try {
        const template = await modelTemplate(id);
        if (gen !== campusGen || destroyed) return;
        placeModel(id, template, manifest.buildings[id]);
        loaded++;
      } catch (error) {
        failed.push(id);
        console.warn(`[indoor-map] model ${id} failed; keeping the white model`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: MODEL_CONCURRENCY }, worker));
  if (gen !== campusGen || destroyed) return;
  if (failed.length) emit('onModelsError', { type: 'model-failed', buildings: failed });
  emit('onModelsLoaded', { loaded, failed });
}

// EPSG:3826 metres → world [x, z], through the same projection as every footprint.
function modelPosition([e, n]) {
  return project([(e - frameInfo.origin[0]) * 100, (n - frameInfo.origin[1]) * 100]);
}
// Ground [x, z] of the campus white model's centre.
function campusCenter() {
  return project([(campusBounds.minLon + campusBounds.maxLon) / 2, (campusBounds.minLat + campusBounds.maxLat) / 2]);
}

function placeModel(id, template, entry) {
  const model = template.clone(true); // glTF is Y-up (x east, y up, z south), the same frame as the world
  const wrap = new THREE.Group();
  wrap.add(model);
  const [x, z] = modelPosition(entry.centroidEN);
  wrap.position.set(x, 0, z);
  wrap.userData = { model: id };
  const kind = id === buildingId ? 'selected' : 'other';
  const own = new Map(); // shared glTF material -> this building's copy (fades and highlights per building)
  const modelMats = [];
  model.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = true; node.receiveShadow = true;
    const copy = m => {
      if (!own.has(m)) {
        const c = m.clone();
        c.transparent = true;
        own.set(m, c);
        campusMats.push({ m: c, base: c.opacity, kind, mesh: node });
        modelMats.push({ m: c, emissive: c.emissive?.getHex() ?? 0, intensity: c.emissiveIntensity ?? 1 });
      }
      return own.get(m);
    };
    node.material = Array.isArray(node.material) ? node.material.map(copy) : copy(node.material);
  });
  campusGroup.add(wrap);
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap);
  const height = Math.max(1, box.max.y);
  for (const mesh of campusGroup.children) {
    if (mesh.userData.building?.properties.buildingId !== id) continue;
    mesh.visible = false;
    mesh.scale.y = height / (mesh.userData.height || height);
  }
  const indoor = campusBuildings.get(id);
  if (indoor) {
    indoor.box = box;
    indoor.fill1 = undefined; // its screen fill was measured against the white-model box
    indoor.modelMats = modelMats;
    if (indoor.label) indoor.label.local.setY(height + 1.1);
  }
  lastCampusBlend = null; // apply the current fade to the new materials
  campusBox = null;
  applyCampusFocusStyle();
}

// ---- campus focus: highlight + card ----
function setCampusFocus(focus) {
  const same = campusFocus?.id === focus?.id && campusFocus?.via === focus?.via;
  campusFocus = focus;
  // Fetch its floors while the user is still deciding, so entering does not wait on the network.
  if (focus && !same) layer.prefetch(focus.id).catch(() => { /* not indexed, or offline: entering reports it */ });
  if (!same) applyCampusFocusStyle();
}

function applyCampusFocusStyle() {
  for (const [id, entry] of campusBuildings) {
    const on = campusFocus?.id === id;
    for (const mesh of entry.meshes) {
      mesh.material[0].color.setHex(on ? COLORS.selected : COLORS.campus);
      mesh.material[1].color.setHex(on ? COLORS.selectedSide : COLORS.campusSide);
    }
    for (const { m, emissive, intensity } of entry.modelMats ?? []) {
      if (!m.emissive) continue;
      m.emissive.setHex(on ? COLORS.selected : emissive);
      m.emissiveIntensity = on ? .45 : intensity;
    }
  }
  updateCampusCard();
}

let lastFocusSig = null;
// The host shows a card for the focused campus building and calls enterBuilding(id) from it.
function updateCampusCard() {
  const show = currentView === 'campus' && !!campusFocus && campusBlend > .9;
  const sig = show ? `${campusFocus.id}/${campusFocus.via}` : '';
  if (sig === lastFocusSig) return;
  lastFocusSig = sig;
  emit('onCampusFocus', show ? { buildingId: campusFocus.id, name: BUILDINGS[campusFocus.id].name, via: campusFocus.via } : null);
}

// Screen-space footprint of a box against the visible (safe) area, in stage pixels.
//   fill    – share of the visible area it spans, clipped to the screen (max of width / height ratios)
//   visible – fraction of its own screen rect that is inside the visible area
function boxScreenMetrics(box, cam) {
  const W = root.clientWidth, H = root.clientHeight, inset = cachedInsets || safeInsets();
  const sx0 = inset.left, sx1 = W - inset.right, sy0 = inset.top, sy1 = H - inset.bottom;
  const aw = Math.max(80, sx1 - sx0), ah = Math.max(80, sy1 - sy0);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
    const px = (v.x * .5 + .5) * W, py = (-v.y * .5 + .5) * H;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  const cw = Math.max(0, Math.min(x1, sx1) - Math.max(x0, sx0)), ch = Math.max(0, Math.min(y1, sy1) - Math.max(y0, sy0));
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return {
    rect: { x0, x1, y0, y1 },
    fill: Math.max(cw / aw, ch / ah),
    width: cw / aw,
    height: ch / ah,
    visible: (cw * ch) / area,
    centerDist: Math.hypot((x0 + x1) / 2 - (sx0 + sx1) / 2, (y0 + y1) / 2 - (sy0 + sy1) / 2),
  };
}
function boxScreenFill(box, cam) {
  return boxScreenMetrics(box, cam).fill;
}

let lastCampusZoom = null;
let zoomAnchor = null; // last zoom centre on screen (cursor or pinch midpoint), client coordinates
let zoomAnchorAt = 0;
// Every frame on the campus: which building is big enough to be "ready", and whether a zoom-in centred
// on it has pushed it past the enter threshold.
// How far a building has been zoomed into, relative to the whole-campus framing.
function campusGain(entry, fill) {
  if (entry.fill1 === undefined && fittedPose && currentView === 'campus') {
    poseCamera(fitCamera, fittedPose);
    entry.fill1 = Math.max(1e-4, boxScreenFill(entry.box, fitCamera));
  }
  return entry.fill1 ? fill / entry.fill1 : 0;
}

function updateCampusReadiness() {
  if (currentView !== 'campus' || isFlying() || campusBlend < .99 || !campusBuilt) { lastCampusZoom = null; return; }
  const zoomingIn = lastCampusZoom !== null && viewState.zoom > lastCampusZoom * 1.0005;
  lastCampusZoom = viewState.zoom;

  // Focus point in canvas pixels: the zoom centre right after a zoom, otherwise the visible centre.
  const r = root.getBoundingClientRect(), inset = cachedInsets || safeInsets();
  const W = root.clientWidth, H = root.clientHeight;
  const recent = zoomAnchor && performance.now() - zoomAnchorAt < CAMPUS_NAV.anchorMs;
  const fx = recent ? zoomAnchor.x - r.left : (inset.left + W - inset.right) / 2;
  const fy = recent ? zoomAnchor.y - r.top : (inset.top + H - inset.bottom) / 2;
  const hw = (W - inset.left - inset.right) * CAMPUS_NAV.focusRegion / 2, hh = (H - inset.top - inset.bottom) * CAMPUS_NAV.focusRegion / 2;
  const halfDiag = Math.hypot(W - inset.left - inset.right, H - inset.top - inset.bottom) / 2;

  let ready = null, best = 0;
  for (const [id, entry] of campusBuildings) {
    const m = boxScreenMetrics(entry.box, camera);
    const { x0, x1, y0, y1 } = m.rect;
    if (x1 < fx - hw || x0 > fx + hw || y1 < fy - hh || y0 > fy + hh) continue; // misses the focus region
    if (m.visible < CAMPUS_NAV.readyVisible) continue;
    if (m.fill < CAMPUS_NAV.readyFill && campusGain(entry, m.fill) < CAMPUS_NAV.readyGain) continue;
    const dx = Math.max(x0 - fx, 0, fx - x1), dy = Math.max(y0 - fy, 0, fy - y1); // 0 when the focus is inside
    const score = m.fill * Math.max(0, 1 - Math.hypot(dx, dy) / halfDiag);
    if (score > best) { best = score; ready = id; }
  }
  if (ready) {
    if (campusFocus?.id !== ready || campusFocus.via === 'return') setCampusFocus({ id: ready, via: 'zoom' });
  } else if (campusFocus?.via === 'zoom') {
    setCampusFocus(null);
  }
  // Enter: only while zooming in, on the building under the zoom centre — or, when the fingers are not on
  // any building (small ones are hard to hit), on the one that is already "ready".
  if (!zoomingIn || !zoomAnchor) return;
  let id = hitTest(zoomAnchor.x, zoomAnchor.y)?.building;
  if (!campusBuildings.has(id) && campusFocus?.via === 'zoom') id = campusFocus.id;
  const entry = campusBuildings.get(id);
  if (!entry) return;
  const fill = boxScreenFill(entry.box, camera);
  if (fill >= CAMPUS_NAV.enterFill || campusGain(entry, fill) >= CAMPUS_NAV.enterGain) enterBuildingFromCampus(id);
}

function showCampus({ animate = true, land = 'building' } = {}) {
  if (!campusBuilt) buildCampus();
  const fromBuilding = currentView !== 'campus';
  currentView = 'campus';
  focusFloor = null;
  hoverFloor = null;
  endGesture(true);
  hideRoomSheet();
  const box = new THREE.Box3().setFromObject(campusGroup);
  aimSun(box.getCenter(new THREE.Vector3()), 0);
  present(null, null, animate);
  clickTargets = campusClickTargets();
  updateChrome();
  const fit = computeFit(box, 'campus');
  let pose = fit;
  const entry = campusBuildings.get(buildingId);
  if (land === 'building' && fromBuilding && entry) {
    // Land centred on the building we just left, at a size below the "ready" threshold, still selected.
    poseCamera(fitCamera, fit);
    const fill1 = boxScreenFill(entry.box, fitCamera);
    const zoom = THREE.MathUtils.clamp(CAMPUS_NAV.landFill / Math.max(fill1, 1e-3), CAMPUS_NAV.minZoom, CAMPUS_NAV.maxZoom);
    pose = { ...fit, target: entry.box.getCenter(new THREE.Vector3()).setY(0), zoom };
    setCampusFocus({ id: buildingId, via: 'return' });
  }
  goToPose(pose, animate, { locked: animate });
  fittedPose = { ...fit, target: fit.target.clone() }; // canonical: whole campus, north-up
}

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

// Pixels of the canvas covered by floating UI, so the map is framed in the visible area. The host
// reports its own overlays (getInsets); the engine adds its floor rail.
function safeInsets() {
  const host = (typeof opts.getInsets === 'function' ? opts.getInsets() : opts.insets) || {};
  const inset = { top: host.top ?? 16, right: host.right ?? 16, bottom: host.bottom ?? 16, left: host.left ?? 16 };
  if (railEl.style.display !== 'none' && railEl.children.length) {
    const stage = root.getBoundingClientRect();
    inset.right = Math.max(inset.right, stage.right - railEl.getBoundingClientRect().left + 10);
  }
  return inset;
}

function poseCamera(cam, pose) {
  const d = pose.distance;
  const sinT = Math.sin(pose.tilt), cosT = Math.cos(pose.tilt);
  // Ground direction [x, z] that should read as "up" on screen (heading 0 = north = −z).
  const ux = -Math.sin(pose.heading), uz = -Math.cos(pose.heading);
  cam.position.set(pose.target.x - ux * d * sinT, pose.target.y + d * cosT, pose.target.z - uz * d * sinT);
  cam.up.set(ux, 0, uz);
  cam.lookAt(pose.target);
  const aspect = root.clientWidth / Math.max(1, root.clientHeight);
  const h = pose.orthoHeight / pose.zoom;
  cam.top = h / 2;
  cam.bottom = -h / 2;
  cam.left = -(h * aspect) / 2;
  cam.right = (h * aspect) / 2;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

function updateCamera() {
  poseCamera(camera, viewState);
}

const fitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 4000);

// Canonical pose that frames `box` in the visible part of the stage for the given mode.
function computeFit(box, mode, { leftExtra = 0 } = {}) {
  const preset = VIEW_PRESETS[mode];
  const size = box.getSize(new THREE.Vector3());
  const W = Math.max(1, root.clientWidth), H = Math.max(1, root.clientHeight);
  const inset = safeInsets();
  inset.left += leftExtra;
  const aw = Math.max(80, W - inset.left - inset.right), ah = Math.max(80, H - inset.top - inset.bottom);
  const pose = {
    target: box.getCenter(new THREE.Vector3()),
    // Campus is north-up (= the campus main gate at the bottom); buildings face their own entrance, so a
    // flight between them turns to face it.
    heading: mode === 'stacked' ? overviewHeading : mode === 'campus' ? preset.heading : entranceHeading() + preset.heading,
    tilt: mode === 'stacked' ? overviewTilt() : preset.tilt,
    distance: viewState.distance,
    orthoHeight: 10,
    zoom: 1,
    blend: mode === 'floor3d' ? 1 : 0,
    campus: mode === 'campus' ? 1 : 0,
  };
  poseCamera(fitCamera, pose);

  // Measure the content in camera space (not world AABB) so tilt/heading never skew the fit.
  const inv = fitCamera.matrixWorldInverse;
  const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    min.min(p); max.max(p);
  }
  const w = Math.max(1, max.x - min.x), h = Math.max(1, max.y - min.y);
  const containPx = Math.min(aw / w, ah / h) * (1 - preset.pad * 2);
  const overscan = preset.overscan || 1;
  const pxPerUnit = containPx * overscan;
  pose.orthoHeight = H / pxPerUnit;
  pose.containZoom = 1 / overscan; // zoom at which the whole content fits again

  // Put the content centre at the centre of the safe area rather than of the whole stage.
  const offX = (inset.left + aw / 2 - W / 2) / pxPerUnit;
  const offY = -(inset.top + ah / 2 - H / 2) / pxPerUnit;
  const right = new THREE.Vector3().setFromMatrixColumn(fitCamera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(fitCamera.matrixWorld, 1);
  pose.target
    .addScaledVector(right, (min.x + max.x) / 2 - offX)
    .addScaledVector(up, (min.y + max.y) / 2 - offY);
  return pose;
}

let tween = null;
// Mode changes (overview <-> floor) are "flights": once a threshold or tap commits to one, it runs to
// the end. Input during the flight is ignored, and a wheel / trackpad stream (which keeps going with
// momentum) must pause before it is accepted again. Otherwise late events cancel the flight halfway and
// leave the UI in floor mode with the camera still showing the whole building.
const ignoredPointers = new Set();
let wheelLocked = false, wheelIdleTimer = null;
function isFlying() { return !!tween?.locked || layerFlying; }
function cancelTween() { if (tween && !tween.locked) tween = null; }
function lockInputForFlight() {
  for (const id of pointers.keys()) ignoredPointers.add(id);
  pointers.clear();
  gesture = null;
  wheelLocked = true;
  clearTimeout(wheelIdleTimer);
  wheelIdleTimer = setTimeout(() => { if (!isFlying()) wheelLocked = false; }, 220);
}
// The canonical (fitted) pose of the current view; panning is bounded around it and the compass
// returns to its heading.
let fittedPose = null;

function goToPose(pose, animate, { locked = false } = {}) {
  viewState.userAdjusted = false;
  if (pose.blend !== undefined && pose.zoom === 1) fittedPose = { ...pose, target: pose.target.clone() };
  if (!animate) {
    tween = null;
    viewState.target.copy(pose.target);
    Object.assign(viewState, { heading: pose.heading, tilt: pose.tilt, orthoHeight: pose.orthoHeight, zoom: pose.zoom ?? 1 });
    if (pose.campus !== undefined) campusBlend = pose.campus;
    updateCamera();
    debugPanel?.sync();
    return;
  }
  tween = {
    from: { target: viewState.target.clone(), heading: viewState.heading, tilt: viewState.tilt, orthoHeight: viewState.orthoHeight, zoom: viewState.zoom, campus: campusBlend },
    to: { ...pose, zoom: pose.zoom ?? 1, campus: pose.campus ?? campusBlend },
    t0: performance.now(),
    locked,
  };
  if (locked) lockInputForFlight();
}

function stepTween(now) {
  if (!tween) return;
  const k = Math.min(1, (now - tween.t0) / FOCUS_LAYOUT.durationMs);
  const e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const { from, to } = tween;
  const lerp = (a, b) => a + (b - a) * e;
  viewState.target.lerpVectors(from.target, to.target, e);
  const dh = Math.atan2(Math.sin(to.heading - from.heading), Math.cos(to.heading - from.heading)); // shortest turn
  viewState.heading = from.heading + dh * e;
  viewState.tilt = lerp(from.tilt, to.tilt);
  // Zoom feels linear in log space.
  viewState.orthoHeight = Math.exp(lerp(Math.log(from.orthoHeight), Math.log(to.orthoHeight)));
  viewState.zoom = Math.exp(lerp(Math.log(from.zoom), Math.log(to.zoom)));
  campusBlend = lerp(from.campus, to.campus);
  updateCamera();
  if (k >= 1) {
    const wasFlight = tween.locked;
    tween = null;
    viewState.heading = to.heading;
    // A wheel stream still running when the flight lands keeps the lock until it pauses.
    if (wasFlight) { clearTimeout(wheelIdleTimer); wheelIdleTimer = setTimeout(() => { wheelLocked = false; }, 220); }
    debugPanel?.sync();
  }
}

// Re-frame the current view (reset button, resize) without changing what is shown.
function fitCurrent(animate) {
  if (currentView !== 'campus' && !layer.isLoaded(buildingId)) return; // still loading: start() frames it
  if (currentView === 'campus') goToPose(computeFit(new THREE.Box3().setFromObject(campusGroup), 'campus'), animate);
  else if (currentView === 'stacked') goToPose(computeFit(layer.buildingBox(buildingId), 'stacked', { leftExtra: badgeWidth() + 4 }), animate);
  else goToPose(computeFit(layer.floorBox(buildingId, focusFloor), 'floor3d'), animate);
}

// Point on the horizontal plane at height y under a screen position (orthographic, so always defined).
function groundPoint(clientX, clientY, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const { origin, direction } = raycaster.ray;
  if (Math.abs(direction.y) < 1e-6) return null;
  const t = (y - origin.y) / direction.y;
  return origin.clone().addScaledVector(direction, t);
}

function focusPlaneY() {
  if (currentView === 'campus') return 0;
  return focusFloor ? focusY + .1 : 0;
}

function isNavigableView() {
  return currentView === 'floor3d' || currentView === 'campus' || currentView === 'stacked';
}

// Keep the content reachable: the view centre may not leave the floor's footprint / the campus.
function clampTarget() {
  if (currentView !== 'campus' && !focusFloor) return;
  const box = currentView === 'campus' ? (campusBox ??= new THREE.Box3().setFromObject(campusGroup)) : layer.floorBox(buildingId, focusFloor);
  if (!box) return;
  viewState.target.x = THREE.MathUtils.clamp(viewState.target.x, box.min.x, box.max.x);
  viewState.target.z = THREE.MathUtils.clamp(viewState.target.z, box.min.z, box.max.z);
}

// Change zoom/heading while keeping the floor point under (clientX, clientY) fixed on screen.
function setViewAnchored(changes, clientX, clientY, anchorWorld = null) {
  const y = focusPlaneY();
  const before = anchorWorld || groundPoint(clientX, clientY, y);
  Object.assign(viewState, changes);
  updateCamera();
  const after = groundPoint(clientX, clientY, y);
  if (before && after) {
    viewState.target.x += before.x - after.x;
    viewState.target.z += before.z - after.z;
    clampTarget();
    updateCamera();
  }
}

// The one place that maps "how the content should turn on screen" to the camera heading.
// `cw` is the clockwise rotation (radians) the user wants to see. Raising `heading` turns the screen-up
// direction counter-clockwise over the ground, which makes the content appear to turn clockwise.
// Every rotation input (mouse drag, two-finger twist, …) goes through here so the sign is defined once.
function headingAfterRotate(baseHeading, cw) {
  return baseHeading + cw;
}

function canonicalHeading() {
  return fittedPose ? fittedPose.heading : viewState.heading;
}

// Compass: appears once the single floor is rotated; tap turns it back to the canonical heading.
function resetHeading() {
  goToPose({ target: viewState.target.clone(), heading: canonicalHeading(), tilt: viewState.tilt, orthoHeight: viewState.orthoHeight, zoom: viewState.zoom, distance: viewState.distance }, true);
}

// ---------------------------------------------------------------------------------------------
// Chrome: title, floor rail, view switch, building menu, compass
// ---------------------------------------------------------------------------------------------

let cachedInsets = null;

// The host's overlays changed size (e.g. a bottom sheet rose over the map). Re-read them; bring the
// selected room back into the visible area if the overlay now hides it, otherwise reframe the view
// unless the user has moved it.
function refreshInsets({ animate = true } = {}) {
  if (destroyed || !started) return;
  cachedInsets = safeInsets();
  for (const entry of campusBuildings.values()) entry.fill1 = undefined; // visible area changed
  if (isFlying()) return;
  if (selectedRoom && currentView === 'floor3d' && revealSelectedRoom(animate)) return;
  if (!viewState.userAdjusted && !tween) fitCurrent(animate);
}

const REVEAL_MARGIN_PX = 24;
// Pan (no zoom or rotation) so the selected room's centre sits in the middle of the visible area.
// Returns false when there is nothing to reveal, true when it is visible (already, or after the pan).
function revealSelectedRoom(animate) {
  const box = layer.roomBox(selectedRoom.key);
  if (!box) return false;
  const c = box.getCenter(new THREE.Vector3());
  const r = renderer.domElement.getBoundingClientRect(), inset = cachedInsets;
  const p = c.clone().project(camera);
  const sx = r.left + (p.x + 1) / 2 * r.width, sy = r.top + (1 - p.y) / 2 * r.height;
  const left = r.left + inset.left, right = r.right - inset.right, top = r.top + inset.top, bottom = r.bottom - inset.bottom;
  const m = REVEAL_MARGIN_PX;
  if (sx >= left + m && sx <= right - m && sy >= top + m && sy <= bottom - m) return true;
  const from = groundPoint(sx, sy, c.y), to = groundPoint((left + right) / 2, (top + bottom) / 2, c.y);
  if (!from || !to) return false;
  const target = viewState.target.clone();
  target.x += from.x - to.x; target.z += from.z - to.z;
  const adjusted = viewState.userAdjusted;
  goToPose({ target, heading: viewState.heading, tilt: viewState.tilt, orthoHeight: viewState.orthoHeight, zoom: viewState.zoom }, animate);
  viewState.userAdjusted = adjusted; // a pan to keep the room in sight is not a reframing
  return true;
}

function updateChrome() {
  requestAnimationFrame(() => { if (!destroyed) cachedInsets = safeInsets(); });
  renderFloorRail();
  emit('onViewChange', viewInfo());
}

const EXTERNAL_VIEW = { stacked: 'overview', floor3d: 'floor', campus: 'campus' };
function viewInfo() {
  return {
    view: EXTERNAL_VIEW[currentView],
    building: buildingId,
    buildingName: B()?.name,
    buildingShort: B()?.short,
    floor: currentView === 'floor3d' ? focusFloor : null,
    // Per-floor timetable stats, bottom to top: { id, total, available, free }.
    floors: floorStats(),
  };
}

function renderFloorRail() {
  const rail = railEl;
  rail.innerHTML = '';
  // The overview already lists every floor (badges), so the rail only appears on a single floor.
  const hidden = currentView !== 'floor3d';
  rail.style.display = hidden ? 'none' : 'flex';
  if (hidden) return;
  const all = document.createElement('button');
  all.className = 'floor-button all';
  all.textContent = '全部';
  all.title = '回到全樓層';
  all.addEventListener('click', () => showOverview());
  rail.appendChild(all);
  let active = null;
  for (const stats of floorStats().reverse()) {
    const floor = stats.id;
    const btn = document.createElement('button');
    btn.className = 'floor-button' + (floor === focusFloor ? ' active' : '') + (stats?.total ? '' : ' empty');
    btn.textContent = floor;
    btn.addEventListener('click', () => { if (floor !== focusFloor) showFloor(floor); });
    rail.appendChild(btn);
    if (floor === focusFloor) active = btn;
  }
  // Tall buildings: keep the current floor in view inside the scrollable rail.
  active?.scrollIntoView({ block: 'nearest' });
}

function updateCompass() {
  const el = compassEl;
  const delta = Math.atan2(Math.sin(viewState.heading - canonicalHeading()), Math.cos(viewState.heading - canonicalHeading()));
  // The default view is entrance-up, not north-up, so the compass stays visible on a single floor.
  // The needle points north; tapping it turns back to the entrance view (only meaningful once rotated).
  const show = (currentView === 'floor3d' || currentView === 'campus') && !isFlying();
  el.classList.toggle('hidden', !show);
  el.classList.toggle('rotated', Math.abs(delta) > .035);
  if (show) {
    // The needle orbits to point north; the letter counter-rotates so it always reads "N".
    const deg = (-viewState.heading) * 180 / Math.PI;
    el.querySelector('.dial').style.transform = `rotate(${deg}deg)`;
    el.querySelector('.dial b').style.transform = `rotate(${-deg}deg)`;
  }
}

// ---------------------------------------------------------------------------------------------
// Room selection (the host renders the sheet)
// ---------------------------------------------------------------------------------------------

function showRoomSheet(key) {
  const info = layer.room(key);
  if (!info) return;
  selectedRoom = info;
  emit('onRoomSelect', selectedRoom);
}
function isSheetOpen() {
  return !!selectedRoom;
}
function hideRoomSheet() {
  if (!selectedRoom) return;
  selectedRoom = null;
  emit('onRoomSelect', null);
}

function showToast(text) {
  emit('onNotice', text);
}

// ---------------------------------------------------------------------------------------------
// Input
//   Overview:     tap = enter floor; zoom in (pinch / wheel) on a floor = enter it. Nothing else moves.
//   Single floor: 1 finger / mouse drag = pan, pinch = zoom + rotate (+ pan), wheel = zoom at cursor,
//                 right- or shift-drag = rotate (desktop). Pitch is fixed. Zooming out past the fitted
//                 floor, or tapping empty space, returns to the overview.
// ---------------------------------------------------------------------------------------------

// What is under a screen point. Campus: { kind: 'campus', building, properties } of a white-model block;
// building views: the layer's pick ({ kind: 'room' | 'space' | 'floor', floor, key?, … }).
function hitTest(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (currentView !== 'campus') return layer.pick(raycaster);
  const hit = raycaster.intersectObjects(clickTargets, false)[0];
  const properties = hit?.object.userData.building?.properties;
  return hit ? { kind: 'campus', building: properties?.buildingId, properties, object: hit.object } : null;
}

function handleTap(clientX, clientY) {
  const hit = hitTest(clientX, clientY);
  if (currentView === 'campus') {
    const b = hit?.properties;
    if (!b) { setCampusFocus(null); return; }
    if (!BUILDINGS[b.buildingId]) {
      setCampusFocus(null);
      showToast(`${b.name}：目前只有${Object.values(BUILDINGS).map(x => x.short).join('、')}有室內地圖`);
      return;
    }
    // Two-step: the first tap selects (highlight + card), a second tap on the same building enters.
    if (campusFocus?.id === b.buildingId) enterBuildingFromCampus(b.buildingId);
    else setCampusFocus({ id: b.buildingId, via: 'tap' });
  } else if (currentView === 'stacked') {
    if (hit?.floor) showFloor(hit.floor);
  } else if (hit?.kind === 'room') {
    showRoomSheet(hit.key);
  } else if (isSheetOpen()) {
    hideRoomSheet(); // first tap outside a room only dismisses the sheet
  } else if (!hit && opts.tapEmptyToExit) {
    showOverview(); // empty space: back up to the floor overview
  }
}

const pointers = new Map();
let gesture = null;

// `ignoreHeld`: fingers still on the glass when a flight starts are ignored until they lift.
function endGesture(ignoreHeld = false) {
  if (ignoreHeld) for (const id of pointers.keys()) ignoredPointers.add(id);
  gesture = null;
  pointers.clear();
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

function startPinch() {
  const p = pinchInfo();
  gesture = {
    type: 'pinch', moved: true, ...p, dist0: p.dist, angle0: p.angle,
    zoom0: viewState.zoom, heading0: viewState.heading,
    anchor: isNavigableView() ? groundPoint(p.midX, p.midY, focusPlaneY()) : null,
    lastMidX: p.midX, lastMidY: p.midY,
  };
  cancelTween();
}

// After a gesture: undo any rubber-band and settle on a valid zoom.
function settleZoom() {
  if (isFlying()) return;
  if (currentView === 'stacked' && viewState.zoom < 1) fitCurrent(true);
  else if (currentView !== 'stacked' && isNavigableView() && viewState.zoom < navMinZoom()) {
    goToPose({ target: viewState.target.clone(), heading: viewState.heading, tilt: viewState.tilt, orthoHeight: viewState.orthoHeight, zoom: navMinZoom(), distance: viewState.distance }, true);
  }
}

// Campus zoom: free between the whole campus and a building filling the view; rubber-band below.
function campusZoomValue(raw) {
  const { minZoom: min, maxZoom: max } = CAMPUS_NAV;
  if (raw >= min) return Math.min(raw, max);
  return min - (min - raw) * SEMANTIC_ZOOM.rubber;
}
function overviewZoomValue(raw) {
  if (raw >= 1) return Math.min(raw, OVERVIEW_NAV.maxZoom);
  return 1 - (1 - raw) * SEMANTIC_ZOOM.rubber;
}
function navZoomValue(raw) {
  if (currentView === 'campus') return campusZoomValue(raw);
  if (currentView === 'stacked') return overviewZoomValue(raw);
  return floorZoomValue(raw);
}
function navMinZoom() {
  if (currentView === 'campus') return CAMPUS_NAV.minZoom;
  if (currentView === 'stacked') return 1;
  return floorMinZoom();
}
function navMaxZoom() {
  if (currentView === 'campus') return CAMPUS_NAV.maxZoom;
  if (currentView === 'stacked') return OVERVIEW_NAV.maxZoom;
  return SEMANTIC_ZOOM.maxZoom;
}
// Zoomed out past the minimum far enough to leave: floor -> overview, overview -> campus.
function exitForZoom(zoom) {
  if (currentView === 'floor3d' && isFloorExitZoom(zoom)) return () => showOverview();
  if (currentView === 'stacked' && zoom < OVERVIEW_NAV.exitRatio) return () => showCampus();
  return null;
}

// ---- Overview pan / zoom (screen space: heading and tilt are locked, so moving the target inside the
// camera plane is exactly a 2D pan) ----
const cameraRight = new THREE.Vector3(), cameraUp = new THREE.Vector3();
function cameraAxes() {
  camera.updateMatrixWorld();
  cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
  cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
}
function worldPerPixel() {
  return (viewState.orthoHeight / viewState.zoom) / Math.max(1, root.clientHeight);
}
function stageCenter() {
  const r = root.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
// Move the view by screen pixels (content follows the pointer).
function panOverviewBy(dxPx, dyPx) {
  cameraAxes();
  const wpp = worldPerPixel();
  viewState.target.addScaledVector(cameraRight, -dxPx * wpp).addScaledVector(cameraUp, dyPx * wpp);
  clampOverview();
  updateCamera();
}
// Zoom keeping the content under (x, y) in place.
function zoomOverviewAt(zoom, x, y) {
  cameraAxes();
  const c = stageCenter(), before = worldPerPixel();
  viewState.zoom = zoom;
  const d = before - worldPerPixel();
  viewState.target.addScaledVector(cameraRight, (x - c.x) * d).addScaledVector(cameraUp, -(y - c.y) * d);
  clampOverview();
  updateCamera();
}
// The stack may scroll until its edge reaches the view edge (plus a little slack), never further.
function clampOverview() {
  if (!fittedPose || currentView !== 'stacked') return;
  cameraAxes();
  const box = layer.buildingBox(buildingId);
  if (!box) return;
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const s = v.dot(cameraRight), t = v.dot(cameraUp);
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  const viewH = viewState.orthoHeight / viewState.zoom, viewW = viewH * root.clientWidth / Math.max(1, root.clientHeight);
  const slack = OVERVIEW_NAV.panSlack;
  const maxS = Math.max(0, (s1 - s0) / 2 - viewW / 2 * (1 - slack)), maxT = Math.max(0, (t1 - t0) / 2 - viewH / 2 * (1 - slack));
  const fs = fittedPose.target.dot(cameraRight), ft = fittedPose.target.dot(cameraUp);
  const sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
  const s = viewState.target.dot(cameraRight), t = viewState.target.dot(cameraUp);
  const cs = THREE.MathUtils.clamp(s, Math.min(fs, sc - maxS), Math.max(fs, sc + maxS));
  const ct = THREE.MathUtils.clamp(t, Math.min(ft, tc - maxT), Math.max(ft, tc + maxT));
  viewState.target.addScaledVector(cameraRight, cs - s).addScaledVector(cameraUp, ct - t);
}

// Every frame on the overview: light up the floor that is big enough, and enter the floor under the
// zoom centre once a zoom-in pushes it past enterFill.
let lastOverviewZoom = null;
function updateOverviewReadiness() {
  if (currentView !== 'stacked' || isFlying() || layer.animating || campusBlend > .01) {
    lastOverviewZoom = null;
    if (readyFloor) setReadyFloor(null);
    return;
  }
  const zoomingIn = lastOverviewZoom !== null && viewState.zoom > lastOverviewZoom * 1.0005;
  lastOverviewZoom = viewState.zoom;
  let ready = null, readyDist = Infinity;
  if (viewState.zoom > 1.01) {
    for (const id of overviewFloorIds()) {
      const m = boxScreenMetrics(layer.floorBox(buildingId, id), camera);
      if (m.visible >= .6 && m.height >= OVERVIEW_NAV.readyHeight && m.centerDist < readyDist) { ready = id; readyDist = m.centerDist; }
    }
  }
  setReadyFloor(ready);
  if (!zoomingIn || !zoomAnchor) return;
  // The floor under the zoom centre; pinching between floors or beside the stack falls back to the floor
  // that takes the most of the view.
  let id = hitTest(zoomAnchor.x, zoomAnchor.y)?.floor;
  if (!hasFloor(id)) {
    let best = 0;
    for (const fid of overviewFloorIds()) {
      const h = boxScreenMetrics(layer.floorBox(buildingId, fid), camera).height;
      if (h > best) { best = h; id = fid; }
    }
  }
  if (hasFloor(id) && boxScreenMetrics(layer.floorBox(buildingId, id), camera).height >= OVERVIEW_NAV.enterHeight) showFloor(id);
}
function setReadyFloor(id) {
  readyFloor = id; // the badge lights up through the overlay's classFor
}

// Single floor: zoom below the fitted size rubber-bands; far enough means "back to the overview".
function floorZoomValue(raw) {
  const min = floorMinZoom();
  if (raw >= min) return Math.min(raw, SEMANTIC_ZOOM.maxZoom);
  return min - (min - raw) * SEMANTIC_ZOOM.rubber;
}
function isFloorExitZoom(zoom) {
  return zoom < floorMinZoom() * SEMANTIC_ZOOM.exitRatio;
}

on(renderer.domElement, 'contextmenu', e => e.preventDefault());

on(renderer.domElement, 'pointerdown', e => {
  if (isFlying()) { ignoredPointers.add(e.pointerId); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
  if (pointers.size === 1) {
    const rotate = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey || e.altKey);
    gesture = { type: rotate ? 'rotate' : 'pan', moved: false, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
    // Touch has no hover: pressing a floor in the overview highlights it.
    if (currentView === 'stacked' && e.pointerType !== 'mouse') setStackHover(hitTest(e.clientX, e.clientY)?.floor || null);
  } else if (pointers.size === 2) {
    startPinch();
  }
});

on(renderer.domElement, 'pointermove', e => {
  if (ignoredPointers.has(e.pointerId) || isFlying()) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // A missed pointerup must never leave a drag running on plain hover.
  if (gesture && e.pointerType === 'mouse' && e.buttons === 0) { endGesture(); settleZoom(); }
  if (!gesture) {
    if (currentView === 'stacked' && !tween && e.pointerType === 'mouse') setStackHover(hitTest(e.clientX, e.clientY)?.floor || null);
    return;
  }
  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const p = pinchInfo();
    const scale = p.dist / gesture.dist0;
    if (!isNavigableView()) return;
    const zoom = navZoomValue(gesture.zoom0 * scale);
    const exit = exitForZoom(zoom);
    if (exit) { endGesture(); exit(); return; }
    if (currentView === 'stacked') {
      zoomAnchor = { x: p.midX, y: p.midY }; zoomAnchorAt = performance.now();
      zoomOverviewAt(zoom, p.midX, p.midY);
      panOverviewBy(p.midX - gesture.lastMidX, p.midY - gesture.lastMidY);
      gesture.lastMidX = p.midX; gesture.lastMidY = p.midY;
      viewState.userAdjusted = true;
      debugPanel?.sync();
      return;
    }
    // Screen y points down, so a clockwise twist increases atan2: the fingers' angle change is already
    // "clockwise positive".
    zoomAnchor = { x: p.midX, y: p.midY }; zoomAnchorAt = performance.now();
    setViewAnchored({ zoom, heading: headingAfterRotate(gesture.heading0, p.angle - gesture.angle0) }, p.midX, p.midY, gesture.anchor);
    viewState.userAdjusted = true;
    debugPanel?.sync();
    return;
  }
  const dx = e.clientX - gesture.lastX, dy = e.clientY - gesture.lastY;
  if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 6) gesture.moved = true;
  if (gesture.moved && currentView === 'stacked') {
    cancelTween();
    if (hoverFloor && e.pointerType !== 'mouse') setStackHover(null); // a drag is not a press
    panOverviewBy(dx, dy);
    viewState.userAdjusted = true;
  } else if (gesture.moved && isNavigableView()) {
    cancelTween();
    if (gesture.type === 'rotate') {
      // Turntable feel: the near (bottom) edge follows the pointer, so dragging right turns the content
      // counter-clockwise.
      setViewAnchored({ heading: headingAfterRotate(viewState.heading, -dx * .006) }, root.getBoundingClientRect().left + root.clientWidth / 2, root.getBoundingClientRect().top + root.clientHeight / 2);
    } else {
      // Pan: the floor point under the pointer follows it.
      const y = focusPlaneY();
      const a = groundPoint(gesture.lastX, gesture.lastY, y), b = groundPoint(e.clientX, e.clientY, y);
      if (a && b) { viewState.target.x += a.x - b.x; viewState.target.z += a.z - b.z; clampTarget(); updateCamera(); }
    }
    viewState.userAdjusted = true;
    debugPanel?.sync();
  }
  gesture.lastX = e.clientX; gesture.lastY = e.clientY;
});

function onPointerEnd(e) {
  if (ignoredPointers.delete(e.pointerId) || isFlying()) { pointers.delete(e.pointerId); return; }
  const wasTap = gesture && gesture.type !== 'pinch' && !gesture.moved && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (wasTap) handleTap(e.clientX, e.clientY);
  if (pointers.size === 1 && gesture?.type === 'pinch') {
    // One finger lifted: continue as a pan with the remaining finger, without a stray tap.
    const [p] = [...pointers.values()];
    gesture = { type: 'pan', moved: true, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y };
    return;
  }
  if (pointers.size === 0) {
    if (gesture && e.pointerType !== 'mouse' && currentView === 'stacked') setStackHover(null);
    gesture = null;
    settleZoom();
  }
}
on(renderer.domElement, 'pointerup', onPointerEnd);
on(renderer.domElement, 'pointercancel', onPointerEnd);
on(renderer.domElement, 'pointerleave', e => { if (e.pointerType === 'mouse' && !gesture) setStackHover(null); });

// Wheel / trackpad pinch (ctrlKey). Semantic steps accumulate and spring back after a short pause.
let wheelRaw = null, wheelTimer = null;
on(renderer.domElement, 'wheel', e => {
  e.preventDefault();
  if (wheelLocked || isFlying()) {
    // Swallow the rest of this wheel / momentum stream; unlock once it pauses.
    clearTimeout(wheelIdleTimer);
    wheelIdleTimer = setTimeout(() => { if (!isFlying()) wheelLocked = false; }, 220);
    return;
  }
  cancelTween();
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0016));
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelRaw = null; settleZoom(); }, 260);
  // The raw (unbanded) zoom accumulates; below the minimum it rubber-bands and, pulled far enough,
  // leaves the view (floor -> overview, overview -> campus).
  wheelRaw = Math.min(navMaxZoom(), (wheelRaw ?? viewState.zoom) * factor);
  const zoom = navZoomValue(wheelRaw);
  const exit = exitForZoom(zoom);
  if (exit) { wheelRaw = null; clearTimeout(wheelTimer); exit(); return; }
  zoomAnchor = { x: e.clientX, y: e.clientY }; zoomAnchorAt = performance.now();
  if (currentView === 'stacked') zoomOverviewAt(zoom, e.clientX, e.clientY);
  else setViewAnchored({ zoom }, e.clientX, e.clientY);
  viewState.userAdjusted = true;
  debugPanel?.sync();
}, { passive: false });

on(window, 'keydown', e => {
  if (e.key !== 'Escape' || destroyed || e.defaultPrevented) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  if (isSheetOpen()) hideRoomSheet();
  else if (currentView === 'floor3d') showOverview();
});

on(compassEl, 'click', () => resetHeading());

// Re-lay out the building for the current orientation (the overview gap depends on the overview tilt)
// and put the user back where they were. Only positions change; the geometry stays.
function representForStage() {
  if (currentView === 'campus') return;
  if (currentView === 'floor3d') present('floor', focusFloor, false);
  else present('stack', null, false);
  fitCurrent(false);
}

function resize() {
  if (destroyed) return;
  renderer.setSize(root.clientWidth, root.clientHeight, false);
  if (!started) return;
  cachedInsets = safeInsets();
  for (const entry of campusBuildings.values()) entry.fill1 = undefined; // campus framing changed
  if (currentView !== 'campus' && presentedPortrait !== null && presentedPortrait !== isPortraitStage()) representForStage();
  // Keep the canonical framing on resize/rotation unless the user has moved the view.
  else if (!viewState.userAdjusted && !tween) fitCurrent(false);
  else updateCamera();
}
const resizeObserver = new ResizeObserver(() => resize());
resizeObserver.observe(root);

let lastFrame = performance.now();
function animate(now = performance.now()) {
  if (destroyed) return;
  rafId = requestAnimationFrame(animate);
  const elapsed = Math.max(0, (now - lastFrame) / 1000);
  lastFrame = now;
  stepTween(now);
  // Real elapsed time, so the layer's presentation flight lands with the camera's (which runs on the clock)
  // even when frames are slow.
  layer.update(elapsed);
  updateCampusFade();
  updateCampusReadiness();
  updateOverviewReadiness();
  if (currentView === 'campus') updateCampusCard();
  updateCompass();
  overlay.update(camera, labelList());
  renderer.render(scene, camera);
}

// Temporary tuning UI, only with ?debug in the URL. Edits the active VIEW_PRESETS entry and re-fits.
let debugPanel = null, debugEl = null;
function setupDebugPanel() {
  if (!opts.debug) return;
  const el = debugEl = document.createElement('div');
  el.className = 'indoor-map-debug';
  document.body.appendChild(el);
  const deg = r => Math.round(r * 180 / Math.PI);
  const rad = { get: v => deg(v), set: v => v * Math.PI / 180 };
  const pct = { get: v => Math.round(v * 100), set: v => v / 100 };
  const raw = { get: v => v, set: v => v };
  const presetOf = () => VIEW_PRESETS[currentView] || VIEW_PRESETS.floor3d;
  const refit = () => fitCurrent(false);
  // Overview geometry (floor gap) depends on its heading/tilt, so those rebuild the building.
  const overviewApply = () => representForStage();
  // [key, min, max, step, conversion, object getter, apply]
  const fields = () => [
    ['heading', -180, 180, 1, rad, presetOf, currentView === 'stacked' ? overviewApply : refit],
    [currentView === 'stacked' && isPortraitStage() ? 'portraitTilt' : 'tilt', 0, 80, 1, rad, presetOf, currentView === 'stacked' ? overviewApply : refit],
    ['pad', 0, 20, 1, pct, presetOf, refit],
    ...(currentView === 'stacked' ? [
      ['gapRatio', 1, 2.5, .02, raw, () => STACK_LAYOUT, overviewApply],
      ['skipExtra', 0, 1.5, .05, raw, () => STACK_LAYOUT, overviewApply],
      ['readyHeight', .1, .6, .01, raw, () => OVERVIEW_NAV, () => {}],
      ['enterHeight', .2, .9, .01, raw, () => OVERVIEW_NAV, () => {}],
    ] : []),
    ...(currentView === 'floor3d' ? [
      ['overscan', 1, 1.4, .01, raw, presetOf, refit],
    ] : []),
  ];
  const render = () => {
    const list = fields();
    el.innerHTML = `<b>${currentView}</b>` + list.map(([k, lo, hi, st, conv, obj], i) => {
      const v = conv.get(obj()[k]);
      return `<label>${k} <input type="range" data-i="${i}" min="${lo}" max="${hi}" step="${st}" value="${v}"><span>${v}</span></label>`;
    }).join('') + `<div class="live"></div><pre></pre>`;
    el.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
      const [k, , , , conv, obj, apply] = list[+input.dataset.i];
      obj()[k] = conv.set(+input.value);
      input.nextElementSibling.textContent = input.value;
      apply();
    }));
    sync();
  };
  const sync = () => {
    if (el.dataset.view !== currentView) { el.dataset.view = currentView; render(); return; }
    const p = VIEW_PRESETS[currentView] || VIEW_PRESETS.floor3d;
    el.querySelector('.live').textContent = `live: heading ${deg(viewState.heading)}° tilt ${deg(viewState.tilt)}° zoom ${viewState.zoom.toFixed(2)} span ${viewState.orthoHeight.toFixed(1)}m`;
    el.querySelector('pre').textContent = `${currentView}: ${JSON.stringify(p, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`
      + (currentView === 'stacked' ? `\nSTACK_LAYOUT = ${JSON.stringify(STACK_LAYOUT)}\nOVERVIEW_NAV = ${JSON.stringify(OVERVIEW_NAV)}` : '')
      + (currentView === 'floor3d' ? `\nFOCUS_LAYOUT = ${JSON.stringify(FOCUS_LAYOUT)}` : '');
  };
  debugPanel = { sync };
  // Devtools access to internals, debug mode only.
  window.__indoorDebug = { scene, renderer, sun, layer, overlay, viewState, camera, boxScreenMetrics, overviewFloorIds, zoomOverviewAt };
}

async function start() {
  setupDebugPanel();
  try {
    ({ buildingIndex, buildingsData, frameInfo = null } = await loadCampus(source));
  } catch (error) {
    emit('onError', { type: 'load-failed', error });
    return;
  }
  if (destroyed) return;
  // campusFeatures() projects (radius filter), so a lonlat source needs its reference first.
  if (FRAME !== 'planar-cm') LONLAT_REF = geoBounds(buildingsData.features.filter(f => f.properties.campusId === 'A'));
  campusBounds = geoBounds(campusFeatures());
  if (FRAME !== 'planar-cm') LONLAT_REF = campusBounds;
  renderer.setSize(root.clientWidth, root.clientHeight, false);
  started = true;
  if (ENTRY_VIEW === 'campus') {
    await switchBuilding(buildingId, { view: 'keep' });
    showCampus({ animate: false, land: 'campus' });
  } else {
    await switchBuilding(buildingId, { view: ENTRY_VIEW });
  }
  animate();
  for (const id of opts.preload) {
    if (!BUILDINGS[id]) continue;
    layer.prefetch(id).catch(() => { /* not in building-index, or offline: entering reports it */ });
  }
}

function destroy() {
  if (destroyed) return;
  destroyed = true;
  ac.abort();
  cancelAnimationFrame(rafId);
  resizeObserver.disconnect();
  clearTimeout(wheelTimer);
  clearTimeout(wheelIdleTimer);
  layer.dispose();
  clearGroup(campusGroup);
  campusGen++;
  for (const p of modelTemplates.values()) p.then(t => t.traverse(n => n.geometry?.dispose?.())).catch(() => {});
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
  railEl.remove();
  compassEl.remove();
  overlay.dispose();
  debugEl?.remove();
  root.remove();
}

const ready = start();

const VIEW_IN = { campus: 'campus', overview: 'stacked', floor: 'floor3d' };

async function setView({ building = buildingId, view, floor = null, animate = true } = {}) {
  await ready;
  if (destroyed || isFlying() || !started) return false;
  const target = VIEW_IN[view] || (floor ? 'floor3d' : currentView === 'campus' ? 'stacked' : currentView);
  if (building !== buildingId) {
    if (!BUILDINGS[building]) return false;
    if (target === 'campus') {
      await switchBuilding(building, { view: 'keep' });
      if (destroyed) return false;
      showCampus({ animate });
      return true;
    }
    if (currentView === 'campus' && target === 'stacked') { await enterBuildingFromCampus(building); return !destroyed; }
    await switchBuilding(building, { view: target === 'floor3d' ? 'floor3d' : 'stacked', floor });
    return !destroyed && buildingId === building;
  }
  if (target === 'campus') { if (currentView !== 'campus') showCampus({ animate }); }
  else if (target === 'floor3d') showFloor(floor && hasFloor(floor) ? floor : defaultFloorId(), { animate });
  else if (currentView !== 'stacked') showOverview({ animate });
  return true;
}

async function selectRoom(key, { animate = true } = {}) {
  const [b, f] = String(key).split('/');
  if (!BUILDINGS[b]) return false;
  if (b !== buildingId || currentView !== 'floor3d' || focusFloor !== f) {
    const ok = await setView({ building: b, view: 'floor', floor: f, animate: b === buildingId && animate });
    if (!ok || destroyed || focusFloor !== f) return false;
  }
  if (!layer.room(key)) return false;
  showRoomSheet(key);
  return true;
}
return {
  /** Resolves once the first building is shown (or loading failed; see onError). */
  ready,
  /** Change what is shown. building: id; view: 'campus' | 'overview' | 'floor'; floor: floor id. */
  // Resolves true when the change was applied, false when it was refused (destroyed, not started, or a
  // flight is in progress — retry after onViewChange).
  setView,
  /**
   * Show one room: switches building / floor as needed, then selects it (onRoomSelect fires).
   * key = "buildingId/floorId/classNumber". Resolves false if the room has no polygon or the call was refused.
   */
  selectRoom,
  /**
   * Room occupancy, pushed by the host whenever the period changes:
   * Map (or plain object) "buildingId/floorId/classNumber" -> { status: 'free'|'soon'|'busy'|'unknown', …any
   * fields the host wants back in onRoomSelect (code, capacity, freeUntil…) }. null = no timetable.
   */
  setOccupancy,
  /** Fly from the campus into a building's floor overview. */
  enterBuilding: id => enterBuildingFromCampus(id),
  /** Back to the canonical framing of the current view. */
  resetView: () => fitCurrent(true),
  /**
   * Call when host UI over the map changes size (a bottom sheet expanding, a panel opening): re-reads
   * getInsets and keeps the selected room visible, or reframes the view if the user has not moved it.
   */
  refreshInsets: ({ animate = true } = {}) => refreshInsets({ animate }),
  clearSelection: () => hideRoomSheet(),
  getView: () => viewInfo(),
  destroy,
};
}
