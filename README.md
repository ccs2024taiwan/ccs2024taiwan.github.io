# 寓委聯官網

全國公寓大廈管理委員聯誼會（寓委聯）官網。純靜態網站，預計放 GitHub Pages；會員驗證與表單收件由 `backend/` 的 Google Apps Script 處理。

## 檔案

- `index.html` 首頁、`about.html` 關於我們、`services.html` 服務項目、`members.html` 會員名單
- `activities.html` 活動成果（照片分五類，圖檔在 `assets/photos/`）、`join.html` 線上入會申請
- `publications.html` 出版品、`volunteer.html` 志工專區、`contact.html` 加入／聯絡
- `portal.html` 會員專區（會員編號＋手機登入；共享資源、推薦廠商查詢與推薦皆在登入後）
- `admin.html`＋`admin.js` 行政中心（不在選單；管理員登入後看志工名冊、出勤統計、工作進度與會議倒數）
- `vendors.html` 舊網址，自動轉往會員專區
- `styles.css`、`script.js` 共用樣式與互動
- `assets/` Logo（由 `寓委聯logo.ai` 轉出的透明 PNG）與可公開下載的文件
- `backend/` 後端程式與安裝說明

## 視覺規範

依《Logo 使用規範｜CIS 基礎版》：品牌紅 `#E09078`、藍綠 `#3793AB`、黃 `#F1CCA2`、深咖啡 `#3B2405`；圓潤有機色塊與手感流動線條。
Logo 只使用正式版本、等比例縮放：頁首用 ④ 小尺寸橫式（`logo-small.png`）、頁尾用 ③ 簡式橫式（`logo-horizontal.png`）、首頁主視覺與網站圖示用 ② 圖像標誌（`logo-mark.png`）。

## 本機預覽

直接用瀏覽器開 `index.html`，或執行 `npx http-server` 後開 `http://localhost:8080`。

## 上線前注意

- **`雲端資料素材/` 絕對不可上傳**：內含會員個資、簽名、印章、銀行對帳單。已列入 `.gitignore`，上傳前仍請再確認一次。
- `script.js` 第一行的 `API_URL` 留空時為示範模式：只能用 `B00000` / `0912345678` 登入、表單不會真的送出。後端部署步驟見 `backend/README.md`。

## 尚未完成

- 後端尚未部署（步驟見 `backend/README.md`）。部署前 `members.html` 顯示的是 2026-09 匯入的靜態名單，部署後自動改為即時名單。
- 行政中心（`backend/Admin.gs`）尚未安裝；安裝後要在「設定」填入志工資料表與會議文件的網址。
- 下一步構想：志工在官網志工專區自行報名任務、查看自己的服務時數。
- 理事長聯絡手機依指示不公開，網站上只放 Email 與會址。
