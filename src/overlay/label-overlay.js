import * as THREE from 'three';

// DOM labels over a three.js view. The host passes the camera every frame, so it works with the viewer's
// orthographic rig and with a host's perspective camera alike:
//   const overlay = createLabelOverlay(container, { onBadgeClick, onBadgeHover });
//   each frame: overlay.update(camera, [...layer.labels(), ...hostLabels]);
// Labels are plain objects { id, position (world Vector3), text, role, kind, priority, opacity }; ids are
// stable, so only labels that appear, disappear or change get DOM work (diff updates).
// Styles: the `.label` rules in the package stylesheet (classes come from classFor, see defaultLabelClass).

// Labels with role 'room' or 'campus' avoid each other: higher priority first. A label that would overlap
// one already placed is hidden until zooming in makes room; a hidden label needs a few extra pixels to
// come back (hysteresis, no flicker).
const COLLISION = { gap: 2, hysteresis: 4 };
// Declutter: stair / WC badges (kind 'poi') fade in between these screen densities (px per metre), so
// room numbers win when the floor is drawn small.
const DECLUTTER = { poiFrom: 6, poiTo: 8.5 };

// CSS class (after the base class) for a label: badges and skip markers are styled by role, room labels by
// status (free → 'available'), everything else by its kind.
export function defaultLabelClass(l) {
  if (l.role === 'badge') return `floor-badge ${l.kind}`;
  if (l.role === 'skip') return 'floor-skip';
  if (l.kind === 'free') return 'available';
  return l.kind || '';
}

const view = new THREE.Vector3();
// Screen pixels per world metre at `world`: the orthographic span, or the perspective depth.
export function pixelsPerMetre(camera, world, height) {
  if (camera.isOrthographicCamera) return height / ((camera.top - camera.bottom) / camera.zoom);
  view.copy(world).applyMatrix4(camera.matrixWorldInverse);
  const depth = -view.z;
  return depth > 0 ? height * camera.projectionMatrix.elements[5] / (2 * depth) : 0;
}

export function createLabelOverlay(container, options = {}) {
  const opts = {
    className: 'label',
    classFor: defaultLabelClass,
    onBadgeClick: null,
    onBadgeHover: null,
    collision: COLLISION,
    declutter: DECLUTTER,
    pixelsPerMetre,
    ...options,
  };
  const states = new Map(); // id -> { el, label, text, cls, w, h, collided, sx, sy, op }
  let order = [];
  let disposed = false;
  const projected = new THREE.Vector3();

  const callback = (name, payload) => {
    try { opts[name]?.(payload); } catch (err) { console.error(`[label-overlay] ${name} handler failed`, err); }
  };

  function create(l) {
    const el = document.createElement('div');
    const st = { el, label: l, text: null, cls: null, w: 0, h: 0, collided: false, sx: 0, sy: 0, op: 0 };
    if (l.role === 'badge') {
      el.addEventListener('click', e => { e.stopPropagation(); callback('onBadgeClick', st.label); });
      el.addEventListener('pointerenter', () => callback('onBadgeHover', st.label));
      el.addEventListener('pointerleave', () => callback('onBadgeHover', null));
    }
    states.set(l.id, st);
    return st;
  }

  // Create / remove / restyle elements to match `labels` (no positioning). Call it before measuring.
  function sync(labels) {
    if (disposed) return;
    let changed = labels.length !== order.length;
    const seen = new Set();
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      seen.add(l.id);
      let st = states.get(l.id);
      if (!st) { st = create(l); changed = true; }
      else if (!changed && order[i] !== l.id) changed = true;
      st.label = l;
      const cls = `${opts.className} ${opts.classFor(l)}`;
      if (cls !== st.cls) { st.el.className = cls; st.cls = cls; st.w = 0; }
      if (l.text !== st.text) { st.el.textContent = l.text; st.text = l.text; st.w = 0; }
    }
    if (!changed) return;
    for (const [id, st] of states) if (!seen.has(id)) { st.el.remove(); states.delete(id); }
    // Document order = list order (later labels paint on top), after whatever else the container holds.
    for (const l of labels) container.appendChild(states.get(l.id).el);
    order = labels.map(l => l.id);
  }

  function update(camera, labels) {
    if (disposed) return;
    sync(labels);
    const W = container.clientWidth, H = container.clientHeight;
    const placed = [];
    const candidates = [];
    for (const l of labels) {
      const st = states.get(l.id);
      let op = l.opacity;
      if (l.kind === 'poi' && op >= .02) {
        op *= THREE.MathUtils.smoothstep(opts.pixelsPerMetre(camera, l.position, H), opts.declutter.poiFrom, opts.declutter.poiTo);
      }
      // Per-label declutter (host labels): fade in between these screen densities (px per metre).
      if (l.fadeIn && op >= .02) op *= THREE.MathUtils.smoothstep(opts.pixelsPerMetre(camera, l.position, H), l.fadeIn[0], l.fadeIn[1]);
      if (op < .02) { if (st.el.style.visibility !== 'hidden') st.el.style.visibility = 'hidden'; st.collided = false; continue; }
      const p = projected.copy(l.position).project(camera);
      if (!(p.z > -1 && p.z < 1)) { st.el.style.visibility = 'hidden'; continue; }
      st.sx = (p.x * .5 + .5) * W;
      st.sy = (-p.y * .5 + .5) * H;
      st.op = op;
      if (l.role === 'room' || l.role === 'campus') candidates.push(st); else place(st, false);
    }
    candidates.sort((a, b) => (b.label.priority || 0) - (a.label.priority || 0));
    const { gap, hysteresis } = opts.collision;
    for (const st of candidates) {
      if (!st.w) { st.w = st.el.offsetWidth; st.h = st.el.offsetHeight; }
      const m = gap + (st.collided ? hysteresis : 0);
      const r = { x0: st.sx - st.w / 2 - m, x1: st.sx + st.w / 2 + m, y0: st.sy - st.h / 2 - m, y1: st.sy + st.h / 2 + m };
      st.collided = placed.some(q => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
      if (!st.collided) placed.push({ x0: st.sx - st.w / 2, x1: st.sx + st.w / 2, y0: st.sy - st.h / 2, y1: st.sy + st.h / 2 });
      place(st, st.collided);
    }
  }

  function place(st, hidden) {
    const s = st.el.style;
    s.visibility = 'visible';
    s.opacity = hidden ? '0' : st.op.toFixed(3);
    s.pointerEvents = st.label.role === 'badge' && st.op > .5 ? 'auto' : 'none';
    s.left = `${st.sx}px`;
    s.top = `${st.sy}px`;
  }

  // Widest element among labels matching `filter` (the viewer leaves room for the floor badges).
  function maxWidth(filter = () => true) {
    let w = 0;
    for (const st of states.values()) if (filter(st.label)) w = Math.max(w, st.el.offsetWidth);
    return w;
  }

  function clear() {
    for (const st of states.values()) st.el.remove();
    states.clear();
    order = [];
  }

  return {
    update,
    sync,
    maxWidth,
    element: id => states.get(id)?.el ?? null,
    clear,
    dispose() { clear(); disposed = true; },
  };
}
