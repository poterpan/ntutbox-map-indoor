# @ntutbox/map-indoor

北科盒子（NTUT Box）的校園與室內地圖：2.5D 樓層圖、依課表的空教室著色、校園白模，以及三者之間的語意縮放。
用 three.js 寫成，不綁定任何前端框架；資料讀北科盒子每週從學校公開 GIS 整理發布的 CDN。

用在[北科排課](https://course.ntutbox.com/rooms/)的空教室頁；室外的校園地圖（map.ntutbox.com）也用它做進入大樓後的室內圖。

> 0.10 以前叫 `@ntutbox/map`（repo `ntutbox-map`），0.11 起改名，API 不變；`@ntutbox/map` 這個名字讓給室外地圖。

## 安裝

```bash
npm install @ntutbox/map-indoor three
```

three.js 是 peer dependency（`>=0.180.0`）。套件發布的是原始 ESM，由使用者的打包工具（Vite、Next.js 等）處理。

## 使用

```js
import { createIndoorMap, campusCdnSource } from '@ntutbox/map-indoor';
import '@ntutbox/map-indoor/style.css';

const source = campusCdnSource();            // https://cdn.ntutbox.com/campus/v1
const { buildings } = await source.load();   // 建物清單；引擎之後沿用同一份，不會重抓

const map = createIndoorMap(el, {
  source,
  buildings,                                  // { A3T: { name, short, entranceBearing } }；務必傳入，不傳只有內建的 3 棟備援
  occupancy,                                  // Map：'A3T/2F/201' → { status, … }，見下方
  initialBuilding: 'A3T', initialView: 'overview', // 'campus' | 'overview' | 'floor'
  getInsets: () => ({ top, right, bottom, left }),  // 宿主 UI 蓋住的範圍（px）；變了就呼叫 map.refreshInsets()
  onViewChange, onRoomSelect, onCampusFocus, onError, onLoading, onNotice,
});

map.setOccupancy(new Map([['A3T/5F/505', { status: 'free', code: '62', capacity: 50, freeUntil: '15:10' }]]));
await map.setView({ building: 'CB', view: 'floor', floor: '3F' }); // false = 被拒絕（飛行中等），之後重試
await map.selectRoom('CB/3F/322');                                  // 清單點教室 → 地圖飛過去並選取
map.enterBuilding('AM'); map.resetView(); map.clearSelection(); map.getView();
map.refreshInsets();  // 底部面板升起等遮擋改變後：選中的教室被蓋住就平移回可見區，否則重新取景（使用者沒移動過時）
map.destroy();  // 取消 rAF、移除所有 listener、釋放 WebGL context
```

- **引擎只負責地圖本身**：canvas、畫面內標籤、樓層列、指北針。標題、圖例、教室卡片、底部面板都由宿主依 callback 自己畫。
- **狀態由宿主推進來**：引擎不懂課表。`status` 是 `free`／`soon`／`busy`／`unknown`；換一節課只重新上色，不重建幾何。
- **教室的範圍由 `occupancy` 的鍵決定**：有鍵的空間就算教室。GIS 標成教室、但不在 `occupancy` 裡的空間顯示「無課表資料」。
- 排課站怎麼把課表算成 `occupancy`，可以參考 [`dev/course-occupancy.js`](dev/course-occupancy.js)（它不在套件裡）。
- 在 SSR 框架裡只能在瀏覽器端建立（例如 Next.js 用 `next/dynamic` 加 `ssr: false`）。import 模組本身不碰 `window`，SSR 安全。
- 資料載入失敗走 `onError`；但瀏覽器不支援 WebGL 時 `createIndoorMap` 會直接拋錯，建立時請包 `try/catch` 並顯示替代內容（例如清單）。
- 附 TypeScript 型別（`src/index.d.ts`），選項、callback 參數與回傳的 API 都有型別。
- 引擎在容器裡建立自己的 `.indoor-map` 元素並填滿容器，不改容器的 class 與樣式；宿主只要給容器一個尺寸（例如 `position: absolute; inset: 0` 或固定高度）。

### 資料來源

| | 說明 |
|---|---|
| `campusCdnSource(baseUrl?)` | 預設（不給 `source` 時就用它）。讀北科盒子發布的資料：`current.json`（快取 5 分鐘）→ manifest → 用到的那棟那層（內容不變、快取一年，每層約 2 KB）。格式見 [docs/DATA-FORMAT.md](docs/DATA-FORMAT.md) |
| 自訂物件 | 任何有 `frame`、`load()`、`floor(id, floorId)` 的物件都能當 `source`，形狀見 `src/data/sources.js` 開頭 |

CDN 只接受來自北科盒子網站的跨網域請求，並擋掉爬蟲。本機開發要走 proxy，見下方。

### 3D 建物模型（選用）

```js
import { campusModelSource } from '@ntutbox/map-indoor';
createIndoorMap(el, { source, buildings, models: campusModelSource(), onModelsLoaded, onModelsError });
```

- 校園視角裡有模型的建物改畫 Blender 模型（glTF），其餘照舊是白模；模型在背景載入，由校園中心往外，載完才替換，失敗的那棟留白模（`onModelsError`）。
- 點選、聚焦、進入大樓都沿用白模的外框（隱藏、拉到模型高度），行為與沒有模型時相同。
- 模型**不是公開資料**：放在 `models.ntutbox.com`，每個請求要帶宿主網站發的短效 token。`campusModelSource({ tokenUrl })`
  向宿主的 `tokenUrl`（預設 `/api/model-token`）拿 `{ token, expiresAt, base }`，快到期自動換、遇到 401 換一次重試。
  沒有這個端點的網站拿不到模型，地圖就維持白模。
- 需要 `frame: 'planar-cm'` 的資料來源（`campusCdnSource` 就是）；模型依 EPSG:3826 形心擺放，glTF 的 Y-up 轉成引擎的 Z-up。
- GLB 用 `KHR_mesh_quantization`，three.js 的 GLTFLoader 原生支援，不需要 WASM 解碼器。GLTFLoader 只在有給 `models` 時才動態載入。

## 狀態語意（依課表，不保證沒人）

| 顏色 | 狀態 | 規則 |
|---|---|---|
| 綠 | 這節沒排課 | 這個時段沒有排課 |
| 黃 | 60 分鐘內有課 | 這節沒排課，但下一堂課在 60 分鐘內開始 |
| 灰 | 這節有課 | 連堂會算到最後一堂結束 |
| 淡灰 | 無課表資料 | GIS 標成教室，但排課系統沒有這間 |

## 操作

- **校園**：平移、縮放、旋轉，俯仰鎖住。有室內圖的大樓放大到占畫面約 60% 時會高亮並出現小卡；放大到幾乎占滿且中心在這棟上，就飛進去。點一下是選取，再點一次進入。
- **全樓層**：可以縮放和平移，放大後能上下拖動看其他樓層。一層占畫面高度約 0.45 時，對準它繼續放大就會進入；點樓層也會直接進入。縮小到底回到校園。
- **單層**：拖曳平移、雙指縮放和旋轉（桌機用右鍵或 Shift 拖曳）。縮小到底或點空白處，回到全樓層。
- **方向**：校園北朝上；大樓以正門朝下。
- 層級切換都是不能中斷的飛行動畫。理由見 [docs/DESIGN.md](docs/DESIGN.md)。

## 開發

```bash
npm install
npm run dev     # 開發頁：http://localhost:5173/（?building=CB&view=floor&debug）
npm test        # node --test：資料來源、課表轉換、樓層排序
```

開發頁（`index.html` + `dev/`）扮演排課站的角色：節次與大樓選單、教室卡片、校園小卡。
它透過 Vite proxy 讀 CDN（`/campus-data`、`/course-data`），因為 CDN 的 CORS 不允許 localhost:5173；
連不到排課站時改用 `dev/fixtures/` 的 115-1 公開課表快照。

發布流程見 [docs/RELEASING.md](docs/RELEASING.md)。

## 授權

程式碼採 [MIT](LICENSE)。CDN 上的校園空間資料源自國立臺北科技大學公開的 GIS，權利屬於校方，由北科盒子整理後提供，**不在 MIT 授權範圍內**。
3D 建物模型是北科盒子的著作，保留所有權利，不開放下載、轉載或再利用（套件只含讀取它的程式碼，不含模型）。
