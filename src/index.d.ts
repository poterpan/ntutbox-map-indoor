// Type definitions for @ntutbox/map-indoor. The runtime is plain JavaScript (src/index.js); keep these in step
// with createIndoorMap's options, callbacks and returned API, and with createIndoorLayer / createLabelOverlay
// (docs/LAYER.md). The layer and overlay types reference three.js types (install @types/three to use them).
import type { FeatureCollection, MultiPolygon, Polygon } from './geojson.js';
import type { Box3, Camera, Group, Object3D, Raycaster, Vector3 } from 'three';

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

// ---------------------------------------------------------------------------------------------
// IndoorLayer: the indoor floors in a host's own three.js scene (docs/LAYER.md).
// World frame: Y-up metres, x = E − 302800, y = height, z = −(N − 2770400) (TWD97). Never transform layer.object.
// ---------------------------------------------------------------------------------------------

/** Indoor colours (hex). Status fills: free / soon / room (= busy) / unknown, each with a darker side colour. */
export interface IndoorPalette {
  slabTop: number; slabSide: number;
  room: number; roomSide: number;
  free: number; freeSide: number;
  soon: number; soonSide: number;
  unknown: number; unknownSide: number;
  corridor: number; corridorSide: number;
  vertical: number; verticalSide: number;
  restroom: number; restroomSide: number;
  service: number; serviceSide: number;
  wall: number; wallSide: number;
  /** Room edges, neighbour-floor outlines. */
  outline: number;
  /** Outer edge of the focused floor. */
  focusEdge: number;
  /** Selection / hover tint and selection outline. */
  accent: number;
}

export type PresentationMode = 'inplace' | 'stack' | 'floor';

export interface PresentationOptions {
  /** Building to show (must be loaded), or null to hide (animated: it drops to its real heights and fades out). */
  building: string | null;
  /** 'inplace' every floor at its elevation; 'stack' exploded overview; 'floor' one floor. Default 'stack'. */
  mode?: PresentationMode;
  /** Required for mode 'floor'. */
  floor?: string | null;
  /** Stack: distance between overview floors (m). Default 3 × floorHeight. Changing it only re-lays out. */
  stackGap?: number;
  /** Stack: extra gap, as a fraction of stackGap, where floors without classrooms were skipped. Default .45. */
  skipExtra?: number;
  /** Floor: spacing per storey around the focused floor. Default floorHeight. */
  floorGap?: number;
  /** Floor: base height of the focused floor. Default max(elevation(floor), groundY). */
  focusY?: number;
  /** Ground direction [x, z] pointing to the screen's right; floor badges and skip markers line up on the
   *  opposite (left) edge of the stack. Default: the previous value, else [1, 0] (east). */
  screenRight?: [number, number];
  animate?: boolean;
  /** ms, default 650. */
  duration?: number;
  /** Default easeInOutCubic. */
  easing?: (t: number) => number;
}

/** The current target presentation (where the layer is, or is going). */
export interface Presentation {
  readonly building: string | null;
  readonly mode: PresentationMode;
  readonly floor: string | null;
  readonly stackGap: number;
  readonly skipExtra: number;
  readonly floorGap: number;
  readonly focusY?: number;
  readonly screenRight: [number, number] | null;
}

export interface PickResult {
  /** 'room' a classroom; 'space' any other space or a wall (cls 'wall'); 'floor' a slab. */
  kind: 'room' | 'space' | 'floor';
  building: string;
  floor: string;
  /** "buildingId/floorId/classNumber" for rooms. */
  key?: string;
  /** Space class: classroom | corridor | vertical | restroom | service | wall. */
  cls?: string;
  point: Vector3;
  distance: number;
  object: Object3D;
}

export type IndoorLabelRole = 'room' | 'badge' | 'skip';

/** Label data for an overlay. Objects are reused between calls; read them, do not keep them. */
export interface IndoorLabel {
  /** Stable across frames and presentation changes: room:KEY, poi:B/F/n, entrance:B, badge:B/F, skip:B/F1-F2. */
  readonly id: string;
  /** World position for the current frame. */
  readonly position: Vector3;
  readonly text: string;
  /** 'room' (room numbers, facilities, entrance), 'badge' (floor summary in the stack), 'skip' (floors without classrooms). */
  readonly role: IndoorLabelRole;
  /** room: RoomStatus; facilities 'poi'; 'entrance'; badge 'open' | 'partial' | 'full'; 'skip'. */
  readonly kind: string;
  /** Collision order, higher first (entrance 3, rooms 2–2.5 by area, facilities 1). */
  readonly priority: number;
  /** 0..1 from the presentation (pixel-density declutter is the overlay's job). */
  readonly opacity: number;
  readonly key?: string;
  readonly floor?: string;
  /** Badges: that floor's stats. */
  readonly stats?: FloorStats;
}

export interface IndoorLayerOptions<O extends HasStatus = OccupancyRecord> {
  source: CampusSource;
  buildings?: Record<string, BuildingConfig>;
  occupancy?: Occupancy<O> | null;
  /** Storey height for elevation(); default 3.2. */
  floorHeight?: number;
  /** Height of 1F's floor; default 0. */
  groundY?: number;
  palette?: Partial<IndoorPalette>;
  /** Materials react to scene fog; default false. */
  fog?: boolean;
  /** cast: the focused floor (mode 'floor') casts shadows; default false. receive: default true. */
  shadows?: { cast?: boolean; receive?: boolean };
  /** Added to every renderOrder the layer sets (1–3); default 0. */
  renderOrderBase?: number;
  /** lonlat sources only: projection reference; default the centre of campus "A". */
  lonlatOrigin?: { lon: number; lat: number } | (() => { lon: number; lat: number });
  /** 'floor-missing' when a floor file is absent. Load failures reject load() instead. */
  onError?: (error: MapError) => void;
}

export interface IndoorLayer<O extends HasStatus = OccupancyRecord> {
  /** Add this to your scene. One child group per loaded building. */
  readonly object: Group;
  /** Fetch and build a building (kept, hidden, until shown). Several can be loaded. Rejects on load failure. */
  load(buildingId: string): Promise<void>;
  unload(buildingId: string): void;
  /** Fetch a building's floor data without building geometry. */
  prefetch(buildingId: string): Promise<void>;
  isLoaded(buildingId: string): boolean;
  /** Resolves true when it lands, false when superseded by the next call (or disposed). Rejects for an unknown building / floor. */
  setPresentation(p: PresentationOptions): Promise<boolean>;
  readonly presentation: Presentation;
  /** True while a presentation change is animating. */
  readonly animating: boolean;
  /** Advance animations by dt seconds. Returns true while anything still moves (keep rendering). */
  update(dt: number): boolean;
  pick(raycaster: Raycaster): PickResult | null;
  /** Recolours rooms. Returns true when the set of rooms changed and the building was rebuilt (layout kept). */
  setOccupancy(occupancy: Occupancy<O> | null): boolean;
  /** Stack: keep this floor solid and fade the others. */
  setHoveredFloor(floorId: string | null): void;
  setHovered(key: string | null): void;
  /** Selection visual: accent outline + slight tint. */
  setSelected(key: string | null): void;
  /** 0..1: emissive = colour × k, so status colours stay readable in a dark scene. */
  setEmissive(k: number): void;
  /** World boxes in the layout the presentation lands in (stack: the overview floors only). */
  buildingBox(buildingId: string): Box3 | null;
  floorBox(buildingId: string, floorId: string): Box3 | null;
  roomBox(key: string): Box3 | null;
  /** Bottom to top. */
  floors(buildingId: string): FloorStats[];
  /** (storey index − index of 1F) × floorHeight + groundY. */
  elevation(buildingId: string, floorId: string): number | null;
  /** Ground points [x, z] of what the stack shows (footprint + overview floor hulls), to derive a stack gap. */
  outlinePoints(buildingId: string): [number, number][];
  room(key: string): RoomInfo<O> | null;
  /** Labels of the shown building for this frame. */
  labels(): readonly IndoorLabel[];
  dispose(): void;
}

/** No DOM, no renderer, no camera. */
export function createIndoorLayer<O extends HasStatus = OccupancyRecord>(options: IndoorLayerOptions<O>): IndoorLayer<O>;

// ---------------------------------------------------------------------------------------------
// Label overlay: DOM labels for any camera (orthographic or perspective).
// ---------------------------------------------------------------------------------------------

export interface OverlayLabel {
  id: string;
  position: Vector3;
  text: string;
  /** 'room' and 'campus' labels avoid each other; 'badge' labels get click / hover callbacks. */
  role: string;
  kind?: string;
  priority?: number;
  opacity: number;
  floor?: string;
}

export interface LabelOverlayOptions<L extends OverlayLabel = OverlayLabel> {
  /** Base class of every label element; default 'label' (styled by the package stylesheet inside .indoor-map). */
  className?: string;
  /** Extra classes per label; default defaultLabelClass. Called every frame; cheap and pure. */
  classFor?: (label: L) => string;
  onBadgeClick?: (label: L) => void;
  onBadgeHover?: (label: L | null) => void;
  collision?: { gap: number; hysteresis: number };
  /** kind 'poi' labels fade in between these screen densities (px per metre). Default 6 → 8.5. */
  declutter?: { poiFrom: number; poiTo: number };
  pixelsPerMetre?: (camera: Camera, world: Vector3, height: number) => number;
}

export interface LabelOverlay<L extends OverlayLabel = OverlayLabel> {
  /** Every frame, after the camera moved: diff the elements, project, declutter, avoid collisions. */
  update(camera: Camera, labels: readonly L[]): void;
  /** Create / remove / restyle elements without positioning (e.g. before measuring). */
  sync(labels: readonly L[]): void;
  /** Widest label element matching filter, in px. */
  maxWidth(filter?: (label: L) => boolean): number;
  element(id: string): HTMLElement | null;
  clear(): void;
  dispose(): void;
}

/** Label elements are appended to `container`, which should be positioned and cover the canvas. */
export function createLabelOverlay<L extends OverlayLabel = OverlayLabel>(container: HTMLElement, options?: LabelOverlayOptions<L>): LabelOverlay<L>;
export function defaultLabelClass(label: OverlayLabel): string;
