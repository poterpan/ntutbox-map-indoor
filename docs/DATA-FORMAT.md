# 校園資料格式（schema_version 1）

`campusCdnSource()` 讀的就是這份格式。資料由北科盒子從國立臺北科技大學公開的 GIS 整理，每週更新，
發布在 `https://cdn.ntutbox.com/campus/v1/`。

> 資料的權利屬於校方，不在本 repo 的 MIT 授權範圍內。CDN 只允許北科盒子自己的網站跨網域讀取，並擋掉爬蟲；
> 想在別的專案使用，請先聯絡我們。

## 怎麼讀

```
current.json  →  manifest.<hash>.json  →  buildings.<hash>.json
                                        →  indoor/<棟>/<層>.<hash>.json   （只抓用到的那幾層）
                                        →  gis-rooms.<hash>.json
```

- `current.json` 是唯一會變動的檔案，快取 5 分鐘：
  ```json
  {"manifest":"manifest.e2d982ca189c.json","published_at":"2026-10-03T21:57:14+08:00",
   "revision":1,"schema_version":1,"update_sequence":1146}
  ```
- manifest 的 `files` 把邏輯路徑對到帶雜湊的檔名（`{"indoor/A3T/2F.json": {"path": "indoor/A3T/2F.9e64….json", "sha256", "bytes"}}`）。
  內容檔不會被改寫，快取一年。
- **`schema_version` 不認得就不要解碼**，保留手上的舊資料。客戶端看到 `revision` 或 `manifest` 沒變，就什麼都不用抓。

大小（2026-10，gzip）：`buildings` 6 KB；每層中位數 2 KB、最大 11 KB；全校約 0.6 MB，但客戶端只會抓用到的部分。

## 座標

- 所有幾何都是 **EPSG:3826（TWD97／TM2）的整數公分**，相對於固定原點 `buildings.json` 的 `frame.origin`（公尺）。
- TM2 本身是平面座標：**除以 100 就是本地公尺**，全校每棟、每層都在同一個座標框裡，不用做投影運算。
- 要疊到 WGS84 地圖上，把 `(x / 100 + origin[0], y / 100 + origin[1])` 從 EPSG:3826 轉成 EPSG:4326。
- 多邊形沿用 GeoJSON 的結構（`[polygon][ring][point]`，ring 頭尾相同），只是點換成整數。

## `buildings.json`

```json
{"frame":{"crs":"EPSG:3826","origin":[302800,2770400],"unit":"cm"},
 "schema_version":1,
 "buildings":[
 {"id":"A3T","name":"第三教學大樓","short":"三教","campus":"A",
  "entrance":{"bearing":0,"verified":true},
  "floors":["B1","1F","2F","3F","4F","5F"],
  "outline":[[[[x,y],...]]]}, ...]}
```

- 全校 52 棟都有 `outline`；只有 31 棟有室內資料的才有 `floors`（由下到上排序，同 `floorRank`）。
- `entrance.bearing`：主入口在建物的哪一側（0 = 北、90 = 東）。只有人工確認過的才有；沒有這個欄位時，`campusCdnSource` 當作朝北（0）並標 `entranceConfirmed: false`。
- `aliases`、`nameEn`、`short`、`campus` 有值才出現。

## `indoor/<棟>/<層>.json`

```json
{"building":"A3T","floor":"2F","schema_version":1,
 "spaces":[{"id":"A3T/2F/201","c":"001","n":"201","t":"教室","g":[[[[x,y],...]]]}, ...]}
```

| 鍵 | 意義 |
|---|---|
| `id` | 穩定空間 ID |
| `c` | GIS 類別代碼（`001`／`002` 是教室；校方沒有公布對照表） |
| `n` | 門牌編號 |
| `t` | 名稱 |
| `te` | 英文名稱 |
| `g` | 多邊形 |

柱子、沒有名稱／編號／類別的多邊形不發布；GIS 的使用人、保管人等欄位也不發布。

**穩定空間 ID**：有門牌編號的是 `棟/層/編號`（例如 `A3T/2F/201`），同一層重複編號依序加 `#2`、`#3`；
沒有編號的是 `棟/層/~<雜湊>`，多邊形移動超過約 1 公尺或改了類別時會變，目前只是盡量穩定。

## `gis-rooms.json`

給排課資料對教室用：`buildings[]`（`building_id`、`name`、`aliases`、`floor_ids`）、
`rooms[]`（`building_id`、`floor_id`、`class_number`、`name`、`use`）。

## 引擎怎麼用

`campusCdnSource()` 把上面的格式轉成引擎讀的形狀：

| 格式 | 引擎看到的 feature properties |
|---|---|
| `n` | `classNumber` |
| `t`、`te` | `name`、`nameEn` |
| `c` | `category1` |
| `id` | `spaceId` |
| `g` | `geometry`（MultiPolygon，`source.frame = 'planar-cm'`）；面積另算成 `areaSquareMeters` |

教室狀態用 `棟/層/門牌編號` 當鍵（例如 `A3T/2F/201`），由宿主透過 `setOccupancy` 推進來。
