# 拆層設計（0.12，2026-10-11 定案）

目的：讓室內內容能畫進**宿主自己的** three.js 場景、renderer、相機（map.ntutbox.com 的室外→室內轉場），
同時保留排課站在用的獨立檢視器 `createIndoorMap`（API 不變）。一份幾何程式碼，兩個站共用。

## 分層

```
src/data/     資料：campusCdnSource、campusModelSource、convert*、floorRank、教室鍵、佔用狀態整理
src/layer/    IndoorLayer：THREE.Group ＋ 狀態機。不碰 renderer／相機／DOM（不准引用 document、window）
src/overlay/  createLabelOverlay：DOM 標籤（投影、量測、碰撞＋遲滯、徽章點擊／hover、差量更新）
src/viewer/   createIndoorMap：renderer＋正交相機＋手勢＋樓層軌＋指北針＋燈光＋校園白模／GLB，建在 layer＋overlay 上
```

- 依賴方向只能 viewer → overlay → layer → data。
- `package.json` 加 `./layer` 子路徑匯出。three 必須是宿主那一份（peer dependency）；宿主本地開發用 `resolve.dedupe: ['three']`。
- 版本：0.12.0（minor，viewer API 不變）；室外上線穩定後再出 1.0。

## 座標：全生態系唯一的契約框架

- **Y-up、公尺、原點 = TWD97 (302800, 2770400)**：`x = E − 302800`、`y = 高度`、`z = −(N − 2770400)`。
- CDN 的 `planar-cm` 資料就是相對同一原點的整數公分：`x = cmX / 100`、`z = −cmY / 100`。
- 拿掉 `WORLD_ORIGIN` 重新置中（距原點不到 1 km，float32 精度足夠）。
- viewer 內部也用同一框架（正交相機的 up／heading 改成繞 Y 軸）。不准用「包一層旋轉 −90°」的捷徑。

## 樓層位置

layer 不知道「真實高度」以外的版面意義，由宿主給參數：

- `elevation(floorId)` = 樓層序 × `floorHeight` + `groundY`（1F 地板在 `groundY`，B1 為負）。
- `inplace`：每層在 `elevation`（轉場起點；樓板外框為主，房間淡）。
- `stack`：爆炸圖總覽，只列有教室的樓層（連續無教室樓層加 `skipExtra` 間距與「xF–yF 沒有教室」標記），
  層距 `stackGap` 由宿主給（viewer 依正交視角算；室外依透視自己給）。改 `stackGap` 只重排、不重建幾何。
- `floor`：手風琴版面——焦點層在 `focusY`，鄰層以 `floorGap` 間隔排上下。
  - viewer 傳 `floorGap = stackGap`、`focusY` = 現在的手風琴位置（像素一致）。
  - 室外傳 `floorGap = floorHeight`、`focusY = max(elevation, groundY)`：**地下樓層抬到地面**，宿主不切地面。

## IndoorLayer API

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
  onError?: (e: MapError) => void;
}): IndoorLayer

interface IndoorLayer {
  readonly object: THREE.Group;
  load(buildingId): Promise<void>;          // 取資料＋建幾何（常駐、隱藏），可預載；可同時載多棟
  unload(buildingId): void;
  setPresentation(p: {
    building: string | null;
    mode: 'inplace' | 'stack' | 'floor';
    floor?: string | null;                  // floor 模式必填
    stackGap?: number; skipExtra?: number;
    floorGap?: number; focusY?: number;
    animate?: boolean;
    duration?: number;                      // 預設 650 ms
    easing?: (t: number) => number;         // 預設 easeInOutCubic（現在的 stepTween）
  }): Promise<boolean>;                     // true = 落地；false = 被下一次 setPresentation 取代
  readonly presentation: Presentation;
  update(dt: number): boolean;              // 不收相機；回傳 true = 還在動
  pick(raycaster): PickResult | null;       // {kind:'room'|'space'|'floor', building, floor, key?, cls?}
  setOccupancy(o: Occupancy | null): void;  // 只改頂點色
  setHoveredFloor(floorId | null): void;    // stack 模式 hover 淡化（現在的 setStackHover）
  setHovered(key | null): void;
  setSelected(key | null): void;            // 新視覺（輪廓＋微染）；viewer 0.12 不呼叫
  setEmissive(k: number): void;             // 0..1，emissive = 顏色 × k；室外夜間讓狀態色仍讀得出來
  buildingBox(id) / floorBox(id, floorId) / roomBox(key): THREE.Box3 | null;   // 世界座標、依目前版面
  floors(id): FloorStats[];
  room(key): RoomInfo | null;
  labels(): readonly IndoorLabel[];         // {id 穩定, position 世界座標, text, role, kind, priority, opacity, key?, floor?}
  dispose(): void;
}
```

- `null → X` 且 `animate`：從 `inplace`、可見度 0 開始（現在的 `floorVisibility`）。
- 「落地」才把鄰層從填色切到外框、viewer 才恢復輸入——靠 `setPresentation` 的 Promise。
- 像素密度相關的標籤漸隱（POI declutter）與正交特有的版面計算移到 overlay／viewer。

## 材質與效能

- 材質**每層共用**（每層約 8 個：教室、走廊、垂直動線、廁所、服務、牆、樓板、邊線），不跨樓層共用（淡入淡出是每層獨立的）。
  底色白＋`vertexColors`。
- 佔用狀態寫頂點色，`setOccupancy` 只更新 attribute。
- `transparent` 會影響 shader 快取：材質建成透明、第一次 `update()` 後再切不透明，讓兩種 program 都在載入時編譯，不在飛行中卡頓。
  `depthWrite = opacity > 0.6`。
- 牆合併時以底部為 y=0 建，長高用 `mesh.scale.y`。
- 拾取：每層一個合併的扁平代理，三角形→空間索引對照。

## 分段（每段做完跑視覺基準比對，只比靜止狀態，門檻約 0.3%）

1. **Y-up 轉換**：只換座標框架與相機，不動結構。
2. **API 拆分**：layer／overlay／viewer 成形；layer 加 `node --test` 單元測試（樓層位置、總覽子集、拾取索引、頂點色）。
3. **合併幾何**：在 `src/layer/` 內部完成，API 不動。先在室外場景量手機 fps；每間教室一個 mesh 就跑得到 60 fps 的話，只做頂點色＋拾取代理。

## 不在範圍

- 宿主端的建築剖開／半透明、宿主相機模式、地面處理、佔用資料來源（map 自己做）。
