// Minimal GeoJSON shapes used by @ntutbox/map-indoor (avoids a dependency on @types/geojson).
export type Position = number[];
export interface Polygon { type: 'Polygon'; coordinates: Position[][] }
export interface MultiPolygon { type: 'MultiPolygon'; coordinates: Position[][][] }
export interface Feature<G = Polygon | MultiPolygon, P = Record<string, unknown>> { type: 'Feature'; geometry: G; properties: P }
export interface FeatureCollection<G = Polygon | MultiPolygon, P = Record<string, unknown>> { type: 'FeatureCollection'; features: Feature<G, P>[] }
