// Indoor data rules shared by the layer and the viewer: floor order, room keys, which GIS spaces are rooms,
// occupancy normalisation and per-floor timetable stats. Pure functions, no three.js, no DOM.

// Buildings with indoor data. Floor order comes from the source's building index.
// Hosts pass their own table through `options.buildings`, normally `(await source.load()).buildings`
// (every building with indoor GIS); this fallback only covers three buildings.
// `entranceBearing`: compass side of the main entrance (0 = north, 90 = east, …), confirmed on site
// (2026-10). Every view is oriented as if standing at that entrance looking in: the entrance side is
// at the bottom of the screen. Exact entrance points (several per building) belong to the future
// navigation graph, not here.
export const DEFAULT_BUILDINGS = {
  A3T: { name: '第三教學大樓', short: '三教', entranceBearing: 0 },
  AM: { name: '先鋒國際研發大樓', short: '先鋒', entranceBearing: 0 },
  CB: { name: '綜合科館', short: '綜科', entranceBearing: 270 },
};

// Which GIS spaces are rooms with an occupancy colour:
//   1. any space whose (building, floor, classNumber) has an occupancy record from the host — the course
//      system is the source of truth for "is a classroom" (CB has 26 course rooms that GIS files as labs
//      or meeting rooms);
//   2. otherwise GIS 001 一般教室 / 002 專業教室, shown as 'unknown' (無課表資料).
export const CLASSROOM_CATEGORIES = new Set(['001', '002']);
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

// Floor ids of a building, bottom to top. Throws when the building is not in the index.
export function sortedFloorIds(buildingIndex, id) {
  const info = buildingIndex?.buildings?.find(b => b.buildingId === id);
  if (!info) throw new Error(`building ${id} is not in building-index.json`);
  return info.floorIds.slice().sort((a, b) => floorRank(a) - floorRank(b));
}

export function roomKey(p) {
  return `${p.buildingId}/${p.floorId}/${p.classNumber}`;
}

// Host-provided occupancy: Map<"B/F/classNumber", { status, …record }>. Records whose key has no
// classNumber ("B/F/?code") are rooms the course system places on a floor but GIS cannot locate; they
// still count in that floor's stats.
export function toOccupancyMap(value) {
  if (!value) return null;
  return value instanceof Map ? value : new Map(Object.entries(value));
}

export function roomStatus(occupancy, key) {
  const st = occupancy?.get(key)?.status;
  return ROOM_STATUSES.includes(st) ? st : 'unknown';
}

// 'skip' | 'void' | 'classroom' | 'corridor' | 'vertical' | 'restroom' | 'service'
export function classifyFeature(p, occupancy) {
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

// Timetable stats of one floor, straight from the occupancy records (so rooms GIS cannot locate still
// count). total = rooms with a timetable; available = free + soon. Without occupancy the floor's GIS
// classrooms are counted with nothing available, so the overview still shows them.
export function statsForFloor(features, buildingId, floorId, occupancy) {
  if (!occupancy) {
    const total = (features || []).filter(f => classifyFeature(f.properties, null) === 'classroom' && f.properties.classNumber).length;
    return { total, available: 0, free: 0, unlocated: 0 };
  }
  const prefix = `${buildingId}/${floorId}/`;
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
export function roomSignature(buildingId, occupancy) {
  if (!occupancy) return '';
  const prefix = `${buildingId}/`;
  return [...occupancy.keys()].filter(k => k.startsWith(prefix)).sort().join('|');
}

// source.load(), shared by every consumer of the same source object (the layer and the viewer), so a custom
// source that does not memoise itself is still fetched once. A failed load can be retried.
const campusLoads = new WeakMap();
export function loadCampus(source) {
  let p = campusLoads.get(source);
  if (!p) {
    p = Promise.resolve().then(() => source.load());
    p.catch(() => { if (campusLoads.get(source) === p) campusLoads.delete(source); });
    campusLoads.set(source, p);
  }
  return p;
}
