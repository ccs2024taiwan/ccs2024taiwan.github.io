# worker／D1：安裝與上線步驟

Cloudflare Workers 的 `/api/*` 與 D1 資料庫。設計依據見 `docs/系統規範.md` 第三部分。

## 檔案

| 檔案 | 用途 |
|---|---|
| `schema.sql` | D1 的資料表結構（設定庫 meta_*、資料庫 record／link、系統庫 settings／connection／audit） |
| `meta.mjs` | **設定庫的內容**：有哪些物件、欄位、關聯、選單、設定、LINE 指令。要改系統認識哪些資料，改這裡 |
| `seed.mjs` | 讀 `meta.mjs` 產生 `seed.sql`。用法：`node worker/seed.mjs` |
| `seed.sql` | 由 seed.mjs 產生，請勿手改 |
| `index.js` | Worker 程式。不認識任何業務物件，全部讀設定庫運作 |

## ⚠ 上線前必須先確認的事

**官網（ccs.ccs2024taiwan.workers.dev）在 `ccs2024taiwan` 這個 Cloudflare 帳號底下，而且是 GitHub 推送就自動部署。**

2026-11-16 踩過的坑：這台電腦的 `wrangler` 登入的是 `y1986uko@gmail.com`，建出來的 D1 與 Worker 都在錯的帳號，跟線上官網無關。而且如果把含 `d1_databases` 的 `wrangler.jsonc` 推上 GitHub，自動部署會去綁一個那個帳號不存在的資料庫，**官網可能掛掉**。

所以 `wrangler.jsonc` 在正確的 D1 建好之前，**不要加 `main` 與 `d1_databases`**。

## 正式上線步驟

1. **用正確帳號登入**（在 Claude Code 的輸入框輸入，前面加驚嘆號）：

   ```
   ! npx wrangler login
   ```

   瀏覽器會跳出授權畫面，選 **ccs2024taiwan@gmail.com**（不是 y1986uko，也不是 commiteesorority2023）。

2. 確認帳號對了：

   ```
   npx wrangler whoami
   ```

   Email 要是 ccs2024taiwan@gmail.com。

3. 建資料庫，記下回傳的 `database_id`：

   ```
   npx wrangler d1 create ccs
   ```

4. 把 `database_id` 填進 `wrangler.jsonc`，同時加上 `main` 與 assets 的 `binding`：

   ```jsonc
   {
     "name": "ccs",
     "compatibility_date": "2026-01-01",
     "main": "worker/index.js",
     "assets": {
       "directory": "./",
       "binding": "ASSETS",
       "not_found_handling": "404-page",
       "html_handling": "none"
     },
     "d1_databases": [
       { "binding": "DB", "database_name": "ccs", "database_id": "（第 3 步拿到的）" }
     ]
   }
   ```

5. 建表、灌設定：

   ```
   npx wrangler d1 execute ccs --remote --file=worker/schema.sql --yes
   node worker/seed.mjs
   npx wrangler d1 execute ccs --remote --file=worker/seed.sql --yes
   ```

6. 設同步金鑰（Apps Script 推資料進來時要帶）：

   ```
   npx wrangler secret put SYNC_KEY
   ```

7. 推上 GitHub，自動部署。驗證：

   ```
   curl https://ccs.ccs2024taiwan.workers.dev/api/health
   ```

   要看到 `{"ok":true,"service":"ccs-worker","objects":11,...}`，而且官網首頁仍然正常。

## 這一版的範圍

- `/api/health`、`/api/meta`、`/api/list`、`/api/get`：唯讀，只回傳 `privacy=public` 的欄位（官網讀取加速用）。
- `/api/sync`：Apps Script 把工作表整批推進來，要 `Authorization: Bearer <SYNC_KEY>`。
- 會員／志工／秘書處的身分驗證還沒接（下一批沿用 Apps Script 既有的 token）。
- 寫入（新增、修改、刪除）、簽核、行政中心畫面都還沒做。

## 要改系統認識哪些資料時

改 `meta.mjs` → `node worker/seed.mjs` → `npx wrangler d1 execute ccs --remote --file=worker/seed.sql --yes`。
seed 只動設定庫與尚未存在的設定值，**不會碰 record 裡的實際資料**，也不會覆蓋秘書處改過的文案。
