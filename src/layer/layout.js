// Vertical floor layouts of one building. Pure functions over a bottom-to-top floor list
// [{ id, index, total }] (index = position in that list, total = timetabled rooms); no three.js.
// Every layout returns Map<floorId, y> of each floor's base (its slab top sits at y + .06).

// Floors shown in the stack overview: those with classrooms. A building with no timetabled rooms
// (行政大樓, 圖書館…) still has an overview: all of its floors.
export function overviewIds(floors) {
  const withRooms = floors.filter(f => f.total > 0).map(f => f.id);
  return withRooms.length ? withRooms : floors.map(f => f.id);
}

// Index of the floor whose base sits on groundY: 1F, or the lowest overview floor when there is no 1F.
export function groundIndex(floors) {
  const i = floors.findIndex(f => f.id === '1F');
  if (i >= 0) return i;
  const first = overviewIds(floors)[0];
  return Math.max(0, floors.findIndex(f => f.id === first));
}

// Real storey heights: elevation = (index − index of 1F) × floorHeight + groundY, so 1F stands on the
// ground and basements go below it.
export function elevation(floors, floorId, { floorHeight, groundY = 0 }) {
  const f = floors.find(x => x.id === floorId);
  if (!f) return null;
  return (f.index - groundIndex(floors)) * floorHeight + groundY;
}

export function inplaceLayout(floors, { floorHeight, groundY = 0 }) {
  const ground = groundIndex(floors);
  return new Map(floors.map(f => [f.id, (f.index - ground) * floorHeight + groundY]));
}

// Exploded overview. Only overview floors get a slot, `gap` apart; a run of floors without classrooms
// between two shown floors adds `skipExtra` × gap and becomes a skip marker ("7F–13F 沒有教室").
// Floors hidden in the overview sit squeezed next to their nearest shown floor, so they grow out of it
// during the accordion transition. Returns { y, shown, skips: [{ between: [below, above], ids }] }.
export function stackLayout(floors, { gap, skipExtra = .45, baseY = 0 }) {
  const ids = overviewIds(floors);
  const byId = new Map(floors.map(f => [f.id, f]));
  const y = new Map();
  const skips = [];
  let slot = 0, prev = null;
  for (const id of ids) {
    const f = byId.get(id);
    if (prev) {
      const skipped = floors.slice(prev.index + 1, f.index).map(s => s.id);
      const step = 1 + (skipped.length ? skipExtra : 0);
      if (skipped.length) skips.push({ between: [prev.id, id], ids: skipped });
      slot += step;
    }
    y.set(id, slot * gap + baseY);
    prev = f;
  }
  const shown = ids.map(id => byId.get(id));
  for (const f of floors) {
    if (!shown.length || y.has(f.id)) continue;
    const below = [...shown].reverse().find(s => s.index < f.index);
    const above = shown.find(s => s.index > f.index);
    const by = below && y.get(below.id), ay = above && y.get(above.id);
    if (below && above) y.set(f.id, by + (ay - by) * (f.index - below.index) / (above.index - below.index));
    else if (below) y.set(f.id, by + (f.index - below.index) * gap * .08);
    else y.set(f.id, ay - (above.index - f.index) * gap * .08);
  }
  return { y, shown: ids, skips };
}

// Single floor, accordion style: the focused floor at focusY, every other floor floorGap per storey above
// or below it, in physical order (so the faint neighbours really are the floors directly above and below).
export function floorLayout(floors, focusId, { focusY, floorGap }) {
  const focus = floors.find(f => f.id === focusId);
  if (!focus) return null;
  return new Map(floors.map(f => [f.id, f === focus ? focusY : focusY + (f.index - focus.index) * floorGap]));
}

export function floorRunLabel(ids) {
  return ids.length === 1 ? ids[0] : `${ids[0]}–${ids[ids.length - 1]}`;
}
