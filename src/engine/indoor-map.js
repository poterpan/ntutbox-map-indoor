import * as THREE from 'three';
import { campusCdnSource } from '../data/sources.js';

// Indoor map engine. One instance per container:
//   const map = createIndoorMap(el, { source, buildings, onViewChange, onRoomSelect, … });
//   source: src/data/sources.js. Defaults to the published campus data (campusCdnSource).
//   map.setOccupancy(…); map.setView({ building, view, floor }); map.destroy();
// The engine owns the canvas, in-canvas labels, the floor rail and the compass. Everything else (titles,
// legend, building picker, room sheet, campus card) belongs to the host and is driven by callbacks.
// The reasoning behind the interaction model and its constants is in docs/DESIGN.md.

// Buildings with indoor data. Floor order comes from the source's building index.
// Hosts pass their own table through `options.buildings`, normally `(await source.load()).buildings`
// (every building with indoor GIS); this fallback only covers three buildings. The floor that opens first is not
// configured: it is the floor with the most rooms free per the timetable (defaultFloorId).
const DEFAULT_BUILDINGS = {
  A3T: { name: '第三教學大樓', short: '三教', entranceBearing: 0 },
  AM: { name: '先鋒國際研發大樓', short: '先鋒', entranceBearing: 0 },
  CB: { name: '綜合科館', short: '綜科', entranceBearing: 270 },
};
// `entranceBearing`: compass side of the main entrance (0 = north, 90 = east, …), confirmed on site
// (2026-10). Every view is oriented as if standing at that entrance looking in: the entrance side is
// at the bottom of the screen. Exact entrance points (several per building) belong to the future
// navigation graph, not here.
// Which GIS spaces are rooms with an occupancy colour:
//   1. any space whose (building, floor, classNumber) has an occupancy record from the host — the course
//      system is the source of truth for "is a classroom" (CB has 26 course rooms that GIS files as labs
//      or meeting rooms);
//   2. otherwise GIS 001 一般教室 / 002 專業教室, shown as 'unknown' (無課表資料).
const CLASSROOM_CATEGORIES = new Set(['001', '002']);
// Occupancy statuses the engine can draw. Time logic lives in the host (example: dev/course-occupancy.js).
export const ROOM_STATUSES = ['free', 'soon', 'busy', 'unknown'];

// Physical floor order: B2 < B1 < B1M (mezzanine) < 1F < 1M < 2F < … < RF/R1 < PH.
// building-index lists B1M last; A6T has "1M"; some buildings use "RF".
export function floorRank(id) {
  let m;
  if ((m = /^B(\d+)(M?)$/.exec(id))) return -Number(m[1]) + (m[2] ? .5 : 0);
  if ((m = /^(\d+)F?(M?)$/.exec(id))) return Number(m[1]) + (m[2] ? .5 : 0);
  if (id === 'RF') return 1000;
  if ((m = /^R(\d+)$/.exec(id))) return 1000 + Number(m[1]);
  if (id === 'PH') return 1100;
  return 500;
}

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
  ...options,
};
const BUILDINGS = opts.buildings;
const source = opts.source ?? campusCdnSource();
// Coordinates arrive either as WGS84 degrees or as integer cm in one planar frame (source.frame).
const FRAME = source.frame ?? 'lonlat';
const emit = (name, payload) => {
  try { opts[name]?.(payload); } catch (err) { console.error(`[indoor-map] ${name} handler failed`, err); }
};
// Every listener registered by the engine goes through `on`, so destroy() removes them all at once.
const ac = new AbortController();
const on = (target, type, fn, o = {}) => target.addEventListener(type, fn, { ...o, signal: ac.signal });
let destroyed = false, started = false, rafId = 0;

let buildingId = BUILDINGS[opts.initialBuilding] ? opts.initialBuilding : Object.keys(BUILDINGS)[0];
let STACK_ORDER = [];  // bottom -> top
let FLOOR_ORDER = [];  // top -> bottom (floor rail)

const COLORS = {
  bg: 0xf0f2f6,
  ground: 0xe7eaf0,
  slabTop: 0xf8f8f7,
  slabSide: 0xd9dde4,
  room: 0xd2d6dd,
  roomSide: 0xbac0c9,
  free: 0x93dca4,
  freeSide: 0x58bc72,
  soon: 0xe8d27d,
  soonSide: 0xc6a744,
  unknown: 0xe6e8ec,
  unknownSide: 0xccd0d7,
  corridor: 0xf2ecdf,
  corridorSide: 0xd9cdb8,
  vertical: 0xc9dcef,
  verticalSide: 0x9cbad7,
  restroom: 0xdad6ee,
  restroomSide: 0xb2abd4,
  service: 0xe7e9ed,
  serviceSide: 0xc9cdd5,
  wall: 0xf6f7f9,
  wallSide: 0xbfc5ce,
  outline: 0x767c87,
  focusEdge: 0x4f5560,
  campus: 0xf8f8f8,
  campusSide: 0xd9dee6,
  selected: 0x9fc7f5,
  selectedSide: 0x70a6df,
};

const root = container;
root.classList.add('indoor-map'); // styles: src/engine/indoor-map.css (imported by the host)
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

scene.add(new THREE.HemisphereLight(0xffffff, 0xaeb7c4, 2.15));
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(45, -35, 80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -130;
sun.shadow.camera.right = 130;
sun.shadow.camera.top = 130;
sun.shadow.camera.bottom = -130;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
scene.add(sun);

scene.add(sun.target);

// The whole building (every floor, fully detailed) is built once into buildingGroup. Moving between
// the floor overview and a single floor only animates the camera and per-floor opacity.
const buildingGroup = new THREE.Group();
const campusGroup = new THREE.Group();
scene.add(buildingGroup, campusGroup);

let buildingIndex;
let buildingsData;
let buildingFeature;
let currentFloor = null;
let currentView = 'stacked'; // 'stacked' (floor overview) | 'floor3d' (single floor) | 'campus'
// Where the map opens: the floor overview answers "which floor has room" before anything else.
const ENTRY_VIEW = { campus: 'campus', overview: 'stacked', floor: 'floor3d' }[opts.initialView] || 'stacked';
let clickTargets = [];
let labels = [];
let selectedRoom = null;
// Host-provided occupancy: Map<"B/F/classNumber", { status, …record }>. Records whose key has no
// classNumber ("B/F/?code") are rooms the course system places on a floor but GIS cannot locate; they
// still count in that floor's stats.
let occupancy = toOccupancyMap(opts.occupancy);
let builtRoomSig = null;

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

function allCoords(geometry) {
  const out = [];
  const walk = value => {
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  walk(geometry.coordinates);
  return out;
}

function geoBounds(features) {
  const pts = features.flatMap(f => allCoords(f.geometry));
  const minLon = Math.min(...pts.map(p => p[0]));
  const maxLon = Math.max(...pts.map(p => p[0]));
  const minLat = Math.min(...pts.map(p => p[1]));
  const maxLat = Math.max(...pts.map(p => p[1]));
  return { minLon, maxLon, minLat, maxLat, lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
}

function metersFromLonLat(lon, lat, originLon, originLat) {
  const R = 6378137;
  return [
    (lon - originLon) * Math.PI / 180 * R * Math.cos(originLat * Math.PI / 180),
    (lat - originLat) * Math.PI / 180 * R,
  ];
}

// Source coordinates → local metres around `origin` (the world origin, in the source's own units).
function project(pt, origin) {
  if (FRAME === 'planar-cm') return [(pt[0] - origin.lon) / 100, (pt[1] - origin.lat) / 100];
  return metersFromLonLat(pt[0], pt[1], origin.lon, origin.lat);
}

function ringsFromGeometry(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function shapeFromRings(rings, origin) {
  if (!rings?.length || rings[0].length < 3) return null;
  const makePath = (coords, hole = false) => {
    const p = hole ? new THREE.Path() : new THREE.Shape();
    coords.forEach((pt, i) => {
      const [x, y] = project(pt, origin);
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    });
    p.closePath();
    return p;
  };
  const shape = makePath(rings[0]);
  for (let i = 1; i < rings.length; i++) shape.holes.push(makePath(rings[i], true));
  return shape;
}

function centroidOfGeometry(geometry, origin) {
  const pts = allCoords(geometry);
  let sx = 0, sy = 0;
  for (const p of pts) {
    const [x, y] = project(p, origin);
    sx += x; sy += y;
  }
  return new THREE.Vector3(sx / pts.length, sy / pts.length, 0);
}

function clearGroup(group) {
  while (group.children.length) {
    const obj = group.children.pop();
    obj.traverse?.(n => {
      n.geometry?.dispose?.();
      if (Array.isArray(n.material)) n.material.forEach(m => m.dispose?.());
      else n.material?.dispose?.();
    });
  }
}

function roomKey(p) {
  return `${p.buildingId}/${p.floorId}/${p.classNumber}`;
}
function roomStatus(key) {
  const st = occupancy?.get(key)?.status;
  return ROOM_STATUSES.includes(st) ? st : 'unknown';
}

function classifyFeature(p) {
  const name = (p.name || p.use || '').trim();
  if (name === '柱子' || (!p.category1 && !name && !p.classNumber)) return 'skip';
  if (name.includes('挑空') || name.includes('採光井')) return 'void';
  if (p.classNumber && occupancy?.has(roomKey(p))) return 'classroom';
  if (CLASSROOM_CATEGORIES.has(p.category1)) return 'classroom';
  if (p.category1 === '505' || /走道|走廊|穿堂|外廊|大廳/.test(name)) return 'corridor';
  if (p.category1 === '503' || p.category1 === '504' || /電梯|樓梯/.test(name)) return 'vertical';
  if (p.category1 === '501' || /廁/.test(name)) return 'restroom';
  return 'service';
}

function materialPair(top, side, transparent = false, opacity = 1) {
  return [
    new THREE.MeshStandardMaterial({ color: top, roughness: .90, metalness: 0, transparent, opacity }),
    new THREE.MeshStandardMaterial({ color: side, roughness: .95, metalness: 0, transparent, opacity }),
  ];
}

// Low walls: tall enough to read as rooms at the single-floor tilt, low enough not to hide the floor colour.
const WALL = { base: .18, height: .85, thickness: .14 };
const LABEL_Z = WALL.base + WALL.height + .2;

function addWallSegment(group, x1, y1, x2, y2, zBase = WALL.base, height = WALL.height, thickness = WALL.thickness) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < .08) return;
  const geom = new THREE.BoxGeometry(len, thickness, height);
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.wallSide, roughness: .95, metalness: 0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((x1+x2)/2, (y1+y2)/2, zBase + height/2);
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

// Walls already built on the floor being loaded, as collinear intervals. Adjacent rooms share
// boundaries, so without this every shared edge would get two overlapping walls.
let floorWalls = null;
const WALL_ANGLE_TOL = .05, WALL_OFFSET_TOL = .3, WALL_MIN_LEN = .12;

function subtractInterval(parts, [c0, c1]) {
  return parts.flatMap(([a, b]) => {
    if (c1 <= a || c0 >= b) return [[a, b]];
    return [[a, Math.min(b, c0)], [Math.max(a, c1), b]].filter(([x, y]) => y - x > WALL_MIN_LEN);
  });
}

function addDedupedWall(group, ax, ay, bx, by) {
  if (!floorWalls) { addWallSegment(group, ax, ay, bx, by); return; }
  let ang = Math.atan2(by - ay, bx - ax);
  if (ang < 0) ang += Math.PI;
  if (ang >= Math.PI) ang -= Math.PI;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const off = -ax * dy + ay * dx;
  const t0 = Math.min(ax * dx + ay * dy, bx * dx + by * dy);
  const t1 = Math.max(ax * dx + ay * dy, bx * dx + by * dy);
  let parts = [[t0, t1]];
  for (const w of floorWalls) {
    const diff = Math.abs(w.ang - ang);
    // Angles near 0 and near π are the same line with flipped direction.
    const flipped = diff > Math.PI / 2;
    if (Math.min(diff, Math.PI - diff) > WALL_ANGLE_TOL) continue;
    if (Math.abs((flipped ? -w.off : w.off) - off) > WALL_OFFSET_TOL) continue;
    parts = subtractInterval(parts, flipped ? [-w.t1, -w.t0] : [w.t0, w.t1]);
    if (!parts.length) break;
  }
  floorWalls.push({ ang, off, t0, t1 });
  for (const [a, b] of parts) {
    addWallSegment(group, a * dx - off * dy, a * dy + off * dx, b * dx - off * dy, b * dy + off * dx);
  }
}

// Room outlines in the GIS data notch around every column (most 5F edges are < 0.5 m). The floor fill
// keeps the exact polygon; only the wall outline is cleaned: keep the long edges (each one lies exactly
// on a GIS edge), merge collinear pieces split by a notch, and re-form corners where neighbours meet.
const WALL_MIN_EDGE_M = 1.0, WALL_MERGE_ANGLE = .17, WALL_MERGE_OFFSET_M = 1.0, WALL_CORNER_MAX_M = 3;

function cleanWallOutline(ring) {
  const pts = ring.slice(0, -1);
  const lines = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len >= WALL_MIN_EDGE_M) lines.push({ a, b, len, dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] });
  }
  const sameLine = (l, m) => {
    const dot = l.dir[0] * m.dir[0] + l.dir[1] * m.dir[1];
    if (dot < Math.cos(WALL_MERGE_ANGLE)) return false;
    const off = Math.abs((m.a[0] - l.a[0]) * l.dir[1] - (m.a[1] - l.a[1]) * l.dir[0]);
    return off < WALL_MERGE_OFFSET_M;
  };
  // Merge runs of collinear edges (cyclically); the longest piece defines the line.
  const merged = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && sameLine(last.ref, l)) { last.b = l.b; if (l.len > last.ref.len) last.ref = l; }
    else merged.push({ a: l.a, b: l.b, ref: l });
  }
  if (merged.length > 1 && sameLine(merged[0].ref, merged[merged.length - 1].ref)) {
    const first = merged.shift(), last = merged[merged.length - 1];
    last.b = first.b; if (first.ref.len > last.ref.len) last.ref = first.ref;
  }
  if (merged.length < 3) return ring;
  const intersect = (l, m) => {
    const [p, r] = [l.ref.a, l.ref.dir], [q, t] = [m.ref.a, m.ref.dir];
    const den = r[0] * t[1] - r[1] * t[0];
    if (Math.abs(den) < 1e-6) return null;
    const u = ((q[0] - p[0]) * t[1] - (q[1] - p[1]) * t[0]) / den;
    return [p[0] + r[0] * u, p[1] + r[1] * u];
  };
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const l = merged[i], m = merged[(i + 1) % merged.length];
    let c = intersect(l, m);
    // Nearly parallel neighbours intersect absurdly far away (HR 4F/7F produced a 224 km wall). A corner
    // is only a corner if it lies near both edges' original ends; otherwise join those ends directly.
    if (c && (Math.hypot(c[0] - l.b[0], c[1] - l.b[1]) > WALL_CORNER_MAX_M || Math.hypot(c[0] - m.a[0], c[1] - m.a[1]) > WALL_CORNER_MAX_M)) c = null;
    // Parallel neighbours with a real step between them: keep both original endpoints.
    if (c) out.push(c); else out.push(l.b, m.a);
  }
  out.push(out[0]);
  return out;
}

function addRoomLowWalls(feature, origin, group) {
  for (const poly of ringsFromGeometry(feature.geometry)) {
    const ring = (poly[0] || []).map(pt => project(pt, origin));
    const outline = cleanWallOutline(ring);
    for (let i = 0; i < outline.length - 1; i++) {
      addDedupedWall(group, outline[i][0], outline[i][1], outline[i+1][0], outline[i+1][1]);
    }
  }
}

const STATUS_COLORS = {
  free: [COLORS.free, COLORS.freeSide],
  soon: [COLORS.soon, COLORS.soonSide],
  busy: [COLORS.room, COLORS.roomSide],
  unknown: [COLORS.unknown, COLORS.unknownSide],
};
const LABEL_KIND = { free: 'available', soon: 'soon', busy: 'busy', unknown: 'unknown' };

function styleForFeature(feature, floorId = currentFloor, lowWall = true) {
  const p = feature.properties;
  const cls = classifyFeature(p);
  if (cls === 'classroom') {
    // Each room keeps its own material pair, so a status change only recolours it (see restyleRooms).
    const kind = roomStatus(roomKey(p));
    return { depth: lowWall ? .07 : .22, z: .10, mats: materialPair(...STATUS_COLORS[kind]), kind };
  }
  if (cls === 'corridor') return { depth: .035, z: .08, mats: materialPair(COLORS.corridor, COLORS.corridorSide) };
  if (cls === 'vertical') return { depth: .12, z: .09, mats: materialPair(COLORS.vertical, COLORS.verticalSide) };
  if (cls === 'restroom') return { depth: .10, z: .09, mats: materialPair(COLORS.restroom, COLORS.restroomSide) };
  // Opaque: a semi-transparent space would let the faint neighbour floors bleed through the focused floor.
  if (cls === 'service') return { depth: .065, z: .08, mats: materialPair(COLORS.service, COLORS.serviceSide) };
  return null;
}

function addExtrudedFeature(feature, origin, group, { floorId = currentFloor, lowWall = true, zOffset = 0, interactive = true, includeLabels = true, targets = clickTargets, labelSink = labels, labelZ = zOffset } = {}) {
  const cls = classifyFeature(feature.properties);
  if (cls === 'skip' || cls === 'void') return;
  const style = styleForFeature(feature, floorId, lowWall);
  if (!style) return;

  for (const rings of ringsFromGeometry(feature.geometry)) {
    const shape = shapeFromRings(rings, origin);
    if (!shape) continue;
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: style.depth,
      bevelEnabled: cls !== 'corridor' && !lowWall,
      bevelSize: cls === 'classroom' ? .04 : .02,
      bevelThickness: cls === 'classroom' ? .03 : .015,
      bevelSegments: 1,
      curveSegments: 2,
    });
    const mesh = new THREE.Mesh(geom, style.mats);
    mesh.position.z = style.z + zOffset;
    mesh.castShadow = cls === 'classroom' || cls === 'vertical' || cls === 'restroom';
    mesh.receiveShadow = true;
    mesh.userData = { feature, cls, kind: style.kind, floorId, key: cls === 'classroom' ? roomKey(feature.properties) : null };
    group.add(mesh);

    if (cls === 'classroom') {
      if (interactive) targets.push(mesh);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom, 25),
        new THREE.LineBasicMaterial({ color: COLORS.outline, transparent: true, opacity: .24 })
      );
      edge.position.z = style.z + zOffset + .006;
      group.add(edge);
      if (lowWall) addRoomLowWalls(feature, origin, groupWithOffset(group, zOffset));
    } else if (cls === 'service' || cls === 'vertical' || cls === 'restroom') {
      // Plan-style boundaries between the many neutral spaces; only drawn on the focused floor.
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom, 25),
        new THREE.LineBasicMaterial({ color: COLORS.outline, transparent: true, opacity: 0, depthWrite: false })
      );
      edge.position.z = style.z + zOffset + .006;
      edge.userData.focusStyle = 'space';
      group.add(edge);
    }
  }

  if (includeLabels) addFeatureLabels(feature, origin, floorId, labelZ, labelSink);
}

// Lightweight wrapper that makes wall helpers place meshes at the current floor offset.
function groupWithOffset(group, zOffset) {
  return {
    add(mesh) {
      mesh.position.z += zOffset;
      group.add(mesh);
    }
  };
}

function addFeatureLabels(feature, origin, floorId, zOffset, sink) {
  const p = feature.properties;
  const cls = classifyFeature(p);
  if (cls === 'classroom' && p.classNumber) {
    const c = centroidOfGeometry(feature.geometry, origin);
    const key = roomKey(p);
    const label = { local: c.setZ(LABEL_Z + zOffset), text: p.classNumber, kind: LABEL_KIND[roomStatus(key)], key, role: 'room', floor: floorId, area: p.areaSquareMeters || 0 };
    // GIS sometimes splits one room into several polygons (CB 4F 414): colour all of them, label once,
    // on the largest piece.
    const i = sink.findIndex(l => l.key === key);
    if (i < 0) sink.push(label);
    else if (label.area > sink[i].area) sink[i] = label;
    return;
  }
  if (cls === 'vertical' || cls === 'restroom') {
    const c = centroidOfGeometry(feature.geometry, origin);
    const name = (p.use || p.name || '');
    let text = name.includes('電梯') ? '電梯' : name.includes('樓梯') ? '樓梯' : name.includes('廁') ? 'WC' : '';
    if (text) sink.push({ local: c.setZ(.46 + zOffset), text, kind: 'poi', role: 'room', floor: floorId });
  }
}

function getClassrooms(data) {
  return (data?.features || []).filter(f => classifyFeature(f.properties) === 'classroom' && f.properties.classNumber);
}

function toOccupancyMap(value) {
  if (!value) return null;
  return value instanceof Map ? value : new Map(Object.entries(value));
}

// Timetable stats of one floor, straight from the occupancy records (so rooms GIS cannot locate still
// count). total = rooms with a timetable; available = free + soon. Without occupancy the floor's GIS
// classrooms are counted with nothing available, so the overview still shows them.
function statsForFloor(data, floorId, bid = buildingId) {
  if (!occupancy) return { total: getClassrooms(data).length, available: 0, free: 0, unlocated: 0 };
  const prefix = `${bid}/${floorId}/`;
  let total = 0, available = 0, free = 0, unlocated = 0;
  for (const [key, rec] of occupancy) {
    if (!key.startsWith(prefix)) continue;
    total++;
    if (rec.status === 'free' || rec.status === 'soon') available++;
    if (rec.status === 'free') free++;
    if (key[prefix.length] === '?') unlocated++;
  }
  return { total, available, free, unlocated };
}

// Which occupancy keys of this building exist decides which spaces are rooms (walls, labels): a change
// in that set needs a rebuild, a change of statuses only a restyle.
function roomSignature(bid = buildingId) {
  if (!occupancy) return '';
  const prefix = `${bid}/`;
  return [...occupancy.keys()].filter(k => k.startsWith(prefix)).sort().join('|');
}

function badgeText(f) {
  return `${f.id} · ${f.stats.available}/${f.stats.total} 沒排課`;
}

// Apply new statuses without rebuilding geometry.
function restyleRooms() {
  for (const f of floors.values()) {
    for (const mesh of f.rooms) {
      const kind = roomStatus(mesh.userData.key);
      if (kind === mesh.userData.kind) continue;
      mesh.userData.kind = kind;
      mesh.material[0].color.setHex(STATUS_COLORS[kind][0]);
      mesh.material[1].color.setHex(STATUS_COLORS[kind][1]);
    }
    for (const l of f.labels) {
      if (!l.key) continue;
      l.kind = LABEL_KIND[roomStatus(l.key)];
      if (l.el) l.el.className = `label ${l.kind}`;
    }
    f.stats = statsForFloor(floorDatas[f.id], f.id);
    f.badge.text = badgeText(f);
    f.badge.kind = badgeKind(f.stats);
    if (f.badge.el) { f.badge.el.textContent = f.badge.text; f.badge.el.className = `label ${f.badge.kind}${hoverFloor === f.id ? ' hover' : ''}`; }
  }
}

function setOccupancy(value) {
  occupancy = toOccupancyMap(value);
  if (!started || !floors.size) return;
  if (roomSignature() !== builtRoomSig) {
    // The set of rooms changed (typically: first real data replacing none). Rebuild in place.
    const view = currentView, floor = focusFloor;
    buildBuilding();
    if (view === 'floor3d' && floors.has(floor)) showFloor(floor, { animate: false });
    else if (view === 'stacked') showOverview({ animate: false });
    else { setFadeTargets(); applyFades(true); emit('onViewChange', viewInfo()); }
  } else {
    restyleRooms();
    renderFloorRail();
    emit('onViewChange', viewInfo());
  }
  if (selectedRoom) {
    const mesh = floors.get(selectedRoom.floorId)?.rooms.find(m => m.userData.key === selectedRoom.key);
    if (mesh) showRoomSheet(mesh); else hideRoomSheet();
  }
}

// ---------------------------------------------------------------------------------------------
// Building: overview (exploded floors) <-> single floor
// ---------------------------------------------------------------------------------------------

// Overview layout. The floor gap is derived from the overview camera: a floor whose extent along the
// screen-up ground direction is E, seen at tilt t, is only fully visible above the next floor when
// gap >= E·cot(t); `gapRatio` adds the white space that makes each floor read as its own card.
// Only floors with classrooms appear in the overview. Runs of floors without classrooms collapse into
// a marker ("7F–13F 沒有教室") with `skipExtra` of extra gap, so a tall building still fits a phone.
// On a single floor every floor spreads back to an even, physical order (accordion-style), so the
// faint neighbours really are the floors directly above and below.
const STACK_LAYOUT = { gapRatio: 1.42, slabDepth: .7, skipExtra: .45 };
// Single floor: the floors directly above and below stay faintly visible for vertical context.
// Neighbours are filled (`neighborFade`) only while flying in, where they explain "you are entering this
// floor of the stack". After landing they shrink to a slab outline (`neighborOutline`): on polygonal
// buildings (CB has courtyards everywhere) filled ghosts showed through every gap and hurt legibility.
const FOCUS_LAYOUT = { neighborFade: .16, neighborOutline: .4, hoverFade: .28, durationMs: 650 };
// Seen at the steep overview tilt, full-height walls cover most of the room colour, so walls are
// squashed in the overview and grow to full height on the focused floor as the camera zooms in.
const OVERVIEW_WALL_SCALE = .2;
// Focused floor line work: a darker outer edge separates it from the neighbour outlines (fades in on
// landing). Per-space boundaries were tried and judged too busy (2026-10-03); `spaceEdges` stays 0 until
// every space gets low walls for campus navigation.
const FOCUS_STYLE = { outline: .85, spaceEdges: 0 };
// Semantic zoom: zooming *in* on the overview enters the floor under the fingers/cursor; zooming *out*
// past the fitted single floor returns to the overview. Both rubber-band before they trigger.
// Single floor zoom is relative to the default (overscanned) framing. The free range starts a bit below
// "whole floor visible" (`minMargin`), so the whole floor can always be seen with room around it. Only
// past that does it rubber-band, and only a clearly deliberate pull (`exitRatio` of the minimum, after
// banding) flies back to the overview.
// The same idea chains upward: zooming out on the floor overview (`exitScale`) flies back to the campus,
// and zooming in on a campus building with indoor data flies into its overview.
const SEMANTIC_ZOOM = { enterScale: 1.32, exitScale: .7, rubber: .45, minMargin: .9, exitRatio: .85, maxZoom: 3.5 };
// Campus <-> building flight: the selected white block dissolves while its floors appear at their real
// heights (`CAMPUS_FLOOR_HEIGHT` per storey) and then spread into the overview stack.
const CAMPUS_FLOOR_HEIGHT = 3.2;
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

const floorDataCache = {};
let floorDatas = {};
let floors = new Map(); // floorId -> { id, index, overviewZ, focusZ, group, slab, stats, rooms, hitMeshes, drawables, walls, labels, badge, mats, casters, fade, fadeTarget }
let skipMarkers = [];
let focusFloor = null;
let hoverFloor = null;
let builtPortrait = null;
let overviewHeading = 0; // per building, set by layoutFloors
let modeBlend = 0; // 0 = overview, 1 = single floor; tweened together with the camera
let campusBlend = 0; // 1 = campus white model, 0 = inside a building; tweened with the camera
// Shared world origin for the campus model and every building, so the camera can fly between them.
let WORLD_ORIGIN = null;
let campusMats = []; // { m, base, kind: 'selected' | 'other' | 'ground', mesh }
let campusBuildings = new Map(); // indoor buildingId -> { meshes, box, label }
let campusFocus = null; // { id, via: 'tap' | 'zoom' | 'return' } – highlighted building with its card
let floorDataResolved = {};
let lastCampusBlend = null, lastFloorVis = null;
let campusLabels = [];
let campusBuilt = false;

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

function overviewFloorIds() {
  const withRooms = STACK_ORDER.filter(id => floors.get(id)?.stats.total > 0);
  // A building with no timetabled rooms (行政大樓, 圖書館…) still has an overview: all of its floors.
  return withRooms.length ? withRooms : STACK_ORDER.filter(id => floors.has(id));
}

function isPortraitStage() {
  return root.clientWidth < root.clientHeight;
}
function overviewTilt(portrait = isPortraitStage()) {
  const p = VIEW_PRESETS.stacked;
  return portrait ? p.portraitTilt : p.tilt;
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Floor slab outline. The official building footprint is used when the floor fits inside it (A3T);
// some buildings' footprints do not match their floors (AM basements are much larger), so those floors
// fall back to the convex hull of their own spaces.
function slabOutline(data, origin, footprintM) {
  const fb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  footprintM.forEach(([x, y]) => { fb.minX = Math.min(fb.minX, x); fb.maxX = Math.max(fb.maxX, x); fb.minY = Math.min(fb.minY, y); fb.maxY = Math.max(fb.maxY, y); });
  const pts = data.features
    .filter(f => !['skip', 'void'].includes(classifyFeature(f.properties)))
    .flatMap(f => allCoords(f.geometry))
    .map(p => project(p, origin));
  if (!pts.length) return null;
  const tol = 2;
  const inside = pts.every(([x, y]) => x >= fb.minX - tol && x <= fb.maxX + tol && y >= fb.minY - tol && y <= fb.maxY + tol);
  return inside ? null : convexHull(pts);
}

function addSlab(origin, group, depth, floorId, hull) {
  const shapes = [];
  if (hull) {
    const s = new THREE.Shape();
    hull.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    s.closePath();
    shapes.push(s);
  } else if (buildingFeature) {
    for (const rings of ringsFromGeometry(buildingFeature.geometry)) {
      const s = shapeFromRings(rings, origin);
      if (s) { shapes.push(s); break; }
    }
  }
  const shape = shapes[0];
  if (!shape) return null;
  const geom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .05, bevelThickness: .03, bevelSegments: 1 });
  const mesh = new THREE.Mesh(geom, materialPair(COLORS.slabTop, COLORS.slabSide));
  mesh.position.z = .06 - depth;
  mesh.receiveShadow = true;
  mesh.userData = { floorLayer: true, floorId, outlinePoints: shape.getPoints() };
  group.add(mesh);
  return mesh;
}

function badgeKind(stats) {
  if (stats.available === 0) return 'floor-badge full';
  return stats.available >= Math.max(3, Math.ceil(stats.total * .55)) ? 'floor-badge open' : 'floor-badge partial';
}

function floorRunLabel(ids) {
  return ids.length === 1 ? ids[0] : `${ids[0]}–${ids[ids.length - 1]}`;
}

function buildBuilding() {
  builtRoomSig = roomSignature();
  clearGroup(buildingGroup);
  floors = new Map();
  skipMarkers = [];
  const origin = WORLD_ORIGIN;
  const footprintM = buildingFeature ? allCoords(buildingFeature.geometry).map(p => project(p, origin)) : [];

  const order = { corridor: 0, service: 1, vertical: 2, restroom: 3, classroom: 4, void: 8, skip: 9 };
  STACK_ORDER.forEach((id, index) => {
    const data = floorDatas[id] || { features: [] };
    const group = new THREE.Group();
    group.userData.floorId = id;
    buildingGroup.add(group);
    const floor = {
      id, index, group, stats: statsForFloor(data, id), overviewZ: 0, focusZ: 0,
      rooms: [], hitMeshes: [], drawables: [], walls: [], wallScale: null, labels: [], mats: [], casters: [], fade: 0, fadeTarget: 0,
      outline: null, outlineFade: 0, outlineTarget: 0,
    };
    floor.hull = slabOutline(data, origin, footprintM);
    floor.slab = addSlab(origin, group, STACK_LAYOUT.slabDepth, id, floor.hull);

    floorWalls = [];
    data.features
      .slice()
      .sort((a, b) => order[classifyFeature(a.properties)] - order[classifyFeature(b.properties)])
      .forEach(f => addExtrudedFeature(f, origin, group, {
        floorId: id, lowWall: true, interactive: true, includeLabels: true,
        targets: floor.rooms, labelSink: floor.labels, labelZ: 0,
      }));
    floorWalls = null;

    floor.spaceEdges = [];
    group.traverse(n => {
      if (!n.isMesh && !n.isLineSegments) return;
      floor.drawables.push(n);
      if (n.userData.focusStyle === 'space') { floor.spaceEdges.push(n); return; }
      if (n.isMesh) {
        floor.hitMeshes.push(n);
        if (n.geometry.type === 'BoxGeometry') floor.walls.push(n);
        if (n.castShadow) floor.casters.push(n);
      }
      // Always transparent so a floor can fade without a shader recompile.
      for (const m of [].concat(n.material)) { m.transparent = true; floor.mats.push({ m, base: m.opacity }); }
    });
    // Outline-only ghost, kept outside the floor group so it can show while the fill is hidden.
    const outlinePts = floor.slab?.userData.outlinePoints;
    if (outlinePts?.length) {
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(outlinePts.map(p => new THREE.Vector3(p.x, p.y, .08))),
        new THREE.LineBasicMaterial({ color: COLORS.outline, transparent: true, opacity: 0, depthWrite: false })
      );
      line.renderOrder = 1;
      line.visible = false;
      buildingGroup.add(line);
      floor.outline = line;
      // Outer edge of the focused floor, above the room fills, below the walls.
      const edge = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(outlinePts.map(p => new THREE.Vector3(p.x, p.y, .2))),
        new THREE.LineBasicMaterial({ color: COLORS.focusEdge, transparent: true, opacity: 0, depthWrite: false })
      );
      edge.renderOrder = 3;
      edge.visible = false;
      group.add(edge);
      floor.focusEdge = edge;
    }
    floors.set(id, floor);
  });

  // Local bounds per floor, computed once: per-frame code only offsets them by the group's z.
  for (const f of floors.values()) {
    f.group.position.z = 0;
    f.localBox = new THREE.Box3().setFromObject(f.group);
  }
  layoutFloors(origin, footprintM);
  addEntranceMarker(footprintM);
  rebuildLabels();
  setFadeTargets();
  applyFades(true);
  updateFloorPositions();
}

// Vertical layout for both modes, plus badge / skip-marker anchors.
function layoutFloors(origin, footprintM) {
  builtPortrait = isPortraitStage();
  const overviewIds = overviewFloorIds();
  // Extent of everything that is shown in the overview (footprint + hull floors).
  const pts = [...footprintM, ...overviewIds.flatMap(id => floors.get(id).hull || [])];
  // Entrance at the bottom (plan A), plus the overview's slight oblique offset.
  const heading = overviewHeading = entranceHeading() + VIEW_PRESETS.stacked.heading;
  const up = [-Math.sin(heading), Math.cos(heading)], right = [Math.cos(heading), Math.sin(heading)];
  const us = pts.map(p => p[0] * up[0] + p[1] * up[1]), rs = pts.map(p => p[0] * right[0] + p[1] * right[1]);
  const uMin = Math.min(...us), uMax = Math.max(...us);
  const gap = (uMax - uMin) / Math.tan(overviewTilt(builtPortrait)) * STACK_LAYOUT.gapRatio;
  const rBadge = Math.min(...rs) - 1.2, uMid = (uMin + uMax) / 2;
  const badgeXY = new THREE.Vector3(right[0] * rBadge + up[0] * uMid, right[1] * rBadge + up[1] * uMid, 0);

  // Single floor: even spacing, anchored so the lowest overview floor stays put.
  const base = overviewIds.length ? floors.get(overviewIds[0]).index : 0;
  for (const f of floors.values()) f.focusZ = (f.index - base) * gap;
  // Campus: real storey heights, 1F on the ground, so the floors fill the white block they replace.
  const ground = STACK_ORDER.indexOf('1F') >= 0 ? STACK_ORDER.indexOf('1F') : base;
  for (const f of floors.values()) f.campusZ = (f.index - ground) * CAMPUS_FLOOR_HEIGHT;

  // Overview: consecutive slots, with extra room where floors without classrooms were skipped.
  let slot = 0, prev = null;
  for (const id of overviewIds) {
    const f = floors.get(id);
    if (prev) {
      const skipped = STACK_ORDER.slice(prev.index + 1, f.index);
      const step = 1 + (skipped.length ? STACK_LAYOUT.skipExtra : 0);
      if (skipped.length) {
        skipMarkers.push({
          local: badgeXY.clone(), between: [prev.id, id],
          text: `${floorRunLabel(skipped)} 沒有教室`, kind: 'floor-skip', role: 'skip',
        });
      }
      slot += step;
    }
    f.overviewZ = slot * gap;
    prev = f;
  }
  // Floors that are hidden in the overview sit squeezed next to their nearest shown floor, so they
  // grow out of it during the accordion transition.
  const shown = overviewIds.map(id => floors.get(id));
  for (const f of floors.values()) {
    // Floors shown in the overview are already placed; with no timetabled rooms every floor is shown.
    if (!shown.length || shown.includes(f)) continue;
    const below = [...shown].reverse().find(s => s.index < f.index);
    const above = shown.find(s => s.index > f.index);
    if (below && above) f.overviewZ = below.overviewZ + (above.overviewZ - below.overviewZ) * (f.index - below.index) / (above.index - below.index);
    else if (below) f.overviewZ = below.overviewZ + (f.index - below.index) * gap * .08;
    else f.overviewZ = above.overviewZ - (above.index - f.index) * gap * .08;
  }
  for (const f of floors.values()) {
    f.badge = {
      local: badgeXY.clone(), text: badgeText(f),
      kind: badgeKind(f.stats), role: 'badge', floor: f.id,
    };
  }
}

// "正門" marker on 1F, just outside the middle of the entrance side of the footprint.
function addEntranceMarker(footprintM) {
  const ground = floors.get('1F');
  if (!ground || !footprintM.length) return;
  const b = (B().entranceBearing || 0) * Math.PI / 180;
  const v = [Math.sin(b), Math.cos(b)];
  const xs = footprintM.map(p => p[0]), ys = footprintM.map(p => p[1]);
  const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const reach = Math.max(...footprintM.map(p => (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1]));
  ground.labels.push({
    local: new THREE.Vector3(c[0] + v[0] * (reach + 2), c[1] + v[1] * (reach + 2), .5),
    text: '正門', kind: 'entrance', role: 'room', floor: '1F',
  });
}

function floorZ(f) {
  const inside = f.overviewZ + (f.focusZ - f.overviewZ) * modeBlend;
  return inside + ((f.campusZ ?? inside) - inside) * campusBlend;
}

// Floors appear early in a flight from the campus (as the white block dissolves) and vanish late on the
// way back.
function floorVisibility() {
  return 1 - THREE.MathUtils.smoothstep(campusBlend, .55, .95);
}

function updateFloorPositions() {
  for (const f of floors.values()) {
    f.group.position.z = floorZ(f);
    if (f.outline) f.outline.position.z = f.group.position.z;
  }
}

function rebuildLabels() {
  labels = [
    ...[...floors.values()].flatMap(f => [...f.labels, ...(f.stats.total ? [f.badge] : [])]),
    ...skipMarkers,
    ...campusLabels,
  ];
  refreshLabels();
}

function setFadeTargets() {
  const overview = new Set(overviewFloorIds());
  const focus = floors.get(focusFloor);
  for (const f of floors.values()) {
    let t = 0;
    if (currentView === 'stacked' || currentView === 'campus') t = overview.has(f.id) ? (hoverFloor && hoverFloor !== f.id ? FOCUS_LAYOUT.hoverFade : 1) : 0;
    const neighbour = currentView === 'floor3d' && focus && Math.abs(f.index - focus.index) === 1;
    if (currentView === 'floor3d' && focus) t = f.id === focus.id ? 1 : neighbour && isFlying() ? FOCUS_LAYOUT.neighborFade : 0;
    f.fadeTarget = t;
    f.outlineTarget = neighbour ? FOCUS_LAYOUT.neighborOutline : 0;
    // Only the focused floor casts shadows; otherwise upper floors would darken the ones below.
    const cast = currentView === 'floor3d' && f.id === focusFloor;
    f.casters.forEach(m => { m.castShadow = cast; });
    // The focused floor draws last, over the faint neighbours (which do not write depth), so a
    // neighbour only shows where the focused floor is not: context without muddying the map.
    const order = cast ? 2 : 1;
    f.drawables.forEach(n => { n.renderOrder = order; });
  }
}

function applyFades(dt) {
  const vis = floorVisibility();
  const visChanged = vis !== lastFloorVis;
  lastFloorVis = vis;
  for (const f of floors.values()) {
    if (f.outline && (f.outlineFade !== f.outlineTarget || dt === true || visChanged)) {
      let o = dt === true ? f.outlineTarget : f.outlineFade + (f.outlineTarget - f.outlineFade) * Math.min(1, dt * 9);
      if (Math.abs(o - f.outlineTarget) < .003) o = f.outlineTarget;
      f.outlineFade = o;
      f.outline.material.opacity = o * vis;
      f.outline.visible = o * vis > .004;
    }
    if (f.fade === f.fadeTarget && dt !== true && !visChanged) continue;
    let next = dt === true ? f.fadeTarget : f.fade + (f.fadeTarget - f.fade) * Math.min(1, dt * 9);
    if (Math.abs(next - f.fadeTarget) < .003) next = f.fadeTarget;
    f.fade = next;
    const k = next * vis;
    f.group.visible = k > .004;
    for (const { m, base } of f.mats) {
      m.opacity = base * k;
      m.depthWrite = k > .6; // faint neighbours must not hide the focused floor
    }
  }
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

function updateWallHeights() {
  for (const f of floors.values()) {
    const grow = currentView === 'floor3d' && f.id === focusFloor ? modeBlend : 0;
    const k = OVERVIEW_WALL_SCALE + (1 - OVERVIEW_WALL_SCALE) * grow;
    if (f.wallScale !== null && Math.abs(k - f.wallScale) < 1e-3) continue;
    f.wallScale = k;
    for (const w of f.walls) { w.scale.z = k; w.position.z = WALL.base + WALL.height * k / 2; }
  }
}

function updateFocusStyle() {
  for (const f of floors.values()) {
    const k = currentView === 'floor3d' && f.id === focusFloor ? THREE.MathUtils.smoothstep(modeBlend, .5, 1) * f.fade : 0;
    if (f.focusStyleK !== undefined && Math.abs(k - f.focusStyleK) < 1e-3) continue;
    f.focusStyleK = k;
    if (f.focusEdge) { f.focusEdge.material.opacity = FOCUS_STYLE.outline * k; f.focusEdge.visible = k > .004 && FOCUS_STYLE.outline > 0; }
    for (const e of f.spaceEdges) { e.material.opacity = FOCUS_STYLE.spaceEdges * k; e.visible = k > .004 && FOCUS_STYLE.spaceEdges > 0; }
  }
}

function updateClickTargets() {
  if (currentView === 'campus') return;
  if (currentView === 'stacked') {
    clickTargets = overviewFloorIds().flatMap(id => [floors.get(id).slab, ...floors.get(id).rooms].filter(Boolean));
  } else {
    // Everything on the focused floor counts as "the building"; a miss means empty space.
    clickTargets = floors.get(focusFloor)?.hitMeshes || [];
  }
}

// Bounding box of a floor as it will be once the layout for `mode` is reached (or right now).
function floorBoxAt(f, mode) {
  const z = mode === 'floor3d' ? f.focusZ : mode === 'campus' ? f.campusZ : mode === 'stacked' ? f.overviewZ : f.group.position.z;
  return f.localBox.clone().translate(new THREE.Vector3(0, 0, z));
}

function overviewBox() {
  const box = new THREE.Box3();
  overviewFloorIds().forEach(id => box.union(floorBoxAt(floors.get(id), 'stacked')));
  return box;
}

function badgeWidth() {
  return Math.max(0, ...[...root.querySelectorAll('.label.floor-badge, .label.floor-skip')].map(el => el.offsetWidth));
}

// Keep the shadow-casting light (and its shadow frustum) centred on what is being looked at.
function aimSun(center, z = 0) {
  sun.target.position.set(center.x, center.y, z);
  sun.position.set(center.x + 45, center.y - 35, z + 80);
}

function showOverview({ animate = true } = {}) {
  currentView = 'stacked';
  focusFloor = null;
  hoverFloor = null;
  endGesture(true);
  hideRoomSheet();
  const box = overviewBox();
  aimSun(box.getCenter(new THREE.Vector3()), 0);
  setFadeTargets();
  updateClickTargets();
  updateChrome();
  goToPose(computeFit(box, 'stacked', { leftExtra: badgeWidth() + 4 }), animate, { locked: animate });
}

function showFloor(floorId, { animate = true } = {}) {
  const floor = floors.get(floorId);
  if (!floor) return;
  currentView = 'floor3d';
  focusFloor = currentFloor = floorId;
  hoverFloor = null;
  endGesture(true);
  hideRoomSheet();
  const box = floorBoxAt(floor, 'floor3d');
  aimSun(box.getCenter(new THREE.Vector3()), floor.focusZ);
  setFadeTargets();
  updateClickTargets();
  updateChrome();
  goToPose(computeFit(box, 'floor3d'), animate, { locked: animate });
  setFadeTargets(); // now that the flight exists, neighbours are filled for its duration
}

// Hovering (or pressing, on touch) a floor in the overview keeps it solid and fades the others.
function setStackHover(floorId) {
  if (currentView !== 'stacked' || floorId === hoverFloor) return;
  hoverFloor = floorId;
  setFadeTargets();
  labels.forEach(l => l.el?.classList.toggle('hover', l.role === 'badge' && !!floorId && l.floor === floorId));
  renderer.domElement.style.cursor = floorId ? 'pointer' : '';
}

function sortedFloorIds(id) {
  const info = buildingIndex.buildings.find(b => b.buildingId === id);
  if (!info) throw new Error(`building ${id} is not in building-index.json`);
  return info.floorIds.slice().sort((a, b) => floorRank(a) - floorRank(b));
}

// Floor GeoJSON per building, fetched once. Kept as a promise so a background preload and a tap that
// arrives mid-download share the same request.
function fetchBuildingFloors(id) {
  return Promise.all(sortedFloorIds(id).map(floorId => {
    const key = `${id}/${floorId}`;
    floorDataCache[key] ??= source.floor(id, floorId)
      .catch(err => { delete floorDataCache[key]; throw err; }) // allow a retry after a network error
      .then(d => {
        if (d) return d;
        emit('onError', { type: 'floor-missing', building: id, floor: floorId, status: 404 });
        return { features: [] };
      })
      .then(d => (floorDataResolved[key] = d));
    return floorDataCache[key];
  }));
}

async function loadBuildingData(id) {
  const order = sortedFloorIds(id);
  const datas = await fetchBuildingFloors(id);
  STACK_ORDER = order;
  FLOOR_ORDER = STACK_ORDER.slice().reverse();
  // A building without an official footprint still works: slabs fall back to each floor's hull.
  buildingFeature = buildingsData.features.find(f => f.properties.buildingId === id) || null;
  floorDatas = Object.fromEntries(STACK_ORDER.map((floorId, i) => [floorId, datas[i]]));
}

async function switchBuilding(id, { view = 'stacked', floor = null } = {}) { // view: 'stacked' | 'floor3d' | 'keep'
  if (!BUILDINGS[id] || destroyed) return;
  try {
    await loadBuildingData(id);
  } catch (error) {
    emit('onError', { type: 'building-load-failed', building: id, error });
    return;
  }
  if (destroyed) return;
  buildingId = id;
  // Campus is rebuilt so the dissolving block is the new building.
  clearGroup(campusGroup); campusLabels = []; campusMats = []; campusBuildings = new Map(); campusBuilt = false; lastCampusBlend = null;
  if (view !== 'keep') modeBlend = view === 'floor3d' ? 1 : 0;
  buildBuilding();
  if (view === 'keep') {
    if (currentView === 'campus') { buildCampus(); clickTargets = campusClickTargets(); updateChrome(); }
    return;
  }
  if (view === 'floor3d') showFloor(floor && floors.has(floor) ? floor : defaultFloorId(), { animate: false });
  else showOverview({ animate: false });
}

// Floor to open when none is asked for: the one with the most rooms free per the timetable.
function defaultFloorId() {
  let best = null, bestN = -1;
  for (const id of overviewFloorIds()) {
    const n = floors.get(id).stats.available;
    if (n > bestN) { bestN = n; best = id; }
  }
  return best || STACK_ORDER.find(id => floors.has(id));
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

function createCampusBuilding(feature, origin) {
  const id = feature.properties.buildingId;
  const selected = id === buildingId; // dissolves into its floors during a flight
  const hasIndoor = !!BUILDINGS[id];
  const entry = hasIndoor ? { meshes: [], box: new THREE.Box3(), label: null } : null;
  const h = estimateBuildingHeight(id);
  for (const rings of ringsFromGeometry(feature.geometry)) {
    const shape = shapeFromRings(rings, origin);
    if (!shape) continue;
    const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelSize: .08, bevelThickness: .08, bevelSegments: 1 });
    const mats = materialPair(COLORS.campus, COLORS.campusSide);
    const mesh = new THREE.Mesh(geom, mats);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { building: feature, selected };
    campusGroup.add(mesh);
    if (entry) { entry.meshes.push(mesh); geom.computeBoundingBox(); entry.box.union(geom.boundingBox); }
    for (const m of mats) { m.transparent = true; campusMats.push({ m, base: 1, kind: selected ? 'selected' : 'other', mesh }); }
  }
  if (hasIndoor) {
    const c = centroidOfGeometry(feature.geometry, origin);
    const area = Number(feature.properties.buildingAreaSquareMeters) || 0;
    entry.label = { local: c.setZ(h + 1.1), text: BUILDINGS[id].short || BUILDINGS[id].name, kind: 'building', role: 'campus', building: id, area };
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
  const near = f => {
    const [x, y] = project(centroid(f), { lon: c[0], lat: c[1] });
    return Math.hypot(x, y) <= opts.campusRadiusM;
  };
  return (campusFeatureCache = buildingsData.features.filter(f => f.properties.campusId === 'A' || (BUILDINGS[f.properties.buildingId] && near(f))));
}

function campusClickTargets() {
  return campusGroup.children.filter(m => m.userData.building);
}

function buildCampus() {
  const main = campusFeatures();
  const origin = WORLD_ORIGIN;
  main.forEach(f => createCampusBuilding(f, origin));
  const [minX, minY] = project([origin.minLon, origin.minLat], origin);
  const [maxX, maxY] = project([origin.maxLon, origin.maxLat], origin);
  const groundMat = new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1, transparent: true });
  campusMats.push({ m: groundMat, base: 1, kind: 'ground' });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry((maxX - minX) + 35, (maxY - minY) + 35), groundMat);
  ground.position.set((minX + maxX) / 2, (minY + maxY) / 2, -.08);
  ground.receiveShadow = true;
  campusGroup.add(ground);
  campusBuilt = true;
  campusBox = null;
  lastCampusBlend = null;
  rebuildLabels();
  applyCampusFocusStyle();
}

// ---- campus focus: highlight + card ----
function setCampusFocus(focus) {
  const same = campusFocus?.id === focus?.id && campusFocus?.via === focus?.via;
  campusFocus = focus;
  // Fetch its floors while the user is still deciding, so entering does not wait on the network.
  if (focus && !same) { try { fetchBuildingFloors(focus.id).catch(() => {}); } catch { /* not indexed */ } }
  if (!same) applyCampusFocusStyle();
}

function applyCampusFocusStyle() {
  for (const [id, entry] of campusBuildings) {
    const on = campusFocus?.id === id;
    for (const mesh of entry.meshes) {
      mesh.material[0].color.setHex(on ? COLORS.selected : COLORS.campus);
      mesh.material[1].color.setHex(on ? COLORS.selectedSide : COLORS.campusSide);
    }
    if (entry.label?.el) entry.label.el.className = `label ${on ? 'selected-building' : 'building'}`;
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
  let id = hitTest(zoomAnchor.x, zoomAnchor.y)?.object.userData.building?.properties.buildingId;
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
  setFadeTargets();
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
    pose = { ...fit, target: entry.box.getCenter(new THREE.Vector3()).setZ(0), zoom };
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
  // Ground direction that should read as "up" on screen.
  const ux = -Math.sin(pose.heading), uy = Math.cos(pose.heading);
  cam.position.set(pose.target.x - ux * d * sinT, pose.target.y - uy * d * sinT, pose.target.z + d * cosT);
  cam.up.set(ux, uy, 0);
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
function isFlying() { return !!tween?.locked; }
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
    if (pose.blend !== undefined) modeBlend = pose.blend;
    if (pose.campus !== undefined) campusBlend = pose.campus;
    updateCamera();
    debugPanel?.sync();
    return;
  }
  tween = {
    from: { target: viewState.target.clone(), heading: viewState.heading, tilt: viewState.tilt, orthoHeight: viewState.orthoHeight, zoom: viewState.zoom, blend: modeBlend, campus: campusBlend },
    to: { ...pose, zoom: pose.zoom ?? 1, blend: pose.blend ?? modeBlend, campus: pose.campus ?? campusBlend },
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
  modeBlend = lerp(from.blend, to.blend);
  campusBlend = lerp(from.campus, to.campus);
  updateCamera();
  if (k >= 1) {
    const wasFlight = tween.locked;
    tween = null;
    viewState.heading = to.heading;
    // A wheel stream still running when the flight lands keeps the lock until it pauses.
    if (wasFlight) {
      clearTimeout(wheelIdleTimer); wheelIdleTimer = setTimeout(() => { wheelLocked = false; }, 220);
      setFadeTargets(); // landed: filled neighbours fade to outlines
    }
    debugPanel?.sync();
  }
}

// Re-frame the current view (reset button, resize) without changing what is shown.
function fitCurrent(animate) {
  if (currentView === 'campus') goToPose(computeFit(new THREE.Box3().setFromObject(campusGroup), 'campus'), animate);
  else if (currentView === 'stacked') goToPose(computeFit(overviewBox(), 'stacked', { leftExtra: badgeWidth() + 4 }), animate);
  else goToPose(computeFit(floorBoxAt(floors.get(focusFloor), 'floor3d'), 'floor3d'), animate);
}

// Point on the horizontal plane at height z under a screen position (orthographic, so always defined).
function groundPoint(clientX, clientY, z) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const { origin, direction } = raycaster.ray;
  if (Math.abs(direction.z) < 1e-6) return null;
  const t = (z - origin.z) / direction.z;
  return origin.clone().addScaledVector(direction, t);
}

function focusPlaneZ() {
  if (currentView === 'campus') return 0;
  const f = floors.get(focusFloor);
  return f ? f.group.position.z + .1 : 0;
}

function isNavigableView() {
  return currentView === 'floor3d' || currentView === 'campus' || currentView === 'stacked';
}

// Keep the content reachable: the view centre may not leave the floor's footprint / the campus.
function clampTarget() {
  const f = currentView === 'campus' ? null : floors.get(focusFloor);
  if (!f && currentView !== 'campus') return;
  const box = currentView === 'campus' ? (campusBox ??= new THREE.Box3().setFromObject(campusGroup)) : floorBoxAt(f, 'now');
  viewState.target.x = THREE.MathUtils.clamp(viewState.target.x, box.min.x, box.max.x);
  viewState.target.y = THREE.MathUtils.clamp(viewState.target.y, box.min.y, box.max.y);
}

// Change zoom/heading while keeping the floor point under (clientX, clientY) fixed on screen.
function setViewAnchored(changes, clientX, clientY, anchorWorld = null) {
  const z = focusPlaneZ();
  const before = anchorWorld || groundPoint(clientX, clientY, z);
  Object.assign(viewState, changes);
  updateCamera();
  const after = groundPoint(clientX, clientY, z);
  if (before && after) {
    viewState.target.x += before.x - after.x;
    viewState.target.y += before.y - after.y;
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
    floors: STACK_ORDER.filter(id => floors.has(id)).map(id => ({ id, ...floors.get(id).stats })),
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
  for (const floor of FLOOR_ORDER) {
    const btn = document.createElement('button');
    const stats = floors.get(floor)?.stats;
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
// Labels
// ---------------------------------------------------------------------------------------------

function makeLabelElement(label) {
  const el = document.createElement('div');
  el.className = `label ${label.kind || ''}`;
  el.textContent = label.text;
  if (label.role === 'badge') {
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (currentView === 'stacked') showFloor(label.floor);
    });
    el.addEventListener('pointerenter', () => setStackHover(label.floor));
    el.addEventListener('pointerleave', () => setStackHover(null));
  }
  root.appendChild(el);
  label.el = el;
}
function refreshLabels() {
  root.querySelectorAll('.label').forEach(el => el.remove());
  labels.forEach(makeLabelElement);
}
function refreshLabelsIfNeeded() {
  if (labels.some(l => !l.el)) refreshLabels();
}

function labelOpacity(l) {
  if (l.role === 'campus') return campusBlend;
  // Overview badges: fade in as the campus fades out, and out again while zooming into a floor.
  if (l.role === 'badge' || l.role === 'skip') return (1 - modeBlend) * THREE.MathUtils.smoothstep(1 - campusBlend, .5, 1);
  // Room / POI labels: only the focused floor, fading in as the camera arrives.
  if (currentView !== 'floor3d' || l.floor !== focusFloor) return 0;
  const arrive = THREE.MathUtils.smoothstep(modeBlend, .55, 1);
  // Declutter: when the floor is drawn small (e.g. A3T's long side across a portrait phone), stair / WC
  // badges would sit on top of room numbers. Room numbers win; facilities come back as you zoom in.
  if (l.kind === 'poi') return arrive * THREE.MathUtils.smoothstep(pixelsPerMeter(), LABEL_DECLUTTER.poiFrom, LABEL_DECLUTTER.poiTo);
  return arrive;
}

const LABEL_DECLUTTER = { poiFrom: 6, poiTo: 8.5 }; // screen px per metre
function pixelsPerMeter() {
  return root.clientHeight / (viewState.orthoHeight / viewState.zoom);
}

const labelWorld = new THREE.Vector3();
// World position of a label, or null when the floor it belongs to no longer exists (a label must never
// break the render loop).
function labelPosition(l) {
  labelWorld.copy(l.local);
  if (l.between) {
    const [a, b] = l.between.map(id => floors.get(id)?.group.position.z);
    if (a === undefined || b === undefined) return null;
    labelWorld.z += (a + b) / 2;
  } else if (l.floor && l.role !== 'campus') {
    const f = floors.get(l.floor);
    if (!f) return null;
    labelWorld.z += f.group.position.z;
  }
  return labelWorld;
}

// Labels on the focused floor avoid each other: the entrance first, then classrooms (larger rooms
// first), then facilities. A label that would overlap one already placed is hidden until zooming in
// makes room. A label that is currently hidden needs a few extra pixels to come back (no flicker).
const LABEL_COLLISION = { gap: 2, hysteresis: 4 };
function labelPriority(l) {
  if (l.role === 'campus') return l.kind === 'selected-building' ? 4 : 2 + Math.min(l.area || 0, 20000) / 40000;
  if (l.kind === 'entrance') return 3;
  if (l.kind === 'poi') return 1;
  return 2 + Math.min(l.area || 0, 5000) / 10000;
}

function updateLabelPositions() {
  const W = root.clientWidth, H = root.clientHeight;
  const placed = [];
  const candidates = [];
  for (const l of labels) {
    if (!l.el) continue;
    const op = labelOpacity(l);
    if (op < .02) { if (l.el.style.visibility !== 'hidden') l.el.style.visibility = 'hidden'; l.collided = false; continue; }
    const world = labelPosition(l);
    const p = world && world.project(camera);
    if (!p || !(p.z > -1 && p.z < 1)) { l.el.style.visibility = 'hidden'; continue; }
    l.sx = (p.x * .5 + .5) * W;
    l.sy = (-p.y * .5 + .5) * H;
    l.op = op;
    if (l.role === 'room' || l.role === 'campus') candidates.push(l); else placeLabel(l, false);
  }
  candidates.sort((a, b) => labelPriority(b) - labelPriority(a));
  for (const l of candidates) {
    if (!l.w) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
    const m = LABEL_COLLISION.gap + (l.collided ? LABEL_COLLISION.hysteresis : 0);
    const r = { x0: l.sx - l.w / 2 - m, x1: l.sx + l.w / 2 + m, y0: l.sy - l.h / 2 - m, y1: l.sy + l.h / 2 + m };
    l.collided = placed.some(q => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
    if (!l.collided) placed.push({ x0: l.sx - l.w / 2, x1: l.sx + l.w / 2, y0: l.sy - l.h / 2, y1: l.sy + l.h / 2 });
    placeLabel(l, l.collided);
  }
}

function placeLabel(l, hidden) {
  l.el.style.visibility = 'visible';
  l.el.style.opacity = hidden ? '0' : l.op.toFixed(3);
  l.el.style.pointerEvents = l.role === 'badge' && l.op > .5 ? 'auto' : 'none';
  l.el.style.left = `${l.sx}px`;
  l.el.style.top = `${l.sy}px`;
}

// ---------------------------------------------------------------------------------------------
// Room selection (the host renders the sheet)
// ---------------------------------------------------------------------------------------------

function roomInfo(mesh) {
  const p = mesh.userData.feature.properties;
  const floorId = mesh.userData.floorId;
  const key = `${buildingId}/${floorId}/${p.classNumber}`;
  return {
    key, buildingId, buildingName: B().name, floorId, classNumber: p.classNumber,
    gisName: p.name || p.use || '', status: mesh.userData.kind || 'unknown',
    occupancy: occupancy?.get(key) || null,
  };
}
function showRoomSheet(mesh) {
  selectedRoom = roomInfo(mesh);
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

function hitTest(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(clickTargets, false)[0];
}

// Overview floor under a screen point, or the one whose badge is vertically closest.
function overviewFloorAt(clientX, clientY) {
  const hit = hitTest(clientX, clientY)?.object.userData.floorId;
  if (hit) return hit;
  const rect = root.getBoundingClientRect();
  let best = null, bestD = Infinity;
  for (const id of overviewFloorIds()) {
    const w = labelPosition(floors.get(id).badge);
    if (!w) continue;
    const p = w.project(camera);
    const y = (-p.y * .5 + .5) * rect.height + rect.top;
    const d = Math.abs(y - clientY);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function handleTap(clientX, clientY) {
  const hit = hitTest(clientX, clientY);
  if (currentView === 'campus') {
    const b = hit?.object.userData.building?.properties;
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
    const floorId = hit?.object.userData.floorId;
    if (floorId) showFloor(floorId);
  } else if (hit?.object.userData.cls === 'classroom') {
    showRoomSheet(hit.object);
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
    anchor: isNavigableView() ? groundPoint(p.midX, p.midY, focusPlaneZ()) : null,
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
  const box = overviewBox();
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
let lastOverviewZoom = null, readyFloor = null;
function updateOverviewReadiness() {
  if (currentView !== 'stacked' || isFlying() || modeBlend > .01 || campusBlend > .01) {
    lastOverviewZoom = null;
    if (readyFloor) setReadyFloor(null);
    return;
  }
  const zoomingIn = lastOverviewZoom !== null && viewState.zoom > lastOverviewZoom * 1.0005;
  lastOverviewZoom = viewState.zoom;
  let ready = null, readyDist = Infinity;
  if (viewState.zoom > 1.01) {
    for (const id of overviewFloorIds()) {
      const m = boxScreenMetrics(floorBoxAt(floors.get(id), 'now'), camera);
      if (m.visible >= .6 && m.height >= OVERVIEW_NAV.readyHeight && m.centerDist < readyDist) { ready = id; readyDist = m.centerDist; }
    }
  }
  setReadyFloor(ready);
  if (!zoomingIn || !zoomAnchor) return;
  // The floor under the zoom centre; pinching between floors or beside the stack falls back to the floor
  // that takes the most of the view.
  let id = hitTest(zoomAnchor.x, zoomAnchor.y)?.object.userData.floorId;
  if (!floors.get(id)) {
    let best = 0;
    for (const fid of overviewFloorIds()) {
      const h = boxScreenMetrics(floorBoxAt(floors.get(fid), 'now'), camera).height;
      if (h > best) { best = h; id = fid; }
    }
  }
  const f = floors.get(id);
  if (f && boxScreenMetrics(floorBoxAt(f, 'now'), camera).height >= OVERVIEW_NAV.enterHeight) showFloor(id);
}
function setReadyFloor(id) {
  if (id === readyFloor) return;
  readyFloor = id;
  for (const f of floors.values()) f.badge?.el?.classList.toggle('ready', f.id === id);
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
    if (currentView === 'stacked' && e.pointerType !== 'mouse') setStackHover(hitTest(e.clientX, e.clientY)?.object.userData.floorId || null);
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
    if (currentView === 'stacked' && !tween && e.pointerType === 'mouse') setStackHover(hitTest(e.clientX, e.clientY)?.object.userData.floorId || null);
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
      const z = focusPlaneZ();
      const a = groundPoint(gesture.lastX, gesture.lastY, z), b = groundPoint(e.clientX, e.clientY, z);
      if (a && b) { viewState.target.x += a.x - b.x; viewState.target.y += a.y - b.y; clampTarget(); updateCamera(); }
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

// Rebuild the building for the current orientation (the overview gap depends on the overview tilt)
// and put the user back where they were.
function rebuildBuilding() {
  buildBuilding();
  if (currentView !== 'campus') { setFadeTargets(); applyFades(true); updateClickTargets(); fitCurrent(false); }
}

function resize() {
  if (destroyed) return;
  renderer.setSize(root.clientWidth, root.clientHeight, false);
  if (!started) return;
  cachedInsets = safeInsets();
  for (const entry of campusBuildings.values()) entry.fill1 = undefined; // campus framing changed
  if (currentView !== 'campus' && builtPortrait !== null && builtPortrait !== isPortraitStage()) rebuildBuilding();
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
  const dt = Math.min(.1, (now - lastFrame) / 1000);
  lastFrame = now;
  stepTween(now);
  updateFloorPositions();
  applyFades(dt);
  updateCampusFade();
  updateCampusReadiness();
  updateOverviewReadiness();
  if (currentView === 'campus') updateCampusCard();
  updateWallHeights();
  updateFocusStyle();
  updateCompass();
  refreshLabelsIfNeeded();
  updateLabelPositions();
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
  const overviewApply = () => rebuildBuilding();
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
      ['neighborFade', 0, .6, .02, raw, () => FOCUS_LAYOUT, () => setFadeTargets()],
      ['neighborOutline', 0, 1, .02, raw, () => FOCUS_LAYOUT, () => setFadeTargets()],
      ['outline', 0, 1, .02, raw, () => FOCUS_STYLE, () => floors.forEach(f => { f.focusStyleK = undefined; })],
      ['spaceEdges', 0, 1, .02, raw, () => FOCUS_STYLE, () => floors.forEach(f => { f.focusStyleK = undefined; })],
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
  window.__indoorDebug = { floors: () => floors, overviewBox, floorBoxAt, viewState, camera, boxScreenMetrics, overviewFloorIds, zoomOverviewAt };
}

async function start() {
  setupDebugPanel();
  try {
    ({ buildingIndex, buildingsData } = await source.load());
  } catch (error) {
    emit('onError', { type: 'load-failed', error });
    return;
  }
  if (destroyed) return;
  WORLD_ORIGIN = geoBounds(campusFeatures());
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
    try { fetchBuildingFloors(id).catch(() => {}); } catch { /* not in building-index: skipped */ }
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
  clearGroup(buildingGroup);
  clearGroup(campusGroup);
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
  railEl.remove();
  compassEl.remove();
  root.querySelectorAll('.label').forEach(el => el.remove());
  debugEl?.remove();
  root.classList.remove('indoor-map');
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
  else if (target === 'floor3d') showFloor(floor && floors.has(floor) ? floor : defaultFloorId(), { animate });
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
  const mesh = floors.get(f)?.rooms.find(m => m.userData.key === key);
  if (!mesh) return false;
  showRoomSheet(mesh);
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
  clearSelection: () => hideRoomSheet(),
  getView: () => viewInfo(),
  destroy,
};
}
