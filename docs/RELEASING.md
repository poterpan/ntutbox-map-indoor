# 發布

版本號照 semver。0.x 期間：修正升最後一位，新功能或 API 變動升中間一位；排課站以 `~0.9.0` 這種範圍固定。

## 一般發布（第二版起）

```bash
npm version minor        # 或 patch；會改 package.json、commit、打 tag vX.Y.Z
git push --follow-tags   # tag 推上去後 .github/workflows/publish.yml 開始跑
```

1. workflow 跑測試、確認 tag 與 `package.json` 版本一致，再用 Trusted Publishing 執行 `npm stage publish --provenance`。
   這一步只會把版本送進**待核准區**，還沒公開。
2. 到 npmjs.com → 頭像選單 → **Staged Packages**，確認版本與內容後按 **Approve**，用 passkey／2FA 驗證。
   核准後才會公開，`latest` 也才會指到新版。不對就按 Reject，版本號仍可重用。

Trusted Publisher 只給了「stage」權限（不能直接 publish、不能改 dist-tag），所以 repo 或 CI 被入侵也無法自行發版。
**核准就是對外發布，核准出去的版本號不能重用。**

## 第一次發布（只做一次）

Trusted Publishing 要在 npm 上「已存在的套件」設定，所以第一版手動發。`@ntutbox/map` 在 2026-10-05 發過 0.9.0；
改名後的 `@ntutbox/map-indoor` 是新套件，2026-10-07 從 0.11.0 再走一次這段。手動發的版本之後補推同名 tag 留紀錄，
workflow 看到版本已在 npm 上會直接跳過：

1. `npm whoami` 確認登入，`npm org ls ntutbox` 確認是 owner。
2. `npm pack --dry-run` 檢查會上傳的檔案（只該有 `src/`、`docs/DATA-FORMAT.md`、`docs/DESIGN.md`、README、LICENSE、package.json）。
3. 在自己的終端機（不是 Claude Code 的 `!`，它不能互動）執行 `npm publish --auth-type=web`，用 passkey 在瀏覽器驗證。
   npm 會先放一個 `0.0.0-stage` 佔位版本，驗證後才發布真正的版本；之後把佔位版本 deprecate。
4. 到 npmjs.com → `@ntutbox/map-indoor` → Settings → Trusted Publisher → GitHub Actions：
   - Organization or user：`poterpan`
   - Repository：`ntutbox-map-indoor`
   - Workflow filename：`publish.yml`
   - Environment：`npm`
   - Allowed actions：**都不勾**（只保留 `npm stage publish`）
5. 同一頁的 Publishing access 改成「Require two-factor authentication and disallow tokens」，之後只能從 workflow 發布。
6. GitHub repo → Settings → Environments 建立 `npm`（可加 Required reviewers，發布前要你按核准）。
