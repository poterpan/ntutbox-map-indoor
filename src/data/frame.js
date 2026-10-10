// Coordinate frame helpers. World frame (shared with the campus 3D map): Y-up metres,
// x = E − 302800, y = height, z = −(N − 2770400). North is −Z. Pure functions, no three.js.

export function allCoords(geometry) {
  const out = [];
  const walk = value => {
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  walk(geometry.coordinates);
  return out;
}

export function geoBounds(features) {
  const pts = features.flatMap(f => allCoords(f.geometry));
  const minLon = Math.min(...pts.map(p => p[0]));
  const maxLon = Math.max(...pts.map(p => p[0]));
  const minLat = Math.min(...pts.map(p => p[1]));
  const maxLat = Math.max(...pts.map(p => p[1]));
  return { minLon, maxLon, minLat, maxLat, lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
}

export function metersFromLonLat(lon, lat, originLon, originLat) {
  const R = 6378137;
  return [
    (lon - originLon) * Math.PI / 180 * R * Math.cos(originLat * Math.PI / 180),
    (lat - originLat) * Math.PI / 180 * R,
  ];
}

// Source coordinates → ground position [x, z] in the world frame. planar-cm is integer cm relative to the
// published origin (TWD97 302800, 2770400): x = east, z = −north. A lonlat source has no published origin;
// it is projected to metres around a reference point { lon, lat } returned by `getRef` (read on every call,
// so a host can settle it after the campus data has loaded).
export function createProjector(frame, getRef) {
  if (frame === 'planar-cm') return pt => [pt[0] / 100, -pt[1] / 100];
  return pt => {
    const ref = getRef();
    const [e, n] = metersFromLonLat(pt[0], pt[1], ref.lon, ref.lat);
    return [e, -n];
  };
}
