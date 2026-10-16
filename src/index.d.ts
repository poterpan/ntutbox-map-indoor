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
/**
 * Shows several indoor buildings as one: `mergeBuildings(source, { B1D: ['B1D', 'B2D'] })`. The target's floor
 * list is the union (floorRank order), each floor holds every member's spaces (matched by floor id), the other
 * members leave the building index, and the target's footprint gets their outlines. Merged spaces keep their
 * spaceId and carry `sourceBuildingId`; room keys use the target, so members must not share room numbers on a floor.
 */
export function mergeBuildings<S extends CampusSource>(source: S, groups: Record<string, string[]>): CampusSource & { load(): ReturnType<S['load']> };
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

export interface Insets {
  top?: number; right?: number; bottom?: number; left?: number;
  /** The bottom inset is a full-width overlay (a phone bottom sheet): the floor rail and the compass are lifted
   *  above it, the rail gets shorter (and scrolls). Default false: a partial overlay (a legend in a corner) only
   *  affects the framing. Call map.refreshInsets() when it changes. */
  bottomSpansWidth?: boolean;
}

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
  /** Top face of the low walls; default wallSide (the same colour all round). */
  wallTop?: number;
  /** Room edges, neighbour-floor outlines. */
  outline: number;
  /** Outer edge of the focused floor. */
  focusEdge: number;
  /** Selection / hover tint and selection outline. */
  accent: number;
  /** Spaces a host draws as rooms (spaceClass → 'room'). */
  place: number; placeSide: number;
}

/** Space class: how a space is drawn. 'room' (a named non-classroom place drawn like a room) only comes from spaceClass. */
export type SpaceClass = 'classroom' | 'room' | 'corridor' | 'vertical' | 'restroom' | 'service';

/** One drawn indoor space (split GIS polygons of one room share a key). Read-only. */
export interface SpaceInfo {
  /** Classrooms "B/F/classNumber"; other spaces "B/F/number" for a number's primary space, else their GIS id ("B/F/501#2", "B/F/~hash"). */
  readonly key: string;
  readonly buildingId: string;
  readonly floorId: string;
  /** GIS space id (CDN `id`). */
  readonly id: string | null;
  /** CDN `t`: a type (教室, 研究室, 男廁…) or a proper name (學生輔導中心辦公室, 國家太空中心…). */
  readonly type: string | null;
  /** CDN `te`: English name / category, often missing. */
  readonly typeEn: string | null;
  /** CDN `n`: room / door number. */
  readonly number: string | null;
  /** CDN `c`: GIS category code (001 / 002 classrooms, 501 restrooms, 503 elevators, 504 stairs, 505 corridors…). */
  readonly category: string | null;
  readonly cls: SpaceClass | string;
  /** m², of the largest polygon piece. */
  readonly area: number;
  /** selectable(space) at build time: has a key in pick / setSelected / roomBox. */
  readonly selectable: boolean;
}

/** What spaceLabel returns: replaces the default labels (room numbers, 電梯／樓梯／WC). */
export interface SpaceLabelSpec {
  text: string;
  /** Collision order, higher first. Default as for the built-in labels. */
  priority?: number;
  /** Label kind for classFor. Default: the room status for classrooms, else 'poi' (density declutter). */
  kind?: string;
  /** Fade in between these screen densities [from, to] (px per metre), e.g. to hide long names on small rooms until zoomed in. */
  fadeIn?: [number, number];
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
  /** Stack: extra gap, as a fraction of stackGap, where floors without classrooms were skipped (stackFloors 'classrooms'). Default .45. */
  skipExtra?: number;
  /** Floor: spacing per storey around the focused floor. Default floorHeight. */
  floorGap?: number;
  /** Floor: base height of the focused floor. Default max(elevation(floor), groundY). */
  focusY?: number;
  /** Stack, entries mode (stackFloors 'all' or a function): show only entries start … start + size − 1 (entry
   *  indices, bottom first). The window's bottom entry sits where the first entry would, so the camera can stay put
   *  while the window scrolls; start may be fractional (dragging: the edge entries fade). Clamped; null = all. */
  stackWindow?: { start: number; size: number } | null;
  /** Stack, entries mode: progressive spacing, slot s (from the window's bottom) at stackGap·(s + bend·s²/2). A perspective
   *  host passes a small negative value so floors nearer its camera (higher up) are not spaced wider on screen. Default 0. */
  stackBend?: number;
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
  /** Clamped stack window, or null. */
  readonly stackWindow: { readonly start: number; readonly size: number } | null;
  readonly stackBend: number;
}

/** One entry of the stack overview, bottom to top. */
export interface StackEntry {
  /** The floor drawn for this entry (a collapsed run: its floor nearest the ground); badge id badge:B/<id>. */
  readonly id: string;
  /** Floors the entry stands for (one, or a collapsed run). */
  readonly floors: readonly string[];
  /** A run returned as an array by stackFloors: drawn in a compact slot, badge text "R1–R3". */
  readonly collapsed: boolean;
  /** "7F", or "R1–R3" for a run. */
  readonly label: string;
}

/** What a stackFloors function gets per floor (bottom to top). */
export interface StackFloorInfo extends FloorStats {
  /** Every drawn space of the floor (selectable or not). */
  readonly spaces: readonly SpaceInfo[];
}

/** Host grouping of the stack: floor ids, or arrays of floor ids (a collapsed run), bottom to top and in order.
 *  Floors left out are hidden in the stack (no skip marker). An invalid result falls back to every floor. */
export type StackGrouping = (floors: readonly StackFloorInfo[], buildingId: string) => ReadonlyArray<string | readonly string[]>;

export interface PickResult {
  /** 'room' a selectable space (default: classrooms); 'space' any other space or a wall (cls 'wall'); 'floor' a slab. */
  kind: 'room' | 'space' | 'floor';
  building: string;
  floor: string;
  /** Selectable space key ("buildingId/floorId/classNumber" for classrooms). */
  key?: string;
  /** Space class: classroom | room | corridor | vertical | restroom | service | wall. */
  cls?: string;
  /** The space hit (rooms and spaces; null for walls). */
  space?: SpaceInfo | null;
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
  /** room: RoomStatus; facilities 'poi'; 'entrance'; badge 'open' | 'partial' | 'full' (+ ' collapsed' for a run), 'more'; 'skip'. */
  readonly kind: string;
  /** Collision order, higher first (entrance 3, rooms 2–2.5 by area, facilities 1). */
  readonly priority: number;
  /** 0..1 from the presentation (pixel-density declutter is the overlay's job). */
  readonly opacity: number;
  readonly key?: string;
  readonly floor?: string;
  /** Badges: that floor's stats. */
  readonly stats?: FloorStats;
  /** Badge of a collapsed stack entry: the floors it stands for. */
  readonly floors?: readonly string[];
  /** Windowed stack hint (role 'badge', kind 'more', no floor): "下面還有 N 層" / "上面還有 N 層". */
  readonly more?: 'below' | 'above';
  /** Host labels (spaceLabel): the space's key, and its density fade. */
  readonly space?: string;
  readonly fadeIn?: [number, number];
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
  /** Floors in the stack overview: 'classrooms' (default; floors without classrooms are skipped with a marker), 'all',
   *  or a grouping function (collapsed runs; evaluated at build time). 'all' and functions allow stackWindow. */
  stackFloors?: 'classrooms' | 'all' | StackGrouping;
  /** Stack badge text per entry; null = no badge. Default "4F · 3/10 沒排課", a collapsed run "R1–R3" (`floors` set,
   *  stats of the drawn floor). Called again on setOccupancy. */
  badgeText?: (floor: FloorStats & { floors?: readonly string[] }) => string | null;
  /** Which spaces are selectable (key, pick kind 'room', tint, outline). Default: classrooms. Evaluated at build time. */
  selectable?: (space: SpaceInfo) => boolean;
  /** Label per space (once per key); null = none. Replaces the default labels except the 正門 marker. */
  spaceLabel?: (space: SpaceInfo) => SpaceLabelSpec | null;
  /** Where stack badges sit along the depth of the overview's left edge: 'middle' (default) or 'near' the camera
   *  (perspective hosts: the near edge is the leftmost on screen, so badges never overlap the floors). */
  badgeAnchor?: 'middle' | 'near';
  /** Override how a space is drawn; return null to keep the default class. 'room' = drawn like a room in the place colour. */
  spaceClass?: (space: SpaceInfo) => SpaceClass | null;
  /** Low walls around this space (any drawn space). Default: classrooms only. Evaluated at build time. */
  spaceWalls?: (space: SpaceInfo) => boolean;
  /** Floor slabs. 'footprint' (default): the building footprint, or the hull of a floor that does not fit it.
   *  'spaces': a floor whose spaces split into separate parts, or cover less than 60 % of that slab, gets one plate
   *  per part, shaped by the spaces themselves (gaps under 1 m closed, courtyards kept, < 2 m² slivers dropped).
   *  Loads a small polygon module (~25 KB gzip) on first use. */
  slab?: 'footprint' | 'spaces';
  /** slab 'spaces': floors that keep the footprint slab anyway (partial data): "B/F" ids, or a predicate. */
  slabFootprintFloors?: readonly string[] | ((buildingId: string, floorId: string) => boolean) | null;
  /** Stack hover emphasis (setHoveredFloor). Default null = the classic look (other floors .28, nothing else).
   *  fade: other floors' fill; outline: accent outline on the hovered floor (default true); lift: rise as a
   *  fraction of stackGap; the hovered floor's badge kind gets ' hover'. */
  hoverStyle?: { fade?: number; outline?: boolean; lift?: number } | null;
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
  /** Ground outline [x, z] of one floor's slab, in the layer frame ([] when unknown). Add the floor's current y yourself. */
  floorOutline(buildingId: string, floorId: string): [number, number][];
  /** Every slab plate's outline [x, z] (several with slab 'spaces'); the first, largest, is floorOutline. */
  floorOutlines(buildingId: string, floorId: string): [number, number][][];
  /** The stack overview's entries, bottom to top ([] when not loaded). */
  stackEntries(buildingId: string): StackEntry[];
  room(key: string): RoomInfo<O> | null;
  /** Any drawn space of a loaded building by key (selectable or not). */
  space(key: string): SpaceInfo | null;
  /** Every drawn space of a loaded building, one per key (for search). [] when not loaded. */
  spaces(buildingId: string): SpaceInfo[];
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
  /** Fade in between these screen densities [from, to] (px per metre). */
  fadeIn?: [number, number];
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
