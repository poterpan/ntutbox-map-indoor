// Data source for the indoor map engine. A source hides where campus data lives and how it is encoded;
// the engine only sees GeoJSON-shaped objects plus the coordinate frame they are in. Any object with this
// shape works as `options.source`; campusCdnSource below reads the published campus data.
//
//   source.frame                 'lonlat' (WGS84 degrees) | 'planar-cm' (integer cm in one planar frame)
//   source.load()                → { buildingIndex: { buildings: [{ buildingId, floorIds }] },
//                                    buildingsData: FeatureCollection (properties: buildingId, name, campusId),
//                                    buildings: { [id]: { name, short, entranceBearing, entranceConfirmed } } | null }
//   source.floor(id, floorId)    → FeatureCollection, or null when that floor has no file
//
// load() is memoised, so a host can await it for its building list before creating the map and the engine
// reuses the same result.

const getJSON = (fetchImpl, url) => fetchImpl(url).then(r => {
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { status: r.status });
  return r.json();
});

// Published campus data (cdn.ntutbox.com/campus/v1, format in docs/DATA-FORMAT.md):
// current.json → manifest → content-hashed files. Geometry is integer cm in EPSG:3826 relative to the
// published origin; that is already planar, so the engine only divides by 100.
export const CAMPUS_SCHEMA_VERSION = 1;

export function campusCdnSource(baseUrl = 'https://cdn.ntutbox.com/campus/v1', { fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  let loaded;
  const floorCache = new Map();
  const file = async logical => {
    const { manifest } = await load();
    const entry = manifest.files[logical];
    return entry ? getJSON(fetchImpl, `${baseUrl}/${entry.path}`) : null;
  };
  function load() {
    loaded ??= (async () => {
      // current.json is the only mutable object; everything it points at is immutable and cached for a year.
      const current = await getJSON(fetchImpl, `${baseUrl}/current.json`);
      if (current.schema_version !== CAMPUS_SCHEMA_VERSION) {
        throw new Error(`campus data schema ${current.schema_version} is not supported (expected ${CAMPUS_SCHEMA_VERSION})`);
      }
      const manifest = await getJSON(fetchImpl, `${baseUrl}/${current.manifest}`);
      const entry = manifest.files['buildings.json'];
      if (!entry) throw new Error('campus manifest has no buildings.json');
      const doc = await getJSON(fetchImpl, `${baseUrl}/${entry.path}`);
      return { current, manifest, ...convertBuildings(doc) };
    })();
    loaded.catch(() => { loaded = undefined; });
    return loaded;
  }
  return {
    frame: 'planar-cm',
    load,
    floor(id, floorId) {
      const key = `${id}/${floorId}`;
      if (!floorCache.has(key)) {
        const p = file(`indoor/${id}/${floorId}.json`).then(doc => (doc ? convertFloor(doc) : null));
        p.catch(() => floorCache.delete(key));
        floorCache.set(key, p);
      }
      return floorCache.get(key);
    },
  };
}

// buildings.json → the engine's building index, campus footprints and default per-building config.
export function convertBuildings(doc) {
  const buildingIndex = { buildings: [] };
  const buildings = {};
  const features = [];
  for (const b of doc.buildings) {
    features.push({
      type: 'Feature',
      properties: { buildingId: b.id, name: b.name, campusId: b.campus ?? null },
      geometry: { type: 'MultiPolygon', coordinates: b.outline },
    });
    if (!b.floors?.length) continue;
    buildingIndex.buildings.push({ buildingId: b.id, name: b.name, nameAliases: [b.name, ...(b.aliases ?? [])], floorIds: b.floors });
    buildings[b.id] = {
      name: b.name,
      short: b.short ?? b.name,
      entranceBearing: b.entrance?.bearing ?? 0,
      entranceConfirmed: !!b.entrance?.verified,
    };
  }
  return { buildingIndex, buildingsData: { type: 'FeatureCollection', features }, buildings, frameInfo: doc.frame };
}

// One indoor/<B>/<F>.json → the room features the engine renders. Short keys per DATA-FORMAT.md:
// id, c (category1), n (class number), t (name), te (English name), g (polygons in cm).
export function convertFloor(doc) {
  return {
    type: 'FeatureCollection',
    features: doc.spaces.map(s => ({
      type: 'Feature',
      properties: {
        spaceId: s.id,
        buildingId: doc.building,
        floorId: doc.floor,
        classNumber: s.n ?? null,
        name: s.t ?? null,
        nameEn: s.te ?? null,
        category1: s.c ?? null,
        areaSquareMeters: areaM2(s.g),
      },
      geometry: { type: 'MultiPolygon', coordinates: s.g },
    })),
  };
}

// Shoelace area of the outer rings minus holes, cm² → m². The engine uses it to rank labels.
function areaM2(polygons) {
  const ring = r => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(a) / 2;
  };
  let total = 0;
  for (const [outer, ...holes] of polygons) total += ring(outer) - holes.reduce((s, h) => s + ring(h), 0);
  return Math.round(total / 1e4 * 10) / 10;
}
