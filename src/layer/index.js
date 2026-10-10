// @ntutbox/map-indoor/layer — the indoor floors as a THREE.Group for a host's own scene, renderer and camera,
// plus the campus data sources. No DOM, no CSS: safe to import anywhere three.js runs (docs/LAYER.md).
export { createIndoorLayer } from './indoor-layer.js';
export { floorRank, ROOM_STATUSES } from '../data/indoor.js';
export { campusCdnSource, convertBuildings, convertFloor, CAMPUS_SCHEMA_VERSION } from '../data/sources.js';
export { campusModelSource, MODELS_SCHEMA_VERSION } from '../data/models.js';
