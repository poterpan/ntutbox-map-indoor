// Type definitions for @ntutbox/map. The runtime is plain JavaScript (src/index.js); keep these in step
// with createIndoorMap's options, callbacks and returned API.
import type { FeatureCollection, MultiPolygon, Polygon } from './geojson.js';

export type RoomStatus = 'free' | 'soon' | 'busy' | 'unknown';
export const ROOM_STATUSES: readonly RoomStatus[];

/** Bottom-to-top rank of a floor id (B1 < 1F < 1M < 2F < … < RF < PH). */
export function floorRank(id: string): number;

/** Per-building display config. Normally `(await source.load()).buildings`. */
export interface BuildingConfig {
  name: string;
  short?: string;
  /** Compass side of the main entrance (0 = north, 90 = east). Views are oriented from it. */
  entranceBearing?: number;
  entranceConfirmed?: boolean;
}

export interface BuildingIndexEntry {
  buildingId: string;
  name?: string;
  nameAliases?: string[];
  floorIds: string[];
}

export interface CampusData {
  buildingIndex: { buildings: BuildingIndexEntry[] };
  /** Campus footprints; properties: buildingId, name, campusId. */
  buildingsData: FeatureCollection<Polygon | MultiPolygon>;
  /** Every building with indoor data; the default config for options.buildings. */
  buildings: Record<string, BuildingConfig>;
  frameInfo?: { crs: string; origin: [number, number]; unit: string };
  [extra: string]: unknown;
}

/** What campusCdnSource().load() adds: the published pointer and manifest. */
export interface CdnCampusData extends CampusData {
  current: { schema_version: number; revision: number; manifest: string; update_sequence?: number | null; [extra: string]: unknown };
  manifest: { files: Record<string, { path: string; [extra: string]: unknown }>; [extra: string]: unknown };
}

/** Where campus data comes from. campusCdnSource() is the default; any object of this shape works. */
export interface CampusSource {
  frame?: 'lonlat' | 'planar-cm';
  load(): Promise<CampusData>;
  floor(buildingId: string, floorId: string): Promise<FeatureCollection<Polygon | MultiPolygon> | null>;
}

export const CAMPUS_SCHEMA_VERSION: number;
export function campusCdnSource(baseUrl?: string, options?: { fetch?: typeof fetch }): CampusSource & { frame: 'planar-cm'; load(): Promise<CdnCampusData> };
export function convertBuildings(doc: unknown): CampusData;
export function convertFloor(doc: unknown): FeatureCollection<MultiPolygon>;

export interface ModelManifestEntry {
  centroidEN: [number, number];
  file: string;
  [extra: string]: unknown;
}
export interface ModelManifest {
  schema_version: number;
  crs: string;
  buildings: Record<string, ModelManifestEntry>;
  [extra: string]: unknown;
}
/** 3D building models for the campus view. campusModelSource() reads the token-gated models.ntutbox.com. */
export interface ModelSource {
  load(): Promise<ModelManifest>;
  glb(buildingId: string): Promise<ArrayBuffer>;
}
export const MODELS_SCHEMA_VERSION: number;
export function campusModelSource(options?: {
  /** Same-origin endpoint answering { token, expiresAt, base }. Default '/api/model-token'. */
  tokenUrl?: string;
  fetch?: typeof fetch;
  /** Clock in unix seconds (tests). */
  now?: () => number;
}): ModelSource;

/** Host-supplied timetable state of one room; extra fields come back in onRoomSelect. */
export interface OccupancyRecord {
  status: RoomStatus;
  [extra: string]: unknown;
}
/** What a host's occupancy records must have. Hosts usually pass their own record type as `O`. */
export interface HasStatus { status: RoomStatus }
/** Keyed "buildingId/floorId/classNumber". */
export type Occupancy<O extends HasStatus = OccupancyRecord> = Map<string, O> | Record<string, O>;

export interface Insets { top?: number; right?: number; bottom?: number; left?: number }

export type MapView = 'campus' | 'overview' | 'floor';

export interface FloorStats { id: string; total: number; available: number; free: number; unlocated: number }
export interface ViewInfo {
  view: MapView;
  building: string;
  buildingName?: string;
  buildingShort?: string;
  floor: string | null;
  /** Bottom to top. */
  floors: FloorStats[];
}

export interface RoomInfo<O = OccupancyRecord> {
  key: string;
  buildingId: string;
  buildingName: string;
  floorId: string;
  classNumber: string;
  gisName: string;
  status: RoomStatus;
  /** The host's record for this room, as passed in occupancy. */
  occupancy: O | null;
}

export interface CampusFocus { buildingId: string; name: string; via: 'tap' | 'zoom' | 'return' }

export type MapError =
  | { type: 'load-failed'; error: unknown }
  | { type: 'building-load-failed'; building: string; error: unknown }
  | { type: 'floor-missing'; building: string; floor: string; status: number };

export type ModelsError =
  | { type: 'models-unavailable'; error: unknown }
  | { type: 'models-frame-mismatch'; error: Error }
  | { type: 'model-failed'; buildings: string[] };

export interface IndoorMapOptions<O extends HasStatus = OccupancyRecord> {
  source?: CampusSource;
  /** Pass `(await source.load()).buildings`; without it only a three-building fallback is known. */
  buildings?: Record<string, BuildingConfig>;
  occupancy?: Occupancy<O> | null;
  initialBuilding?: string;
  initialView?: MapView;
  /** Building ids to fetch in the background. */
  preload?: string[];
  debug?: boolean;
  tapEmptyToExit?: boolean;
  /** Campus view: campus "A" plus indoor buildings within this radius (m). Default 250. */
  campusRadiusM?: number;
  /** Pixels of the map covered by host UI. Call map.refreshInsets() when they change. */
  getInsets?: (() => Insets) | null;
  insets?: Insets;
  /** 3D building models replacing the white model where available. */
  models?: ModelSource | null;

  onViewChange?: (info: ViewInfo) => void;
  onRoomSelect?: (room: RoomInfo<O> | null) => void;
  onCampusFocus?: (focus: CampusFocus | null) => void;
  onError?: (error: MapError) => void;
  onLoading?: (info: { building: string }) => void;
  onNotice?: (text: string) => void;
  onModelsLoaded?: (info: { loaded: number; failed: string[] }) => void;
  onModelsError?: (error: ModelsError) => void;
}

export interface IndoorMap<O extends HasStatus = OccupancyRecord> {
  /** Resolves once the first building is shown (or loading failed; see onError). */
  ready: Promise<void>;
  /** Resolves false when refused (destroyed, not started, or a flight in progress). */
  setView(view: { building?: string; view?: MapView; floor?: string | null; animate?: boolean }): Promise<boolean>;
  /** key = "buildingId/floorId/classNumber". Resolves false if the room has no polygon or the call was refused. */
  selectRoom(key: string, options?: { animate?: boolean }): Promise<boolean>;
  setOccupancy(occupancy: Occupancy<O> | null): void;
  enterBuilding(id: string): Promise<void>;
  resetView(): void;
  /** Host UI over the map changed size: re-read getInsets, keep the selected room visible. */
  refreshInsets(options?: { animate?: boolean }): void;
  clearSelection(): void;
  getView(): ViewInfo;
  destroy(): void;
}

/** Must run in the browser; throws when WebGL is unavailable. The engine adds its own element inside `container`. */
export function createIndoorMap<O extends HasStatus = OccupancyRecord>(container: HTMLElement, options?: IndoorMapOptions<O>): IndoorMap<O>;
