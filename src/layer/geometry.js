import * as THREE from 'three';
import { allCoords } from '../data/frame.js';
import { classifyFeature, roomKey, roomStatus } from '../data/indoor.js';

// Geometry of one floor: extruded spaces, low room walls, slab, outlines and label anchors.
// Everything here is in the world frame (Y-up metres); a floor is built at y = 0 and the layer moves its group.

export const DEFAULT_PALETTE = {
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
  accent: 0x0a84ff,
  // Named places a host draws as rooms (spaceClass → 'room'); the default classification never produces it.
  place: 0xe4dcf2,
  placeSide: 0xbfb2d9,
};

export function statusColors(palette) {
  return {
    free: [palette.free, palette.freeSide],
    soon: [palette.soon, palette.soonSide],
    busy: [palette.room, palette.roomSide],
    unknown: [palette.unknown, palette.unknownSide],
  };
}

// Low walls: tall enough to read as rooms at the single-floor tilt, low enough not to hide the floor colour.
export const WALL = { base: .18, height: .85, thickness: .14 };
export const LABEL_Y = WALL.base + WALL.height + .2;
export const SLAB_DEPTH = .7;

// Shapes are drawn in the plan (x, north) and extruded along +Z; extrudeUp turns that into the world frame
// (extrusion along +Y, north to −Z).
export function shapeFromPoints(points, hole = false) {
  const p = hole ? new THREE.Path() : new THREE.Shape();
  points.forEach(([x, z], i) => (i ? p.lineTo(x, -z) : p.moveTo(x, -z)));
  p.closePath();
  return p;
}
export function extrudeUp(shape, options) {
  return new THREE.ExtrudeGeometry(shape, options).rotateX(-Math.PI / 2);
}

export function ringsFromGeometry(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

export function shapeFromRings(rings, project) {
  if (!rings?.length || rings[0].length < 3) return null;
  const shape = shapeFromPoints(rings[0].map(pt => project(pt)));
  for (let i = 1; i < rings.length; i++) shape.holes.push(shapeFromPoints(rings[i].map(pt => project(pt)), true));
  return shape;
}

export function centroidOfGeometry(geometry, project) {
  const pts = allCoords(geometry);
  let sx = 0, sz = 0;
  for (const p of pts) {
    const [x, z] = project(p);
    sx += x; sz += z;
  }
  return new THREE.Vector3(sx / pts.length, 0, sz / pts.length);
}

export function materialPair(top, side, { transparent = false, opacity = 1, fog = true } = {}) {
  const a = new THREE.MeshStandardMaterial({ color: top, roughness: .90, metalness: 0, transparent, opacity });
  const b = new THREE.MeshStandardMaterial({ color: side, roughness: .95, metalness: 0, transparent, opacity });
  a.fog = b.fog = fog;
  return [a, b];
}

export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Free every geometry and material under `obj` (the object itself included).
export function disposeTree(obj) {
  obj.traverse(n => {
    n.geometry?.dispose?.();
    if (Array.isArray(n.material)) n.material.forEach(m => m.dispose?.());
    else n.material?.dispose?.();
  });
}

// ---- walls ----
const WALL_ANGLE_TOL = .05, WALL_OFFSET_TOL = .3, WALL_MIN_LEN = .12;
// Room outlines in the GIS data notch around every column (most 5F edges are < 0.5 m). The floor fill
// keeps the exact polygon; only the wall outline is cleaned: keep the long edges (each one lies exactly
// on a GIS edge), merge collinear pieces split by a notch, and re-form corners where neighbours meet.
const WALL_MIN_EDGE_M = 1.0, WALL_MERGE_ANGLE = .17, WALL_MERGE_OFFSET_M = 1.0, WALL_CORNER_MAX_M = 3;

function subtractInterval(parts, [c0, c1]) {
  return parts.flatMap(([a, b]) => {
    if (c1 <= a || c0 >= b) return [[a, b]];
    return [[a, Math.min(b, c0)], [Math.max(a, c1), b]].filter(([x, y]) => y - x > WALL_MIN_LEN);
  });
}

export function cleanWallOutline(ring) {
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

// ---- merged floor geometry (stage 3, docs/LAYER.md「材質與效能」) ----
// A floor is a handful of merged meshes instead of one mesh (and material pair) per space:
//   base: slab, corridors, service spaces (no shadows)       cast: classrooms, places, stairs, toilets (cast shadows)
//   walls: every low wall, built with its bottom at y = 0 (the layer grows it with mesh.scale.y)
//   edges: room outlines                                       spaceEdges: focus-style boundaries (off by default)
// Materials are per floor (floors fade independently), white × vertex colour; state colours (occupancy, hover,
// selection) are written into the colour attribute. Picking uses one invisible flat proxy per floor (space top
// faces + the slab) whose triangles map back to the space they came from.

// Emissive follows the vertex colour, so `emissive = white × k` keeps "emissive = colour × k" per space.
function emissiveFromVertexColour(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
  );
}
export function fillMaterial({ roughness = .9, fog = true, transparent = true } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0, vertexColors: true, transparent });
  m.fog = fog;
  m.onBeforeCompile = emissiveFromVertexColour;
  return m;
}

// Writes `top` / `side` (THREE.Color, working space) into a piece's ranges of a colour attribute and marks
// just those ranges for upload.
export function paintRanges(attr, ranges, top, side) {
  const a = attr.array;
  for (const r of ranges) {
    const c = r.top ? top : side;
    const e = (r.start + r.count) * 3;
    for (let i = r.start * 3; i < e; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    attr.addUpdateRange(r.start * 3, r.count * 3);
  }
  attr.needsUpdate = true;
}

// Concatenates parts ({ geom, top, side, piece? }) into one non-indexed geometry with position, normal and
// colour. An extrusion's group 0 (its caps) is painted `top`, the rest `side`; piece.ranges records where the
// part landed (in vertices). The part geometries are disposed.
function mergeParts(parts) {
  const geoms = parts.map(p => {
    const g = p.geom.index ? p.geom.toNonIndexed() : p.geom;
    if (g !== p.geom) p.geom.dispose();
    return g;
  });
  const n = geoms.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const color = new THREE.BufferAttribute(col, 3);
  const top = new THREE.Color(), side = new THREE.Color();
  let at = 0;
  parts.forEach((p, i) => {
    const g = geoms[i], count = g.attributes.position.count;
    pos.set(g.attributes.position.array, at * 3);
    nor.set(g.attributes.normal.array, at * 3);
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 1 }];
    const ranges = groups.map(gr => ({ start: at + gr.start, count: Math.min(gr.count, count - gr.start), top: gr.materialIndex === 0 }));
    paintRanges(color, ranges, top.setHex(p.top), side.setHex(p.side));
    if (p.piece) p.piece.ranges = ranges;
    at += count;
    g.dispose();
  });
  color.clearUpdateRanges();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geom.setAttribute('color', color);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

function mergeLines(geoms) {
  const n = geoms.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3);
  let at = 0;
  for (const g of geoms) { pos.set(g.attributes.position.array, at); at += g.attributes.position.count * 3; g.dispose(); }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return geom;
}

// Builds one floor into a fresh group at y = 0. Returns the floor record the layer animates.
//   ctx: { buildingId, floorId, index, features, occupancy, project, palette, fog, receiveShadow,
//          footprintFeature, footprintM, classify?, spaceOf?, labelFor? }
// Optional host hooks (the layer passes them; without them the floor is built exactly as before):
//   classify(p) → space class ('room' = a named place: raised fill + edges in the `place` colour, no low walls);
//   spaceOf(feature) → { key, selectable, … } (SpaceInfo); selectable spaces get a key, tint and outline;
//   labelFor(info, cls) → { text, priority?, kind?, fadeIn? } | null, replacing the default labels.
// floor.pieces: one entry per drawn polygon { feature, cls, kind?, base?, key, space, slab?, mesh: 'base'|'cast',
// ranges, box (floor-local), shape, depth, y }; floor.meshes: { base, cast, walls, edges, spaceEdges } (absent
// when empty); floor.proxy: the pick proxy (userData.pieces: triangle → index into floor.pieces).
export function buildFloor(ctx) {
  const { floorId: id, features, occupancy, project, palette: COLORS, fog, receiveShadow } = ctx;
  const spaceOf = ctx.spaceOf || (() => null);
  const STATUS = statusColors(COLORS);
  const group = new THREE.Group();
  group.userData.floorId = id;
  const floor = {
    id, index: ctx.index, group, hull: null, outlinePoints: null,
    pieces: [], meshes: {}, proxy: null, drawables: [], casters: [], labels: [], mats: [], fills: [], spaceEdges: [],
    wallScale: null, fade: 0, fadeTarget: 0, outline: null, outlineFade: 0, outlineTarget: 0, focusEdge: null, focusStyleK: undefined,
    localBox: null, badge: null,
  };
  const classify = ctx.classify || (p => classifyFeature(p, occupancy));
  const isRoomCls = cls => cls === 'classroom' || cls === 'room';
  // Selectable spaces carry a key: classrooms by default ("B/F/classNumber"), anything the host allows.
  const keyOf = (feature, cls) => {
    const info = spaceOf(feature);
    if (info) return info.selectable ? info.key : null;
    return cls === 'classroom' ? roomKey(feature.properties) : null;
  };
  const lineMat = params => { const m = new THREE.LineBasicMaterial(params); m.fog = fog; return m; };
  const parts = { base: [], cast: [] }, wallGeoms = [], edgeGeoms = [], spaceEdgeGeoms = [];

  // Walls already built on this floor, as collinear intervals. Adjacent rooms share boundaries, so without
  // this every shared edge would get two overlapping walls.
  const floorWalls = [];
  const addWallSegment = (x1, z1, x2, z2) => {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < .08) return;
    // Bottom at y = 0; the merged wall mesh sits at WALL.base and grows with scale.y.
    const geom = new THREE.BoxGeometry(len, WALL.height, WALL.thickness)
      .translate(0, WALL.height / 2, 0).rotateY(-Math.atan2(dz, dx)).translate((x1 + x2) / 2, 0, (z1 + z2) / 2);
    wallGeoms.push({ geom, top: COLORS.wallSide, side: COLORS.wallSide });
  };
  // Plan coordinates (x, north) in; walls are placed at world (x, −north).
  const addDedupedWall = (ax, ay, bx, by) => {
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
      addWallSegment(a * dx - off * dy, -(a * dy + off * dx), b * dx - off * dy, -(b * dy + off * dx));
    }
  };
  const addRoomLowWalls = feature => {
    for (const poly of ringsFromGeometry(feature.geometry)) {
      // Outline cleaning works in the plan (x, north).
      const ring = (poly[0] || []).map(pt => { const [x, z] = project(pt); return [x, -z]; });
      const outline = cleanWallOutline(ring);
      for (let i = 0; i < outline.length - 1; i++) addDedupedWall(outline[i][0], outline[i][1], outline[i + 1][0], outline[i + 1][1]);
    }
  };

  const styleFor = (p, cls) => {
    if (cls === 'classroom') {
      const kind = roomStatus(occupancy, roomKey(p));
      return { depth: .07, y: .10, colors: STATUS[kind], kind };
    }
    if (cls === 'room') return { depth: .07, y: .10, colors: [COLORS.place, COLORS.placeSide] };
    if (cls === 'corridor') return { depth: .035, y: .08, colors: [COLORS.corridor, COLORS.corridorSide] };
    if (cls === 'vertical') return { depth: .12, y: .09, colors: [COLORS.vertical, COLORS.verticalSide] };
    if (cls === 'restroom') return { depth: .10, y: .09, colors: [COLORS.restroom, COLORS.restroomSide] };
    if (cls === 'service') return { depth: .065, y: .08, colors: [COLORS.service, COLORS.serviceSide] };
    return null;
  };

  // Host labels: one per space (split polygons share a key: labelled once, on the largest piece).
  const hostLabel = (feature, cls, key) => {
    const info = spaceOf(feature);
    const spec = info && ctx.labelFor(info, cls);
    if (!spec || !spec.text) return;
    const p = feature.properties;
    const status = cls === 'classroom' && spec.kind === undefined;
    const label = {
      local: centroidOfGeometry(feature.geometry, project).setY(isRoomCls(cls) ? LABEL_Y : .46),
      text: String(spec.text), kind: spec.kind ?? (status ? roomStatus(occupancy, key || roomKey(p)) : 'poi'),
      key: key || undefined, role: 'room', floor: id, area: p.areaSquareMeters || 0, space: info.key, status,
    };
    if (spec.priority !== undefined) label.priority = spec.priority;
    if (spec.fadeIn) label.fadeIn = spec.fadeIn;
    if (!key) label.id = `space:${info.key}`;
    const i = floor.labels.findIndex(l => l.space === info.key);
    if (i < 0) floor.labels.push(label);
    else if (label.area > floor.labels[i].area) floor.labels[i] = label;
  };

  const addFeatureLabels = (feature, cls, key) => {
    if (ctx.labelFor) { hostLabel(feature, cls, key); return; }
    const p = feature.properties;
    if (cls === 'classroom' && p.classNumber) {
      const c = centroidOfGeometry(feature.geometry, project);
      const key = roomKey(p);
      const label = { local: c.setY(LABEL_Y + 0), text: p.classNumber, kind: roomStatus(occupancy, key), key, role: 'room', floor: id, area: p.areaSquareMeters || 0, status: true };
      // GIS sometimes splits one room into several polygons (CB 4F 414): colour all of them, label once,
      // on the largest piece.
      const i = floor.labels.findIndex(l => l.key === key);
      if (i < 0) floor.labels.push(label);
      else if (label.area > floor.labels[i].area) floor.labels[i] = label;
      return;
    }
    if (cls === 'vertical' || cls === 'restroom') {
      const c = centroidOfGeometry(feature.geometry, project);
      const name = (p.use || p.name || '');
      const text = name.includes('電梯') ? '電梯' : name.includes('樓梯') ? '樓梯' : name.includes('廁') ? 'WC' : '';
      if (text) floor.labels.push({ local: c.setY(.46 + 0), text, kind: 'poi', role: 'room', floor: id });
    }
  };

  const addFeature = feature => {
    const cls = classify(feature.properties);
    if (cls === 'skip' || cls === 'void') return;
    const style = styleFor(feature.properties, cls);
    if (!style) return;
    const key = keyOf(feature, cls);
    const caster = isRoomCls(cls) || cls === 'vertical' || cls === 'restroom';
    const info = spaceOf(feature);
    for (const rings of ringsFromGeometry(feature.geometry)) {
      const shape = shapeFromRings(rings, project);
      if (!shape) continue;
      const geom = extrudeUp(shape, { depth: style.depth, bevelEnabled: false, curveSegments: 2 }).translate(0, style.y, 0);
      geom.computeBoundingBox();
      const piece = {
        feature, cls, kind: style.kind, base: style.kind ? undefined : style.colors, key, space: info || null,
        mesh: caster ? 'cast' : 'base', ranges: null, box: geom.boundingBox.clone(), shape, depth: style.depth, y: style.y,
      };
      floor.pieces.push(piece);
      parts[piece.mesh].push({ geom, top: style.colors[0], side: style.colors[1], piece });
      if (isRoomCls(cls)) {
        edgeGeoms.push(new THREE.EdgesGeometry(geom, 25).translate(0, .006, 0));
        // Low walls only around classrooms: hosts may mark hundreds of places as 'room'.
        if (cls === 'classroom') addRoomLowWalls(feature);
      } else if (cls === 'service' || cls === 'vertical' || cls === 'restroom') {
        // Plan-style boundaries between the many neutral spaces; only drawn on the focused floor.
        spaceEdgeGeoms.push(new THREE.EdgesGeometry(geom, 25).translate(0, .006, 0));
      }
    }
    addFeatureLabels(feature, cls, key);
  };

  // Slab outline. The official building footprint is used when the floor fits inside it (A3T); some
  // buildings' footprints do not match their floors (AM basements are much larger), so those floors fall
  // back to the convex hull of their own spaces.
  floor.hull = slabOutline(features, ctx.footprintM, classify, project);
  const slab = slabPiece(floor.hull, ctx.footprintFeature, project);
  if (slab) {
    floor.outlinePoints = slab.outlinePoints;
    floor.pieces.push(slab.piece);
    parts.base.push({ geom: slab.geom, top: COLORS.slabTop, side: COLORS.slabSide, piece: slab.piece });
  }

  const order = { corridor: 0, service: 1, vertical: 2, restroom: 3, classroom: 4, room: 4, void: 8, skip: 9 };
  features.slice().sort((a, b) => order[classify(a.properties)] - order[classify(b.properties)]).forEach(addFeature);

  // Merged meshes, in draw order. Materials start transparent (a floor fades without a recompile); the layer
  // switches fills to opaque at rest where the host allows it.
  const addMesh = (name, geom, mat, { fill = false, caster = false } = {}) => {
    const mesh = new THREE.Mesh(geom, mat);
    mesh.receiveShadow = receiveShadow;
    mesh.userData = { floorId: id, part: name };
    group.add(mesh);
    floor.meshes[name] = mesh;
    floor.drawables.push(mesh);
    floor.mats.push({ m: mat, base: mat.opacity });
    if (fill) floor.fills.push(mat);
    if (caster) floor.casters.push(mesh);
    return mesh;
  };
  if (parts.base.length) addMesh('base', mergeParts(parts.base), fillMaterial({ fog }), { fill: true });
  if (parts.cast.length) addMesh('cast', mergeParts(parts.cast), fillMaterial({ fog }), { fill: true, caster: true });
  if (wallGeoms.length) {
    const walls = addMesh('walls', mergeParts(wallGeoms), fillMaterial({ roughness: .95, fog }), { fill: true, caster: true });
    walls.position.y = WALL.base;
    walls.userData.wall = true;
  }
  const addLines = (name, geoms, params) => {
    const line = new THREE.LineSegments(mergeLines(geoms), lineMat(params));
    line.userData = { floorId: id, part: name };
    group.add(line);
    floor.meshes[name] = line;
    floor.drawables.push(line);
    floor.mats.push({ m: line.material, base: line.material.opacity });
    return line;
  };
  if (edgeGeoms.length) addLines('edges', edgeGeoms, { color: COLORS.outline, transparent: true, opacity: .24 });
  if (spaceEdgeGeoms.length) floor.spaceEdges.push(addLines('spaceEdges', spaceEdgeGeoms, { color: COLORS.outline, transparent: true, opacity: 0, depthWrite: false }));

  floor.proxy = pickProxy(floor);
  if (floor.proxy) group.add(floor.proxy);

  // Outline-only ghost, kept outside the floor group so it can show while the fill is hidden.
  const outlinePts = floor.outlinePoints;
  if (outlinePts?.length) {
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(outlinePts.map(p => new THREE.Vector3(p.x, .08, -p.y))),
      lineMat({ color: COLORS.outline, transparent: true, opacity: 0, depthWrite: false }),
    );
    line.renderOrder = 1;
    line.visible = false;
    floor.outline = line;
    // Outer edge of the focused floor, above the room fills, below the walls.
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(outlinePts.map(p => new THREE.Vector3(p.x, .2, -p.y))),
      lineMat({ color: COLORS.focusEdge, transparent: true, opacity: 0, depthWrite: false }),
    );
    edge.renderOrder = 3;
    edge.visible = false;
    group.add(edge);
    floor.focusEdge = edge;
  }
  // Local bounds (walls at full height), computed once: layouts only offset them by the group's y.
  group.position.y = 0;
  floor.localBox = new THREE.Box3().setFromObject(group);
  return floor;
}

// Flat pick proxy: the top faces of every space and the whole slab, in the order of floor.pieces' meshes;
// userData.pieces maps each triangle to its piece. Never drawn (raycasting ignores visibility).
function pickProxy(floor) {
  const tris = [];
  let n = 0;
  for (const name of ['base', 'cast']) {
    const mesh = floor.meshes[name];
    if (!mesh) continue;
    const pos = mesh.geometry.attributes.position.array, nor = mesh.geometry.attributes.normal.array;
    floor.pieces.forEach((piece, index) => {
      if (piece.mesh !== name) return;
      for (const r of piece.ranges) {
        if (!piece.slab && !r.top) continue;
        for (let v = r.start; v + 2 < r.start + r.count; v += 3) {
          if (!piece.slab && nor[v * 3 + 1] < .5) continue; // a space's bottom cap
          tris.push(pos.subarray(v * 3, v * 3 + 9), index);
          n++;
        }
      }
    });
  }
  if (!n) return null;
  const pos = new Float32Array(n * 9), map = new Int32Array(n);
  for (let i = 0; i < n; i++) { pos.set(tris[i * 2], i * 9); map[i] = tris[i * 2 + 1]; }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
  mesh.visible = false;
  mesh.userData = { floorId: floor.id, proxy: true, pieces: map };
  return mesh;
}

function slabPiece(hull, footprintFeature, project) {
  let shape = null;
  if (hull) shape = shapeFromPoints(hull);
  else if (footprintFeature) {
    for (const rings of ringsFromGeometry(footprintFeature.geometry)) {
      const s = shapeFromRings(rings, project);
      if (s) { shape = s; break; }
    }
  }
  if (!shape) return null;
  const geom = extrudeUp(shape, { depth: SLAB_DEPTH, bevelEnabled: true, bevelSize: .05, bevelThickness: .03, bevelSegments: 1 })
    .translate(0, .06 - SLAB_DEPTH, 0);
  geom.computeBoundingBox();
  return { geom, outlinePoints: shape.getPoints(), piece: { slab: true, mesh: 'base', ranges: null, box: geom.boundingBox.clone() } };
}

function slabOutline(features, footprintM, classify, project) {
  const fb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  footprintM.forEach(([x, z]) => { fb.minX = Math.min(fb.minX, x); fb.maxX = Math.max(fb.maxX, x); fb.minZ = Math.min(fb.minZ, z); fb.maxZ = Math.max(fb.maxZ, z); });
  const pts = features
    .filter(f => !['skip', 'void'].includes(classify(f.properties)))
    .flatMap(f => allCoords(f.geometry))
    .map(p => project(p));
  if (!pts.length) return null;
  const tol = 2;
  const inside = pts.every(([x, z]) => x >= fb.minX - tol && x <= fb.maxX + tol && z >= fb.minZ - tol && z <= fb.maxZ + tol);
  // Hull taken in the plan (x, north) so its winding and start vertex match the slab shape's frame.
  return inside ? null : convexHull(pts.map(([x, z]) => [x, -z])).map(([x, n]) => [x, -n]);
}
