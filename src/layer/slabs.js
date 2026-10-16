import { Clipper, Clipper64, ClipType, EndType, FillRule, JoinType, PolyTree64 } from '@countertype/clipper2-ts';

// Floor slabs from the spaces themselves (host option `slab: 'spaces'`, docs/LAYER.md「樓板」).
// The union of a floor's drawn spaces, closed over small gaps (walls and columns are not spaces in the GIS data),
// becomes one plate per connected part: wings that do not touch (綜科 7F／8F) get separate plates, a small detached
// machine room its own small plate, a courtyard stays open. Loaded lazily (@countertype/clipper2-ts, ~25 KB gzip, BSL-1.0) only when a
// host asks for it, so hosts on the footprint slab never download it.
export const SLAB_SPACES = {
  gap: 1.0,            // m: parts closer than this are joined (grow by gap / 2, then shrink back)
  holeFillBelow: 12,   // m²: smaller holes (light wells, column gaps, unmapped closets) are filled; larger stay open
  sliverBelow: 2,      // m²: isolated plates smaller than this (column / noise polygons) are dropped
  coverageBelow: .6,   // the spaces' plates replace the usual slab when they cover less than this share of it
};
const S = 100; // clipper works in integers: centimetres

// GIS rings carry noise: hair-thin "holes" of a few cm² along an edge (A6T B2 has ten), which send the clipper
// into an endless loop when they are clipped together. Rings under MIN_RING_CM2 are dropped, the rest lightly simplified.
const MIN_RING_CM2 = 1000; // 0.1 m²
const toPath = (ring, positive) => {
  let p = ring.map(([x, z]) => ({ x: Math.round(x * S), y: Math.round(z * S) }));
  if (p.length > 1 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) p.pop();
  p = Clipper.simplifyPath(Clipper.stripDuplicates(p, true), 1, true);
  if (p.length < 3 || Math.abs(Clipper.area(p)) < MIN_RING_CM2) return null;
  return Clipper.isPositive(p) === positive ? p : Clipper.reversePath(p);
};
const toRing = path => path.map(pt => [pt.x / S, pt.y / S]);
const areaM2 = path => Math.abs(Clipper.area(path)) / (S * S);

// polygons: [[outer [x, z][], ...holes]] (layer frame, metres). Returns plates sorted by area, largest first:
// [{ outer: [x, z][], holes: [x, z][][], area }] (area in m², holes excluded), and their total area.
export function spacePlates(polygons, o = SLAB_SPACES) {
  const paths = [];
  for (const rings of polygons) {
    if (!rings?.length || rings[0].length < 3) continue;
    const outer = toPath(rings[0], true);
    if (!outer) continue;
    paths.push(outer);
    for (let i = 1; i < rings.length; i++) { const h = rings[i].length >= 3 && toPath(rings[i], false); if (h) paths.push(h); }
  }
  if (!paths.length) return { plates: [], area: 0 };
  // Positive outers and negative holes under NonZero: a space's own hole stays a hole unless another space covers it.
  let u = Clipper.union(paths, FillRule.NonZero);
  const r = o.gap / 2 * S;
  u = Clipper.inflatePaths(u, r, JoinType.Miter, EndType.Polygon, 4);
  u = Clipper.inflatePaths(u, -r, JoinType.Miter, EndType.Polygon, 4);
  u = Clipper.simplifyPaths(u, 2, true); // 2 cm: offsetting leaves near-collinear points
  const c = new Clipper64();
  c.addSubject(u);
  const tree = new PolyTree64();
  c.execute(ClipType.Union, FillRule.NonZero, tree);
  const plates = [];
  const walk = node => {
    for (const outer of node.children) {
      const holes = [];
      let area = areaM2(outer.polygon);
      for (const hole of outer.children) {
        const ha = areaM2(hole.polygon);
        // Islands inside a hole that stays open are plates of their own; inside a filled hole they are covered.
        if (ha >= o.holeFillBelow) { holes.push(toRing(hole.polygon)); area -= ha; walk(hole); }
      }
      if (area >= o.sliverBelow) plates.push({ outer: toRing(outer.polygon), holes, area });
    }
  };
  walk(tree);
  plates.sort((a, b) => b.area - a.area);
  return { plates, area: plates.reduce((s, p) => s + p.area, 0) };
}

// The rule: the spaces' plates replace the usual slab (footprint, or hull) when the floor splits into several
// plates, or when they cover less than coverageBelow of it. Returns the plates, or null to keep the usual slab.
export function slabPlatesFor(polygons, usualArea, o = SLAB_SPACES) {
  const { plates, area } = spacePlates(polygons, o);
  if (!plates.length) return null;
  return plates.length > 1 || area < o.coverageBelow * usualArea ? plates : null;
}
