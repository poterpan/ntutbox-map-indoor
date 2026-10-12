# 拆層設計（0.12，2026-10-11 定案）

目的：讓室內內容能畫進**宿主自己的** three.js 場景、renderer、相機（map.ntutbox.com 的室外→室內轉場），
同時保留排課站在用的獨立檢視器 `createIndoorMap`（API 不變）。一份幾何程式碼，兩個站共用。

## 分層

```
src/data/     資料：campusCdnSource、campusModelSource、convert*（sources.js、models.js）、
              floorRank、教室鍵、教室判定、佔用狀態整理、loadCampus（indoor.js）、座標投影（frame.js）
src/layer/    IndoorLayer：THREE.Group ＋ 狀態機。不碰 renderer／相機／DOM（不准引用 document、window）
              indoor-layer.js 狀態機、layout.js 純版面函式、geometry.js 幾何與材質、index.js 子路徑入口
src/overlay/  createLabelOverlay：DOM 標籤（投影、量測、碰撞＋遲滯、徽章點擊／hover、差量更新）
src/viewer/   createIndoorMap：renderer＋正交相機＋手勢＋樓層軌＋指北針＋燈光＋校園白模／GLB，建在 layer＋overlay 上
```

- 依賴方向只能 viewer → overlay → layer → data。
- `package.json` 加 `./layer` 子路徑匯出（layer＋data，無 DOM／CSS）；主入口另外匯出 `createIndoorLayer`、`createLabelOverlay`。three 必須是宿主那一份（peer dependency）；宿主本地開發用 `resolve.dedupe: ['three']`。
- 版本：0.12.0（minor，viewer API 不變）；室外上線穩定後再出 1.0。

## 座標：全生態系唯一的契約框架

- **Y-up、公尺、原點 = TWD97 (302800, 2770400)**：`x = E − 302800`、`y = 高度`、`z = −(N − 2770400)`。
- CDN 的 `planar-cm` 資料就是相對同一原點的整數公分：`x = cmX / 100`、`z = −cmY / 100`。
- 拿掉 `WORLD_ORIGIN` 重新置中（距原點不到 1 km，float32 精度足夠）。
- viewer 內部也用同一框架（正交相機的 up／heading 改成繞 Y 軸）。不准用「包一層旋轉 −90°」的捷徑。

## 樓層位置

layer 不知道「真實高度」以外的版面意義，由宿主給參數：

- `elevation(floorId)` = 樓層序 × `floorHeight` + `groundY`（1F 地板在 `groundY`，B1 為負）。
  樓層序 = 該層在排序後樓層清單中的位置 − 1F 的位置（夾層也算一層，與 0.11 校園轉場一致；沒有 1F 時以總覽最低層為 0）。
- `inplace`：每層在 `elevation`（轉場起點；樓板外框為主，房間淡）。
- `stack`：爆炸圖總覽，預設只列有教室的樓層（`stackFloors: 'all'` 列全部，沒有跳層標記）（連續無教室樓層加 `skipExtra` 間距與「xF–yF 沒有教室」標記），
  層距 `stackGap` 由宿主給（viewer 依正交視角算；室外依透視自己給）。改 `stackGap` 只重排、不重建幾何。
  `skipExtra` 以 `stackGap` 為單位（預設 .45）。宿主要算層距時用 `outlinePoints(id)`（總覽顯示範圍的地面點）。
  樓層徽章與跳層標記排在總覽左緣：宿主用 `screenRight`（畫面右方的地面方向 [x, z]）告訴 layer 哪邊是左。
- `floor`：手風琴版面——焦點層在 `focusY`，鄰層以 `floorGap` 間隔排上下。
  - viewer 傳 `floorGap = stackGap`、`focusY` = 現在的手風琴位置（像素一致）。
  - 室外傳 `floorGap = floorHeight`、`focusY = max(elevation, groundY)`：**地下樓層抬到地面**，宿主不切地面。

## IndoorLayer API

完整型別在 `src/index.d.ts`。

```ts
createIndoorLayer(options: {
  source: CampusSource;
  buildings?: Record<string, BuildingConfig>;
  occupancy?: Occupancy | null;
  floorHeight?: number;          // 預設 3.2
  groundY?: number;              // 預設 0
  palette?: Partial<IndoorPalette>;
  fog?: boolean;                 // 預設 false
  shadows?: { cast?: boolean; receive?: boolean };  // 預設 cast=false
  renderOrderBase?: number;      // 預設 0；宿主避免和自己的透明物件打架
  lonlatOrigin?: { lon, lat } | (() => { lon, lat });  // 只有 lonlat 來源用；預設 A 校區中心
  onError?: (e: MapError) => void;  // 只報 floor-missing；載入失敗由 load() reject
}): IndoorLayer

interface IndoorLayer {
  readonly object: THREE.Group;
  load(buildingId): Promise<void>;          // 取資料＋建幾何（常駐、隱藏），可預載；可同時載多棟
  unload(buildingId): void;
  prefetch(buildingId): Promise<void>;      // 只取資料、不建幾何（校園小卡、preload 用）
  isLoaded(buildingId): boolean;
  setPresentation(p: {
    building: string | null;
    mode: 'inplace' | 'stack' | 'floor';
    floor?: string | null;                  // floor 模式必填
    stackGap?: number; skipExtra?: number;  // 預設 3 × floorHeight、.45
    floorGap?: number; focusY?: number;     // 預設 floorHeight、max(elevation, groundY)
    screenRight?: [number, number];         // 徽章對齊用；預設沿用上次，否則 [1, 0]
    animate?: boolean;
    duration?: number;                      // 預設 650 ms
    easing?: (t: number) => number;         // 預設 easeInOutCubic（現在的 stepTween）
  }): Promise<boolean>;                     // true = 落地；false = 被下一次 setPresentation 取代
  readonly presentation: Presentation;      // 目標（落地後的）版面
  readonly animating: boolean;              // presentation 動畫中
  update(dt: number): boolean;              // 不收相機；回傳 true = 還在動（含淡入淡出）
  pick(raycaster): PickResult | null;       // {kind:'room'|'space'|'floor', building, floor, key?, cls?, space?}；room＝selectable
  setOccupancy(o: Occupancy | null): boolean;  // 0.12 改材質色；教室集合變了才重建（回傳 true）
  setHoveredFloor(floorId | null): void;    // stack 模式 hover 淡化（現在的 setStackHover）
  setHovered(key | null): void;
  setSelected(key | null): void;            // 新視覺（輪廓＋微染）；viewer 0.12 不呼叫
  setEmissive(k: number): void;             // 0..1，emissive = 顏色 × k；室外夜間讓狀態色仍讀得出來
  buildingBox(id) / floorBox(id, floorId) / roomBox(key): THREE.Box3 | null;   // 世界座標、依目前 presentation 的落地版面
  floors(id): FloorStats[];
  elevation(id, floorId): number | null;
  outlinePoints(id): [x, z][];              // 總覽顯示的地面點（外框＋超出外框樓層的凸包）
  room(key): RoomInfo | null;
  labels(): readonly IndoorLabel[];         // {id 穩定, position 世界座標, text, role, kind, priority, opacity, key?, floor?}
  dispose(): void;
}
```

- `null → X` 且 `animate`：從 `inplace`、可見度 0 開始（現在的 `floorVisibility`）。
- 「落地」才把鄰層從填色切到外框、viewer 才恢復輸入——靠 `setPresentation` 的 Promise。
- 像素密度相關的標籤漸隱（POI declutter）與正交特有的版面計算移到 overlay／viewer。
- `labels()` 的 `kind` 是語意值：房間＝狀態（free／soon／busy／unknown）、設施 `poi`、`entrance`、
  徽章 `open`／`partial`／`full`、`skip`；overlay 的 `defaultLabelClass` 換成 CSS class（free → available 等）。
  `role`：`room`（房號、設施、正門，彼此避讓）、`badge`、`skip`。位置每次呼叫依當下畫面更新，物件重複使用。
- `inplace` 的樣子：每層填色 .18、樓板外框 .55，不顯示樓層徽章（徽章只屬於 stack）。
- 已顯示 A 時直接 `setPresentation({ building: 'B', animate: true })`：A 立刻隱藏，B 照 `null → B` 從 inplace 淡入。

## 宿主掛鉤（0.12 第二輪，2026-10-12）

排課站（找空教室）與 map.ntutbox.com（找路：教室、系辦、辦公室、研究室）要的東西不同。套件只提供通用掛鉤，
語意（哪些空間算地點、標籤怎麼寫）留在宿主。**全部不給＝現在的排課站行為，像素不變**（視覺基準守住）。

```ts
createIndoorLayer({
  stackFloors?: 'classrooms' | 'all' | StackGrouping,  // 預設 classrooms：只列有教室的樓層＋「xF–yF 沒有教室」；all：每層都列、沒有跳層標記；
                                               // 函式：宿主分組（見下「高樓」）
  badgeText?: (floor: FloorStats & { floors? }) => string | null,  // 徽章字；null＝不顯示。收合的一格帶 floors。setOccupancy 後會再叫
  selectable?: (space: SpaceInfo) => boolean,  // 預設只有教室；能選的空間有 key、pick 回 kind 'room'、可 setSelected／roomBox
  spaceLabel?: (space: SpaceInfo) => { text, priority?, kind?, fadeIn? } | null,  // 取代預設標籤（正門除外），每個 key 一個
  spaceClass?: (space: SpaceInfo) => SpaceClass | null,  // 改畫法；'room'＝具名地點：place 色、教室高度、邊線（不加矮牆）
  badgeAnchor?: 'middle' | 'near',             // 透視宿主用 near：徽章在總覽靠相機那側，不壓到下面的樓層
})
layer.space(key): SpaceInfo | null             // 已載入棟的任何空間（能不能選都有）
layer.spaces(buildingId): SpaceInfo[]          // 一個 key 一筆；之後給搜尋用
```

- `SpaceInfo`：`{ key, buildingId, floorId, id, type (CDN t), typeEn (te), number (n), category (c), cls, area, selectable }`。
  `t` 可能是類型（教室、研究室、男廁）也可能是專有名稱（學生輔導中心辦公室、國家太空中心），宿主自己判斷。
- key：教室維持 `B/F/房號`；其他空間是該房號的「主空間」（GIS id 就是 `B/F/房號`）時用 `B/F/房號`，否則用自己的 GIS id
  （`B/F/501#2`、`B/F/~hash`）。同一房號分成多塊多邊形的同名空間共用一個 key（標籤只標最大那塊）。
- `selectable`／`spaceClass` 在建幾何時算；`setOccupancy` 讓教室集合變了才重建，非教室的地點不受佔用影響。
- `spaceLabel` 不給 `kind` 時：教室用佔用狀態（free／busy…，宿主之後接 `setOccupancy` 就有顏色），其他是 `poi`（密度淡出）。
  `fadeIn: [from, to]`（每公尺像素）由 overlay 處理：房間小、名稱長的標籤放大到放得下才淡入。
- 'room' 不加矮牆：宿主可能標幾百間，矮牆會蓋掉房間色（第二段時每段牆還是一個 draw call，AM 整棟 2733 → 2092 calls；第三段合併後牆不再影響 draw call，不加牆是畫法的選擇）。

## 高樓：收合與視窗（0.12 第三輪，2026-10-12）

AM（先鋒 21 層）這種高樓整棟擠不下：徽章疊在一起、手機上每層只剩一條線。兩個通用機制，預設都不開（排課站不變）：

```ts
type StackGrouping = (floors: StackFloorInfo[], buildingId) => Array<string | string[]>;
// StackFloorInfo = FloorStats ＋ spaces（該層所有空間的 SpaceInfo）。由下往上、照順序；陣列＝收合的一段
setPresentation({ mode: 'stack', stackWindow: { start, size } })  // 只顯示第 start … start+size−1 格（start 可帶小數＝拖曳中）
layer.stackEntries(id): StackEntry[]   // { id（畫出來的那層）, floors, collapsed, label: '7F' | 'R1–R3' }
```

- **收合**：分組函式回傳的陣列是一格（單獨一層也可以），畫它離地面最近的那層（R1–R3 畫 R1、B4–B2 畫 B2），只佔半格高；
  徽章字預設 `R1–R3`（`badgeText` 會收到 `floors`），kind 加 ` collapsed`。其他成員藏在它旁邊（換層時從那裡長出來）。
  函式沒列到的樓層不顯示（沒有跳層標記）；結果不合法（順序錯、不認得的樓層）就退回每層一格並 console.error。
  「哪些樓層算沒東西」是宿主的語意（map 用 placePolicy 的「有沒有可選地點」），套件不判斷。
- **視窗**：`stackFloors` 是 `'all'` 或函式時可用（`'classrooms'` 忽略）。視窗最下面那格永遠放在第一格的位置，所以
  捲動時相機不用動：樓層滑過一個固定的框，視窗外的淡出、不能點；`buildingBox` 只算視窗內。小數的 start 讓邊緣兩格半透明（拖曳）。
  標籤多兩個「下面還有 N 層」／「上面還有 N 層」（role `badge`、kind `more`、`more: 'below' | 'above'`、沒有 floor；N 是樓層數不是格數），
  宿主可以讓它點了就捲。
- 視窗大小、何時開、怎麼捲（拖曳、滾輪、樓層軌）都是宿主決定。

## Overlay API

```ts
createLabelOverlay(container, {
  classFor?, onBadgeClick?, onBadgeHover?, collision?, declutter?: { poiFrom, poiTo }, pixelsPerMetre?,
}): { update(camera, labels), sync(labels), maxWidth(filter?), element(id), clear(), dispose() }
```

- 標籤可帶 `fadeIn: [from, to]`（每公尺像素）：在這段密度間淡入（宿主掛鉤 `spaceLabel` 用）。
- 每幀 `update(camera, [...layer.labels(), ...宿主自己的標籤])`；正交、透視相機都可（px/m 依相機種類算）。
- 以 `id` 做差量：只有出現、消失、文字或 class 變了的標籤才動 DOM；文件順序＝清單順序。

## 材質與效能（第三段實作，2026-10-12）

- 每層幾個**合併 mesh**（`src/layer/geometry.js` 的 `buildFloor`），材質**每層一組**、不跨樓層共用（淡入淡出是每層獨立的）：
  - `base`：樓板、走廊、服務空間（不投影）；`cast`：教室、具名地點、樓梯電梯、廁所（焦點層投影）；
  - `walls`：所有矮牆，合併時底部在 y=0，mesh 站在 `WALL.base`、用 `mesh.scale.y` 長高（總覽 0.2 → 單層 1）；
  - `edges`：房間邊線（.24）；`spaceEdges`：焦點樣式的空間邊界（預設 0、不畫）；`focusEdge`／`outline` 照舊各一條。
  - 一層最多 5 個繪製物件（＋外框兩條 LineLoop），跟房間數無關。原本「每類一個材質、約 8 個」的規劃再合一步：
    同一層的填色全部同一個 program，分類只差顏色，分開只會多 draw call；只依「投不投影」分兩桶。
- 填色材質底色白＋`vertexColors`；狀態色（佔用、hover、選取微染、`spaceClass`、宿主 palette）寫進頂點色 attribute，
  `setOccupancy`／`setHovered`／`setSelected` 只改該空間的頂點範圍（`addUpdateRange`，只上傳那一段），不重建、不換材質。
- 夜間 emissive：材質 `emissive = 白 × k`，shader（`onBeforeCompile`）再乘頂點色，等於原本的「各空間顏色 × k」。
- 頂面與側面：拉伸體的頂／底蓋（group 0）用上色、側面用側色，都在頂點色裡；粗糙度統一 .9（牆 .95）。
- **透明／不透明**：材質建成透明；總覽（stack）落地、整層完全顯示時填色切成不透明（不混色、可提早深度剔除），
  淡化（hover、inplace、鄰層、飛行中）就切回透明。單層模式的焦點層維持透明：它要畫在鄰層外框之後蓋住它們。
  `transparent` 不同是兩個 shader program：layer 建立後前兩次 `update()` 期間多畫一個退化的不透明三角形，
  兩種 program 在載入時就編好，不會在第一次落地時卡一下。`depthWrite = 透明度 > 0.6`。
  宿主給了 `renderOrderBase`（＝要畫在自己的透明物件之後，例如 map 的半透明建築外殼）時一律維持透明：
  那個順序只存在於透明 pass，切不透明會被外殼蓋一層。
- 拾取：每層一個不畫的扁平代理（各空間頂面＋整塊樓板），`userData.pieces` 是三角形 → 空間的對照；
  單層模式另外對合併的牆 mesh 做 raycast（打到牆回 `cls: 'wall'`）。`pick()` 的結果與第二段相同，`object` 改成代理或牆 mesh。
- 選取外框（accent 輪廓）每次選取臨時重建該房間的 EdgesGeometry，固定 O(1) 個物件。
- 量測（map.ntutbox.com，Mac、medium 品質，`pnpm shots` 的 perf；calls 含室外場景約 390）：
  AM 整棟 2092 → 454 calls（室內本身 ~1700 → 60）、每幀 8.1 → 3.6 ms；A3T 4F 單層 366 → 289 calls、3.2 → 2.9 ms。
  排課站視覺基準（rest-state）最大差 0.0012%。

## 0.12 實作註記（第二段）

- 第二段留下的（每間一組材質、永遠透明、逐 mesh raycast、每段牆一個 BoxGeometry）第三段都做了，見上一節「材質與效能」。
- viewer 傳給 `layer.update` 的是實際經過時間（不夾 0.1 s），讓 layer 的飛行與相機（照時鐘走）同時落地；
  viewer 的「飛行中」＝相機鎖定或 layer 的 presentation Promise 未決。
- `?debug` 面板拿掉了 layer 內部的樣式滑桿（neighborFade、neighborOutline、outline、spaceEdges），常數改在
  `src/layer/indoor-layer.js` 開頭。
- 宿主嵌入範例：`dev/layer.html`＋`dev/layer.js`（透視相機、自己的燈光與霧、按需渲染）；
  截圖 `node tests/visual/layer-host.mjs <outDir>`。

## 分段（每段做完跑視覺基準比對，只比靜止狀態，門檻約 0.3%）

1. **Y-up 轉換**：只換座標框架與相機，不動結構。
2. **API 拆分**：layer／overlay／viewer 成形；layer 加 `node --test` 單元測試（樓層位置、總覽子集、拾取索引、頂點色）。
3. **合併幾何**（2026-10-12 完成）：在 `src/layer/` 內部完成，API 不動。map 標了幾百個具名地點後 AM 整棟 2092 calls，所以整套都做（見「材質與效能」）。

## 不在範圍

- 宿主端的建築剖開／半透明、宿主相機模式、地面處理、佔用資料來源（map 自己做）。
