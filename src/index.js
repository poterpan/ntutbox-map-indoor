// @ntutbox/map-indoor — indoor and campus map for 北科盒子 (NTUT Box).
// Styles are separate: import '@ntutbox/map-indoor/style.css'.
// '@ntutbox/map-indoor/layer' is the DOM-free subset (IndoorLayer + data) for hosts with their own three.js scene.
export { createIndoorMap } from './viewer/indoor-map.js';
export { createIndoorLayer } from './layer/indoor-layer.js';
export { createLabelOverlay, defaultLabelClass } from './overlay/label-overlay.js';
export { floorRank, ROOM_STATUSES } from './data/indoor.js';
export { campusCdnSource, convertBuildings, convertFloor, CAMPUS_SCHEMA_VERSION } from './data/sources.js';
export { campusModelSource, MODELS_SCHEMA_VERSION } from './data/models.js';
