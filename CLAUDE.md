# ntutbox-map 規則

- **公開 repo。** 不放任何 GIS 原始資料或含個資的檔案（`using_member`、`property_member` 等）；資料一律從 CDN 讀（`src/data/sources.js`）。
- 套件只含引擎與資料來源（`src/`）。宿主端邏輯（例如課表轉教室狀態）放在 `dev/` 當範例，不進套件。
- 引擎不綁框架、不懂課表；狀態由宿主 `setOccupancy` 推進來，座標換算只在 `project()`。
- CDN 會擋爬蟲；自己的程式讀 CDN 時要用一般的應用程式 UA（細節在私有的部署文件，不寫在這裡）。
- 發布 = 推 `v*` tag（`docs/RELEASING.md`），是不可逆的對外動作，先問使用者。
- 資料格式的公開說明在 `docs/DATA-FORMAT.md`；格式本身由 ntutbox-campus 產生，改格式要兩邊一起改並升 `schema_version`。
