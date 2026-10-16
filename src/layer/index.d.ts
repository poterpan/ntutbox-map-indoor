// Types for @ntutbox/map-indoor/layer (DOM-free subset). Definitions live in ../index.d.ts.
export {
  createIndoorLayer, floorRank, ROOM_STATUSES,
  campusCdnSource, mergeBuildings, convertBuildings, convertFloor, CAMPUS_SCHEMA_VERSION,
  campusModelSource, MODELS_SCHEMA_VERSION,
} from '../index.js';
export type {
  IndoorLayer, IndoorLayerOptions, IndoorLabel, IndoorLabelRole, IndoorPalette, PickResult, Presentation, PresentationMode,
  PresentationOptions, BuildingConfig, BuildingIndexEntry, CampusData, CdnCampusData, CampusSource, FloorStats, HasStatus,
  MapError, ModelManifest, ModelManifestEntry, ModelSource, Occupancy, OccupancyRecord, RoomInfo, RoomStatus, SpaceInfo, SpaceClass, SpaceLabelSpec,
  StackEntry, StackFloorInfo, StackGrouping,
} from '../index.js';
