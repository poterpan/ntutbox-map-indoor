# 發布

版本號照 semver。0.x 期間：修正升最後一位，新功能或 API 變動升中間一位；排課站以 `~0.9.0` 這種範圍固定。

## 一般發布（第二版起）

```bash
npm version minor        # 或 patch；會改 package.json、commit、打 tag vX.Y.Z
git push --follow-tags   # tag 推上去後 .github/workflows/publish.yml 自動發布
```

workflow 會先跑測試、確認 tag 與 `package.json` 版本一致，再用 Trusted Publishing 發布（不需要 npm token，npm 會附上 provenance）。
**打 tag 就是對外發布，發出去的版本號不能重用。**

## 第一次發布（只做一次）

Trusted Publishing 要在 npm 上「已存在的套件」設定，所以第一版手動發：

1. `npm whoami` 確認登入，`npm org ls ntutbox` 確認是 owner。
2. `npm pack --dry-run` 檢查會上傳的檔案（只該有 `src/`、`docs/DATA-FORMAT.md`、`docs/DESIGN.md`、README、LICENSE、package.json）。
3. `npm publish`（`publishConfig.access` 已是 public）。2FA 會要求驗證。
4. 到 npmjs.com → `@ntutbox/map` → Settings → Trusted Publisher → GitHub Actions：
   - Organization or user：`poterpan`
   - Repository：`ntutbox-map`
   - Workflow filename：`publish.yml`
   - Environment：`npm`
5. 同一頁的 Publishing access 改成「Require two-factor authentication and disallow tokens」，之後只能從 workflow 發布。
6. GitHub repo → Settings → Environments 建立 `npm`（可加 Required reviewers，發布前要你按核准）。
