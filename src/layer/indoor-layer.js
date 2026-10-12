import * as THREE from 'three';
import { allCoords, createProjector, geoBounds } from '../data/frame.js';
import {
  DEFAULT_BUILDINGS, classifyFeature, loadCampus, roomKey, roomSignature, roomStatus, sortedFloorIds, statsForFloor, toOccupancyMap,
} from '../data/indoor.js';
import { DEFAULT_PALETTE, buildFloor, disposeTree, extrudeUp, fillMaterial, paintRanges, statusColors } from './geometry.js';
import { elevation as elevationOf, floorLayout, floorRunLabel, inplaceLayout, overviewIds, stackLayout } from './layout.js';

// IndoorLayer: the indoor floors of one or more buildings as a THREE.Group plus the state machine that lays
// them out and fades them (docs/LAYER.md). It never touches a renderer, a camera or the DOM: the host adds
// `layer.object` to its scene, calls `update(dt)` every frame and draws labels from `labels()` itself.

// Single floor: the floors directly above and below stay faintly visible for vertical context.
// Neighbours are filled (`neighborFade`) only while a presentation change is animating, where they explain
// "you are entering this floor of the stack". After landing they shrink to a slab outline (`neighborOutline`):
// on polygonal buildings (CB has courtyards everywhere) filled ghosts showed through every gap.
// `hoverFade`: the other floors while one is hovered in the stack.
// `inplaceFill` / `inplaceOutline`: every floor at its real height, faint fill + slab outline.
const STYLE = { neighborFade: .16, neighborOutline: .4, hoverFade: .28, inplaceFill: .18, inplaceOutline: .55 };
// Seen at the steep overview tilt, full-height walls cover most of the room colour, so walls are squashed
// outside the focused floor and grow to full height as the presentation reaches 'floor'.
const OVERVIEW_WALL_SCALE = .2;
// Focused floor line work: a darker outer edge separates it from the neighbour outlines (fades in on
// landing). Per-space boundaries were judged too busy (2026-10-03); `spaceEdges` stays 0.
const FOCUS_STYLE = { outline: .85, spaceEdges: 0 };
const SELECT_TINT = .14, HOVER_TINT = .08;

export const easeInOutCubic = k => (k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = (a, b, e) => a + (b - a) * e;

export function createIndoorLayer(options = {}) {
  const opts = {
    buildings: DEFAULT_BUILDINGS,
    occupancy: null,
    floorHeight: 3.2,
    groundY: 0,
    palette: null,
    fog: false,
    shadows: null,
    renderOrderBase: 0,
    onError: null,
    lonlatOrigin: null,
    // Host hooks (docs/LAYER.md「宿主掛鉤」). Defaults reproduce the course site exactly.
    stackFloors: 'classrooms',
    badgeText: null,
    selectable: null,
    spaceLabel: null,
    spaceClass: null,
    badgeAnchor: 'middle',
    ...options,
  };
  if (!['classrooms', 'all'].includes(opts.stackFloors)) throw new TypeError(`createIndoorLayer: stackFloors must be 'classrooms' or 'all'`);
  const ALL_FLOORS = opts.stackFloors === 'all';
  const isSelectable = opts.selectable || (info => info.cls === 'classroom');
  const hook = (name, fallback, ...args) => {
    try { return opts[name](...args); } catch (err) { console.error(`[indoor-layer] ${name} failed`, err); return fallback; }
  };
  const source = opts.source;
  if (!source) throw new TypeError('createIndoorLayer: options.source is required');
  const BUILDINGS = opts.buildings || DEFAULT_BUILDINGS;
  const COLORS = { ...DEFAULT_PALETTE, ...(opts.palette || {}) };
  const STATUS = statusColors(COLORS);
  const castShadows = !!opts.shadows?.cast;
  const receiveShadows = opts.shadows?.receive ?? true;
  const fog = !!opts.fog;
  const RO = opts.renderOrderBase || 0;
  // Fills go opaque at rest (stack overview, fully shown): no blending, early depth rejection. A host that sets
  // renderOrderBase draws the floors after its own transparent objects, an order that only exists in the
  // transparent pass, so its floors stay transparent.
  const OPAQUE_AT_REST = RO === 0;
  const emitError = e => { try { opts.onError?.(e); } catch (err) { console.error('[indoor-layer] onError handler failed', err); } };

  // lonlat sources are projected around a reference point: the host's (the viewer passes its campus
  // centre), else the centre of campus "A".
  let defaultRef = null;
  const project = createProjector(source.frame ?? 'lonlat', () => {
    const o = typeof opts.lonlatOrigin === 'function' ? opts.lonlatOrigin() : opts.lonlatOrigin;
    return o || defaultRef;
  });

  const object = new THREE.Group();
  object.name = 'indoor-layer';
  // Shader warm-up: fills switch between transparent and opaque, which are two programs. A degenerate opaque
  // triangle drawn for the first frames compiles the opaque one at load, not when the first flight lands.
  let warm = null, warmUpdates = 0;
  if (OPAQUE_AT_REST) {
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color']) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(9), 3));
    warm = new THREE.Mesh(g, fillMaterial({ fog, transparent: false }));
    warm.frustumCulled = false;
    warm.receiveShadow = receiveShadows;
    warm.name = 'indoor-warmup';
    object.add(warm);
  }
  let occupancy = toOccupancyMap(opts.occupancy);
  let disposed = false;

  const built = new Map();     // buildingId -> building record
  const loading = new Map();   // buildingId -> Promise<void>
  const floorCache = new Map(); // "B/F" -> Promise<FeatureCollection>

  async function campus() {
    const data = await loadCampus(source);
    if (!defaultRef && (source.frame ?? 'lonlat') !== 'planar-cm') {
      const a = data.buildingsData.features.filter(f => f.properties.campusId === 'A');
      defaultRef = geoBounds(a.length ? a : data.buildingsData.features);
    }
    return data;
  }

  // Floor GeoJSON per building, fetched once. Kept as a promise so a preload and a load that arrives
  // mid-download share the same request; a failed request can be retried.
  async function fetchFloors(id) {
    const data = await campus();
    const order = sortedFloorIds(data.buildingIndex, id);
    const datas = await Promise.all(order.map(floorId => {
      const key = `${id}/${floorId}`;
      if (!floorCache.has(key)) {
        const p = Promise.resolve().then(() => source.floor(id, floorId))
          .catch(err => { floorCache.delete(key); throw err; })
          .then(d => {
            if (d) return d;
            emitError({ type: 'floor-missing', building: id, floor: floorId, status: 404 });
            return { features: [] };
          });
        floorCache.set(key, p);
      }
      return floorCache.get(key);
    }));
    return { data, order, datas };
  }

  function prefetch(id) {
    if (disposed) return Promise.resolve();
    return fetchFloors(id).then(() => {});
  }

  function load(id) {
    if (disposed) return Promise.resolve();
    if (built.has(id)) return Promise.resolve();
    if (!loading.has(id)) {
      const p = fetchFloors(id).then(({ data, order, datas }) => {
        if (disposed || built.has(id)) return;
        const rec = {
          id, group: new THREE.Group(), order, floors: new Map(), datas: Object.fromEntries(order.map((f, i) => [f, datas[i]])),
          feature: data.buildingsData.features.find(f => f.properties.buildingId === id) || null,
          sig: null, labels: [], skipMarkers: [], footprintM: [], spaces: new Map(),
        };
        rec.group.name = `indoor-${id}`;
        rec.group.visible = false;
        object.add(rec.group);
        built.set(id, rec);
        buildBuilding(rec);
      }).finally(() => loading.delete(id));
      loading.set(id, p);
    }
    return loading.get(id);
  }

  function clearBuilding(rec) {
    for (const child of [...rec.group.children]) { rec.group.remove(child); disposeTree(child); }
    rec.floors = new Map();
  }

  // SpaceInfo of every drawn space of one floor (Map feature → info; rec.spaces: key → info).
  // Keys: classrooms "B/F/classNumber" (as always); other spaces "B/F/number" when they are that number's
  // primary space (GIS id "B/F/number", or the first one with it), otherwise their own GIS id ("B/F/501#2",
  // "B/F/~hash"); spaces without an id get "B/F/#n".
  function floorSpaces(rec, floorId, features) {
    const byFeature = new Map();
    const prefix = `${rec.id}/${floorId}/`;
    const primary = new Map();
    for (const f of features) {
      const p = f.properties, n = p.classNumber;
      if (n && (!primary.has(n) || p.spaceId === prefix + n)) primary.set(n, p.name ?? null);
    }
    features.forEach((f, i) => {
      const p = f.properties;
      let cls = classifyFeature(p, occupancy);
      if (cls === 'skip' || cls === 'void') return;
      const base = {
        key: '', buildingId: rec.id, floorId, id: p.spaceId ?? null, type: p.name ?? null, typeEn: p.nameEn ?? null,
        number: p.classNumber ?? null, category: p.category1 ?? null, cls, area: p.areaSquareMeters || 0, selectable: false,
      };
      if (opts.spaceClass) {
        const c = hook('spaceClass', null, Object.freeze({ ...base }));
        if (c) base.cls = cls = c;
      }
      base.key = cls === 'classroom' ? roomKey(p)
        : p.classNumber && primary.get(p.classNumber) === (p.name ?? null) ? prefix + p.classNumber
          : p.spaceId ? (String(p.spaceId).startsWith(prefix) ? String(p.spaceId) : `${prefix}#${p.spaceId}`) : `${prefix}#${i}`;
      base.selectable = !!(opts.selectable ? hook('selectable', false, Object.freeze({ ...base })) : isSelectable(base));
      const info = Object.freeze(base);
      byFeature.set(f, info);
      const prev = rec.spaces.get(info.key);
      if (!prev || info.area > prev.area) rec.spaces.set(info.key, info); // split polygons: the largest piece
    });
    return byFeature;
  }

  function buildBuilding(rec) {
    clearBuilding(rec);
    rec.sig = roomSignature(rec.id, occupancy);
    rec.footprintM = rec.feature ? allCoords(rec.feature.geometry).map(p => project(p)) : [];
    rec.spaces = new Map();
    rec.order.forEach((floorId, index) => {
      const features = rec.datas[floorId]?.features || [];
      const spaces = floorSpaces(rec, floorId, features);
      const clsOf = new Map([...spaces].map(([f, info]) => [f.properties, info.cls]));
      const floor = buildFloor({
        buildingId: rec.id, floorId, index, features, occupancy, project, palette: COLORS, fog,
        receiveShadow: receiveShadows, footprintFeature: rec.feature, footprintM: rec.footprintM,
        spaceOf: f => spaces.get(f) || null,
        ...(opts.spaceClass ? { classify: p => clsOf.get(p) ?? classifyFeature(p, occupancy) } : {}),
        ...(opts.spaceLabel ? { labelFor: info => hook('spaceLabel', null, info) } : {}),
      });
      floor.stats = statsForFloor(features, rec.id, floorId, occupancy);
      floor.y = 0;
      rec.group.add(floor.group);
      if (floor.outline) rec.group.add(floor.outline);
      rec.floors.set(floorId, floor);
    });
    // Floor badges, skip markers and the entrance marker. Badge anchors are placed per presentation.
    const list = floorList(rec);
    const stack = stackLayout(list, { gap: 1, all: ALL_FLOORS });
    rec.skipMarkers = stack.skips.map(s => ({
      id: `skip:${rec.id}/${s.between[0]}-${s.between[1]}`, local: new THREE.Vector3(), between: s.between,
      text: `${floorRunLabel(s.ids)} 沒有教室`, kind: 'skip', role: 'skip', priority: 0,
    }));
    for (const f of rec.floors.values()) {
      f.badge = { id: `badge:${rec.id}/${f.id}`, local: new THREE.Vector3(), text: '', kind: '', role: 'badge', floor: f.id, priority: 0 };
      updateBadge(f);
    }
    addEntranceMarker(rec);
    rec.labels = [];
    for (const f of rec.floors.values()) {
      let poi = 0;
      for (const l of f.labels) {
        l.id ??= l.key ? `room:${l.key}` : l.kind === 'entrance' ? `entrance:${rec.id}` : `poi:${rec.id}/${f.id}/${poi++}`;
        l.priority ??= labelPriority(l);
        l.position = new THREE.Vector3();
        l.opacity = 0;
        rec.labels.push(l);
      }
      if (ALL_FLOORS || f.stats.total) rec.labels.push(f.badge);
    }
    for (const l of rec.skipMarkers) rec.labels.push(l);
    for (const l of [...rec.skipMarkers, ...[...rec.floors.values()].map(f => f.badge)]) { l.position ??= new THREE.Vector3(); l.opacity = 0; }
    rec.anchorRight = null;
    rec.roomIndex = new Map();
    for (const f of rec.floors.values()) for (const piece of f.pieces) {
      if (!piece.key) continue;
      piece.floor = f;
      if (!rec.roomIndex.has(piece.key)) rec.roomIndex.set(piece.key, []);
      rec.roomIndex.get(piece.key).push(piece);
    }
    applyRoomLooks(rec);
  }

  // Labels on a floor avoid each other in the overlay: the entrance first, then classrooms (larger rooms
  // first), then facilities.
  function labelPriority(l) {
    if (l.kind === 'entrance') return 3;
    if (l.kind === 'poi') return 1;
    return 2 + Math.min(l.area || 0, 5000) / 10000;
  }

  // "正門" marker on 1F, just outside the middle of the entrance side of the footprint.
  function addEntranceMarker(rec) {
    const ground = rec.floors.get('1F');
    const fm = rec.footprintM;
    if (!ground || !fm.length) return;
    const b = (BUILDINGS[rec.id]?.entranceBearing || 0) * Math.PI / 180;
    const v = [Math.sin(b), -Math.cos(b)]; // ground [x, z] towards the entrance
    const xs = fm.map(p => p[0]), zs = fm.map(p => p[1]);
    const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
    const reach = Math.max(...fm.map(p => (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1]));
    ground.labels.push({
      local: new THREE.Vector3(c[0] + v[0] * (reach + 2), .5, c[1] + v[1] * (reach + 2)),
      text: '正門', kind: 'entrance', role: 'room', floor: '1F',
    });
  }

  function badgeKind(stats) {
    if (stats.available === 0) return 'full';
    return stats.available >= Math.max(3, Math.ceil(stats.total * .55)) ? 'open' : 'partial';
  }
  function updateBadge(f) {
    if (opts.badgeText) {
      const text = hook('badgeText', null, { id: f.id, ...f.stats });
      f.badge.hidden = text == null;
      f.badge.text = text == null ? '' : String(text);
    } else f.badge.text = `${f.id} · ${f.stats.available}/${f.stats.total} 沒排課`;
    f.badge.kind = badgeKind(f.stats);
    f.badge.stats = f.stats;
  }

  const floorList = rec => rec.order.filter(id => rec.floors.has(id)).map((id, index) => ({ id, index: rec.floors.get(id).index, total: rec.floors.get(id).stats.total }));
  const overviewOf = rec => overviewIds(floorList(rec), { all: ALL_FLOORS });
  const overviewSet = rec => new Set(overviewOf(rec));

  // Ground points [x, z] of everything the stack overview shows: the footprint plus the hull of every
  // overview floor that does not fit it. Hosts derive the stack gap for their camera from it.
  function outlinePoints(id) {
    const rec = built.get(id);
    if (!rec) return [];
    return [...rec.footprintM, ...overviewOf(rec).flatMap(fid => rec.floors.get(fid).hull || [])];
  }

  // Badge / skip-marker anchor: beside the overview's left edge as seen with `right` pointing screen-right.
  function placeAnchors(rec, right) {
    rec.anchorRight = right;
    const pts = outlinePoints(rec.id);
    if (!pts.length) return;
    const up = [right[1], -right[0]];
    const us = pts.map(p => p[0] * up[0] + p[1] * up[1]), rs = pts.map(p => p[0] * right[0] + p[1] * right[1]);
    const uMin = Math.min(...us), uMax = Math.max(...us);
    // 'near': at the edge facing the camera, which under perspective is the stack's leftmost point on screen.
    const rBadge = Math.min(...rs) - 1.2, uMid = opts.badgeAnchor === 'near' ? uMin + Math.min(4, (uMax - uMin) / 4) : (uMin + uMax) / 2;
    const x = right[0] * rBadge + up[0] * uMid, z = right[1] * rBadge + up[1] * uMid;
    for (const f of rec.floors.values()) f.badge.local.set(x, 0, z);
    for (const s of rec.skipMarkers) s.local.set(x, 0, z);
  }

  // ---- presentation ----
  let pres = Object.freeze({ building: null, mode: 'stack', floor: null });
  let shown = null;     // building whose group is visible: the presented one, or the one leaving
  let blend = 0;        // 0 = stack / inplace, 1 = single floor
  let presence = 0;     // 0 = not shown, 1 = shown; visibility = smoothstep(presence, .05, .45)
  let stackness = 1;    // 1 = floor badges belong on screen (stack, or leaving), 0 = inplace / single floor
  let tween = null;
  let hoverFloor = null, hoverKey = null, selectedKey = null, selectOutline = null;
  let emissiveK = 0;
  let lastVis = null;
  let targets = new Map(); // floorId -> target y of the presented building

  function normalise(p) {
    const building = p.building ?? null;
    const rec = building ? built.get(building) : null;
    const mode = p.mode || 'stack';
    const h = opts.floorHeight;
    const n = {
      building, mode, floor: mode === 'floor' ? (p.floor ?? null) : null,
      stackGap: p.stackGap ?? h * 3, skipExtra: p.skipExtra ?? .45, floorGap: p.floorGap ?? h,
      focusY: p.focusY, screenRight: p.screenRight ?? null,
      animate: !!p.animate, duration: p.duration ?? 650, easing: p.easing ?? easeInOutCubic,
    };
    if (!['inplace', 'stack', 'floor'].includes(mode)) throw new Error(`unknown presentation mode ${mode}`);
    if (building && !rec) throw new Error(`building ${building} is not loaded; await layer.load('${building}') first`);
    if (building && mode === 'floor' && !rec.floors.has(n.floor)) throw new Error(`floor ${n.floor} of ${building} does not exist`);
    if (building && mode === 'floor' && n.focusY === undefined) n.focusY = Math.max(elevation(building, n.floor), opts.groundY);
    return n;
  }

  // Target base y of every floor for the presentation (or, leaving, the inplace layout of `rec`).
  function layoutFor(rec, p) {
    const list = floorList(rec);
    if (!p.building || p.mode === 'inplace') return inplaceLayout(list, { floorHeight: opts.floorHeight, groundY: opts.groundY });
    if (p.mode === 'stack') return stackLayout(list, { gap: p.stackGap, skipExtra: p.skipExtra, all: ALL_FLOORS }).y;
    return floorLayout(list, p.floor, { focusY: p.focusY, floorGap: p.floorGap });
  }

  function setPresentation(p = {}) {
    if (disposed) return Promise.resolve(false);
    let next;
    try { next = normalise(p); } catch (err) { return Promise.reject(err); }
    if (tween) { const t = tween; tween = null; t.resolve(false); }
    const prevShown = shown;
    const { animate, duration, easing, ...rest } = next;
    pres = Object.freeze(rest);
    hoverFloor = null;
    const rec = next.building ? built.get(next.building) : null;
    let arriving = false;
    if (next.building !== prevShown) {
      if (next.building === null && animate && prevShown) {
        // leaving: the previous building drops to its real heights and fades out
      } else {
        if (prevShown) built.get(prevShown).group.visible = false;
        shown = next.building;
        if (rec) { arriving = true; rec.group.visible = true; }
      }
    }
    const target = shown ? built.get(shown) : null;
    if (rec && (next.screenRight || !rec.anchorRight)) placeAnchors(rec, next.screenRight || rec.anchorRight || [1, 0]);
    if (arriving) {
      // null → X: start from the real heights, invisible, flat (no single floor yet).
      const start = inplaceLayout(floorList(rec), { floorHeight: opts.floorHeight, groundY: opts.groundY });
      for (const f of rec.floors.values()) f.y = start.get(f.id);
      blend = 0; presence = animate ? 0 : 1;
      stackness = next.mode === 'stack' ? 1 : 0;
      for (const f of rec.floors.values()) f.wallScale = null, f.focusStyleK = undefined;
    }
    targets = target ? layoutFor(target, next) : new Map();
    const to = {
      blend: next.building && next.mode === 'floor' ? 1 : 0,
      presence: next.building ? 1 : 0,
      stackness: !next.building || next.mode === 'stack' ? 1 : 0,
    };
    if (!animate || !target) {
      blend = to.blend; presence = to.presence; stackness = to.stackness;
      if (target) for (const f of target.floors.values()) f.y = targets.get(f.id);
      if (!next.building && shown) { built.get(shown).group.visible = false; shown = null; }
      setFadeTargets();
      if (target && next.building) { applyPositions(); applyFades(true); updateWalls(); updateFocusStyle(); }
      applyOpacity();
      refreshSelection();
      return Promise.resolve(true);
    }
    const from = { blend, presence, stackness, y: new Map([...target.floors.values()].map(f => [f.id, f.y])) };
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    tween = { t: 0, duration: Math.max(1, duration), easing, from, to, resolve };
    setFadeTargets();
    if (arriving) { for (const f of target.floors.values()) { f.fade = f.fadeTarget; f.outlineFade = f.outlineTarget; } applyPositions(); applyFades(true); }
    applyOpacity();
    refreshSelection();
    return promise;
  }

  function setFadeTargets() {
    const rec = shown ? built.get(shown) : null;
    if (!rec) return;
    const mode = pres.building ? pres.mode : 'leave';
    const overview = overviewSet(rec);
    const focus = mode === 'floor' ? rec.floors.get(pres.floor) : null;
    const flying = !!tween;
    for (const f of rec.floors.values()) {
      let t = 0, o = 0;
      if (mode === 'stack' || mode === 'leave') t = overview.has(f.id) ? (mode === 'stack' && hoverFloor && hoverFloor !== f.id ? STYLE.hoverFade : 1) : 0;
      else if (mode === 'inplace') { t = STYLE.inplaceFill; o = STYLE.inplaceOutline; }
      const neighbour = !!focus && Math.abs(f.index - focus.index) === 1;
      if (focus) t = f === focus ? 1 : neighbour && flying ? STYLE.neighborFade : 0;
      if (neighbour) o = STYLE.neighborOutline;
      f.fadeTarget = t;
      f.outlineTarget = o;
      // Only the focused floor casts shadows; otherwise upper floors would darken the ones below.
      const cast = !!focus && f === focus;
      f.casters.forEach(m => { m.castShadow = castShadows && cast; });
      // The focused floor draws last, over the faint neighbours (which do not write depth), so a
      // neighbour only shows where the focused floor is not: context without muddying the map.
      const order = (cast ? 2 : 1) + RO;
      f.drawables.forEach(n => { n.renderOrder = order; });
      if (f.outline) f.outline.renderOrder = 1 + RO;
      if (f.focusEdge) f.focusEdge.renderOrder = 3 + RO;
    }
  }

  function applyPositions() {
    const rec = shown ? built.get(shown) : null;
    if (!rec) return;
    for (const f of rec.floors.values()) {
      f.group.position.y = f.y;
      if (f.outline) f.outline.position.y = f.y;
    }
  }

  // Exponential approach of every floor's fill and outline to its target; `dt === true` jumps.
  function applyFades(dt) {
    const rec = shown ? built.get(shown) : null;
    if (!rec) return false;
    const vis = smoothstep(presence, .05, .45);
    const visChanged = vis !== lastVis;
    lastVis = vis;
    let moving = false;
    for (const f of rec.floors.values()) {
      if (f.outline && (f.outlineFade !== f.outlineTarget || dt === true || visChanged)) {
        let o = dt === true ? f.outlineTarget : f.outlineFade + (f.outlineTarget - f.outlineFade) * Math.min(1, dt * 9);
        if (Math.abs(o - f.outlineTarget) < .003) o = f.outlineTarget;
        f.outlineFade = o;
        f.outline.material.opacity = o * vis;
        f.outline.visible = o * vis > .004;
        if (o !== f.outlineTarget) moving = true;
      }
      if (f.fade === f.fadeTarget && dt !== true && !visChanged) continue;
      let next = dt === true ? f.fadeTarget : f.fade + (f.fadeTarget - f.fade) * Math.min(1, dt * 9);
      if (Math.abs(next - f.fadeTarget) < .003) next = f.fadeTarget;
      f.fade = next;
      if (next !== f.fadeTarget) moving = true;
      const k = next * vis;
      f.group.visible = k > .004;
      for (const { m, base } of f.mats) {
        m.opacity = base * k;
        m.depthWrite = k > .6; // faint neighbours must not hide the focused floor
      }
    }
    return moving;
  }

  function updateWalls() {
    const rec = shown ? built.get(shown) : null;
    if (!rec) return false;
    let changed = false;
    for (const f of rec.floors.values()) {
      const grow = pres.building && pres.mode === 'floor' && f.id === pres.floor ? blend : 0;
      const k = OVERVIEW_WALL_SCALE + (1 - OVERVIEW_WALL_SCALE) * grow;
      if (f.wallScale !== null && Math.abs(k - f.wallScale) < 1e-3) continue;
      f.wallScale = k;
      changed = true;
      if (f.meshes.walls) f.meshes.walls.scale.y = k; // built with its bottom at y = 0, standing at WALL.base
    }
    return changed;
  }

  function updateFocusStyle() {
    const rec = shown ? built.get(shown) : null;
    if (!rec) return false;
    let changed = false;
    for (const f of rec.floors.values()) {
      const k = pres.building && pres.mode === 'floor' && f.id === pres.floor ? smoothstep(blend, .5, 1) * f.fade : 0;
      if (f.focusStyleK !== undefined && Math.abs(k - f.focusStyleK) < 1e-3) continue;
      f.focusStyleK = k;
      changed = true;
      if (f.focusEdge) { f.focusEdge.material.opacity = FOCUS_STYLE.outline * k; f.focusEdge.visible = k > .004 && FOCUS_STYLE.outline > 0; }
      for (const e of f.spaceEdges) { e.material.opacity = FOCUS_STYLE.spaceEdges * k; e.visible = k > .004 && FOCUS_STYLE.spaceEdges > 0; }
    }
    return changed;
  }

  // Fully shown overview floors at rest draw opaque; anything fading, flying or ghosted stays transparent.
  function applyOpacity() {
    const rec = shown ? built.get(shown) : null;
    if (!rec || !OPAQUE_AT_REST) return;
    const rest = !tween && pres.building === rec.id && pres.mode === 'stack' && lastVis === 1;
    for (const f of rec.floors.values()) {
      const opaque = rest && f.fade === 1 && f.fadeTarget === 1;
      for (const m of f.fills) if (m.transparent === opaque) { m.transparent = !opaque; m.needsUpdate = true; }
    }
  }

  function update(dt) {
    if (disposed) return false;
    let moving = false;
    const rec = shown ? built.get(shown) : null;
    if (tween && rec) {
      tween.t += dt * 1000;
      const k = Math.min(1, tween.t / tween.duration);
      const e = tween.easing(k);
      const { from, to } = tween;
      blend = lerp(from.blend, to.blend, e);
      presence = lerp(from.presence, to.presence, e);
      stackness = lerp(from.stackness, to.stackness, e);
      for (const f of rec.floors.values()) f.y = lerp(from.y.get(f.id), targets.get(f.id), e);
      moving = true;
      if (k >= 1) {
        const t = tween;
        tween = null;
        blend = to.blend; presence = to.presence; stackness = to.stackness;
        for (const f of rec.floors.values()) f.y = targets.get(f.id);
        setFadeTargets(); // landed: filled neighbours fade to outlines
        if (!pres.building) { rec.group.visible = false; shown = null; }
        t.resolve(true);
      }
    } else if (tween) {
      const t = tween; tween = null; t.resolve(true);
    }
    applyPositions();
    if (applyFades(dt)) moving = true;
    if (updateWalls()) moving = true;
    if (updateFocusStyle()) moving = true;
    applyOpacity();
    if (warm && ++warmUpdates > 2) { object.remove(warm); disposeTree(warm); warm = null; }
    return moving || !!tween;
  }

  // ---- queries ----
  function floorTargetY(rec, f) {
    return rec.id === shown && targets.has(f.id) ? targets.get(f.id) : f.y;
  }
  function floorBox(id, floorId) {
    const rec = built.get(id), f = rec?.floors.get(floorId);
    if (!f) return null;
    return f.localBox.clone().translate(new THREE.Vector3(0, floorTargetY(rec, f), 0));
  }
  // Union of the floors the presentation shows (stack: the overview subset; otherwise every floor).
  function buildingBox(id) {
    const rec = built.get(id);
    if (!rec) return null;
    const ids = id === pres.building && pres.mode === 'stack' ? overviewOf(rec) : [...rec.floors.keys()];
    const box = new THREE.Box3();
    ids.forEach(fid => box.union(floorBox(id, fid)));
    return box;
  }
  function roomBox(key) {
    const [b] = String(key).split('/');
    const rec = built.get(b);
    const piece = rec?.roomIndex.get(key)?.[0];
    if (!piece) return null;
    object.updateWorldMatrix(true, false);
    return piece.box.clone().translate(new THREE.Vector3(0, floorTargetY(rec, piece.floor), 0)).applyMatrix4(object.matrixWorld);
  }
  function floors(id) {
    const rec = built.get(id);
    if (!rec) return [];
    return rec.order.filter(fid => rec.floors.has(fid)).map(fid => ({ id: fid, ...rec.floors.get(fid).stats }));
  }
  function elevation(id, floorId) {
    const rec = built.get(id);
    if (!rec) return null;
    return elevationOf(floorList(rec), floorId, { floorHeight: opts.floorHeight, groundY: opts.groundY });
  }
  function room(key) {
    const [b] = String(key).split('/');
    const rec = built.get(b);
    const piece = rec?.roomIndex.get(key)?.[0];
    if (!piece) return null;
    const p = piece.feature.properties;
    const floorId = piece.floor.id;
    return {
      key, buildingId: b, buildingName: BUILDINGS[b]?.name ?? b, floorId, classNumber: p.classNumber,
      gisName: p.name || p.use || '', status: piece.kind || 'unknown',
      occupancy: occupancy?.get(key) || null,
    };
  }
  // Any drawn space of a loaded building (selectable or not), by key.
  function space(key) {
    const [b] = String(key).split('/');
    return built.get(b)?.spaces.get(String(key)) ?? null;
  }
  // Every drawn space of a loaded building, one entry per key, floors bottom to top.
  function spaces(id) {
    const rec = built.get(id);
    return rec ? [...rec.spaces.values()] : [];
  }

  // Label data of the shown building, world positions and opacities for the current frame. Room labels
  // are shown on the focused floor only; floor badges and skip markers belong to the stack. Pixel-density
  // declutter is the overlay's job.
  const worldTmp = new THREE.Vector3();
  function labels() {
    const rec = shown ? built.get(shown) : null;
    if (!rec) return [];
    object.updateWorldMatrix(true, false);
    const m = object.matrixWorld;
    const floorMode = pres.building && pres.mode === 'floor';
    const arrive = smoothstep(blend, .55, 1);
    // Equals (1 − blend) between stack and floor; inplace keeps badges off.
    const stackOpacity = Math.min(stackness, 1 - blend) * smoothstep(presence, .5, 1);
    for (const l of rec.labels) {
      worldTmp.copy(l.local);
      if (l.between) {
        const [a, b] = l.between.map(id => rec.floors.get(id).group.position.y);
        worldTmp.y += (a + b) / 2;
        l.opacity = stackOpacity;
      } else {
        worldTmp.y += rec.floors.get(l.floor).group.position.y;
        l.opacity = l.role === 'badge' ? (l.hidden ? 0 : stackOpacity) : floorMode && l.floor === pres.floor ? arrive : 0;
      }
      l.position.copy(worldTmp).applyMatrix4(m);
    }
    return rec.labels;
  }

  // ---- picking ----
  // Each floor has one flat proxy (space top faces + slab) whose triangles map to floor.pieces. Stack: slabs
  // and selectable spaces; single floor: any space, or a wall (the merged wall mesh); inplace: slabs.
  function pick(raycaster) {
    const rec = shown && pres.building ? built.get(shown) : null;
    if (!rec) return null;
    const mode = pres.mode;
    const list = mode === 'floor' ? [rec.floors.get(pres.floor)].filter(Boolean)
      : mode === 'stack' ? overviewOf(rec).map(id => rec.floors.get(id)) : [...rec.floors.values()];
    object.updateMatrixWorld(true);
    let best = null;
    const consider = (hit, f, piece) => { if (!best || hit.distance < best.hit.distance) best = { hit, f, piece }; };
    for (const f of list) {
      if (f.proxy) {
        for (const hit of raycaster.intersectObject(f.proxy, false)) {
          const piece = f.pieces[f.proxy.userData.pieces[hit.faceIndex]];
          if (mode === 'inplace' ? !piece.slab : mode === 'stack' ? !piece.slab && !piece.key : false) continue;
          consider(hit, f, piece);
          break;
        }
      }
      if (mode === 'floor' && f.meshes.walls) {
        const hit = raycaster.intersectObject(f.meshes.walls, false)[0];
        if (hit) consider(hit, f, null);
      }
    }
    if (!best) return null;
    const { hit, f, piece } = best;
    const base = { building: rec.id, floor: f.id, point: hit.point, distance: hit.distance, object: hit.object };
    if (!piece) return { kind: 'space', cls: 'wall', space: null, ...base };
    if (piece.key) return { kind: 'room', key: piece.key, cls: piece.cls, space: piece.space ?? null, ...base };
    if (piece.slab) return { kind: 'floor', ...base };
    return { kind: 'space', cls: piece.cls, space: piece.space ?? null, ...base };
  }

  // ---- room looks: status colour, hover / selection tint, emissive (all in vertex colours) ----
  const topColor = new THREE.Color(), sideColor = new THREE.Color(), accent = new THREE.Color();
  function roomLook(piece) {
    const [top, side] = piece.kind ? STATUS[piece.kind] || STATUS.unknown : piece.base || STATUS.unknown;
    const tint = piece.key === selectedKey ? SELECT_TINT : piece.key === hoverKey ? HOVER_TINT : 0;
    accent.setHex(COLORS.accent);
    topColor.setHex(top); sideColor.setHex(side);
    if (tint) { topColor.lerp(accent, tint); sideColor.lerp(accent, tint); }
    paintRanges(piece.floor.meshes[piece.mesh].geometry.attributes.color, piece.ranges, topColor, sideColor);
  }
  function applyEmissive(rec) {
    for (const f of rec.floors.values()) for (const m of f.fills) m.emissive.setScalar(emissiveK);
  }
  function applyRoomLooks(rec) {
    for (const k of [selectedKey, hoverKey]) if (k) for (const piece of rec.roomIndex.get(k) || []) roomLook(piece);
    if (emissiveK) applyEmissive(rec);
  }

  // Selection outline: the room's edges in the accent colour, just above its fill (one object per piece of
  // the selected room).
  function refreshSelection() {
    if (selectOutline) { selectOutline.parent?.remove(selectOutline); disposeTree(selectOutline); selectOutline = null; }
    if (!selectedKey) return;
    const [b] = selectedKey.split('/');
    const rec = built.get(b);
    const pieces = rec?.roomIndex.get(selectedKey);
    if (!pieces) return;
    const g = new THREE.Group();
    for (const piece of pieces) {
      // Drawn over the low walls that stand on the room's edges.
      const mat = new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: .9, depthWrite: false, depthTest: false });
      mat.fog = fog;
      const solid = extrudeUp(piece.shape, { depth: piece.depth, bevelEnabled: false, curveSegments: 2 });
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(solid, 25), mat);
      solid.dispose();
      line.position.y = piece.y + .012;
      line.renderOrder = 4 + RO;
      g.add(line);
    }
    selectOutline = g;
    pieces[0].floor.group.add(g);
  }

  function restyle(rec) {
    for (const f of rec.floors.values()) {
      for (const piece of f.pieces) {
        if (!piece.key || piece.cls !== 'classroom') continue;
        const kind = roomStatus(occupancy, piece.key);
        if (kind === piece.kind) continue;
        piece.kind = kind;
        roomLook(piece);
      }
      for (const l of f.labels) if (l.key && l.status) l.kind = roomStatus(occupancy, l.key);
      f.stats = statsForFloor(rec.datas[f.id]?.features, rec.id, f.id, occupancy);
      updateBadge(f);
    }
  }

  // Returns true when a building had to be rebuilt (the set of rooms changed), false for a recolour.
  function setOccupancy(value) {
    occupancy = toOccupancyMap(value);
    let rebuilt = false;
    for (const rec of built.values()) {
      if (roomSignature(rec.id, occupancy) === rec.sig) { restyle(rec); continue; }
      rebuilt = true;
      const anchor = rec.anchorRight;
      buildBuilding(rec);
      if (rec.id === shown) {
        // Rebuilt in place: jump to where the presentation lands.
        if (tween) { const t = tween; tween = null; t.resolve(false); }
        if (!pres.building) { rec.group.visible = false; shown = null; continue; }
        placeAnchors(rec, anchor || [1, 0]);
        targets = layoutFor(rec, pres);
        for (const f of rec.floors.values()) f.y = targets.get(f.id);
        blend = pres.mode === 'floor' ? 1 : 0; presence = 1; stackness = pres.mode === 'stack' ? 1 : 0;
        rec.group.visible = true;
        lastVis = null;
        setFadeTargets(); applyPositions(); applyFades(true); updateWalls(); updateFocusStyle();
        refreshSelection();
      }
    }
    return rebuilt;
  }

  function setHoveredFloor(floorId) {
    floorId = floorId ?? null;
    if (floorId === hoverFloor) return;
    hoverFloor = pres.mode === 'stack' ? floorId : null;
    setFadeTargets();
  }
  function setRoomState(which, key) {
    key = key ?? null;
    const old = which === 'hover' ? hoverKey : selectedKey;
    if (old === key) return;
    if (which === 'hover') hoverKey = key; else selectedKey = key;
    for (const k of [old, key]) {
      if (!k) continue;
      const rec = built.get(k.split('/')[0]);
      for (const piece of rec?.roomIndex.get(k) || []) roomLook(piece);
    }
    if (which === 'select') refreshSelection();
  }
  function setEmissive(k) {
    emissiveK = Math.max(0, Math.min(1, Number(k) || 0));
    for (const rec of built.values()) applyEmissive(rec);
  }

  function unload(id) {
    const rec = built.get(id);
    if (!rec) return;
    if (shown === id) {
      if (tween) { const t = tween; tween = null; t.resolve(false); }
      shown = null;
      if (pres.building === id) pres = Object.freeze({ building: null, mode: 'stack', floor: null });
    }
    if (selectedKey?.startsWith(`${id}/`)) { selectedKey = null; refreshSelection(); }
    clearBuilding(rec);
    object.remove(rec.group);
    built.delete(id);
  }

  function dispose() {
    if (disposed) return;
    if (tween) { const t = tween; tween = null; t.resolve(false); }
    for (const id of [...built.keys()]) unload(id);
    if (warm) { object.remove(warm); disposeTree(warm); warm = null; }
    disposed = true;
    object.removeFromParent();
  }

  return {
    object,
    load,
    unload,
    prefetch,
    isLoaded: id => built.has(id),
    setPresentation,
    get presentation() { return pres; },
    get animating() { return !!tween; },
    update,
    pick,
    setOccupancy,
    setHoveredFloor,
    setHovered: key => setRoomState('hover', key),
    setSelected: key => setRoomState('select', key),
    setEmissive,
    buildingBox,
    floorBox,
    roomBox,
    floors,
    elevation,
    outlinePoints,
    room,
    space,
    spaces,
    labels,
    dispose,
  };
}
