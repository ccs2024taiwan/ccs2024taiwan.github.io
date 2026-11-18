// 寓委聯：設定庫的內容（物件、欄位、關聯、選單）。
// 這是「程式只讀設定表運作」的那張設定表的來源；改這裡再跑 seed.mjs 產生 SQL，不改 Worker 程式。
// 欄位型別與 privacy、lock_after 的意義見 docs/系統規範.md 第三部分。

const F = (key, label, type, more = {}) => ({ key, label, type, ...more });
const pub = { privacy: 'public' };
const mem = { privacy: 'member' };
const stf = { privacy: 'staff' };
const sec = { privacy: 'secret' };
const list = { show_in_list: 1 };
const req = { required: 1 };
const locked = { lock_after: { mode: 'locked' } };
const tracked = { lock_after: { mode: 'tracked' } };

export const objects = [
  {
    id: 'member', label: '會員', label_plural: '會員名單', icon: 'user', sort: 10,
    id_rule: '{city}{seq:5}', title_field: 'name', sync: { compute: 'allMembers' },
    acl: { list: ['member', 'volunteer', 'staff'], read: ['member', 'volunteer', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'], export: ['staff'] },
    fields: [
      F('id', '會員編號', 'sequence', { ...pub, ...list, ...locked, from: 'id', options: { rule: '{city}{seq:5}' } }),
      F('name', '姓名', 'text', { ...pub, ...list, ...req, ...tracked, from: 'name', help: '團體會員取團體名稱；官網名單依「名單公開方式」顯示或匿名' }),
      F('type', '類別', 'select', { ...pub, ...list, ...req, from: 'type', options: { items: ['個人會員', '個人會員（永久）', '團體會員', '贊助會員', '榮譽會員'] } }),
      F('status', '會員狀態', 'select', { ...pub, ...list, ...req, from: 'status', options: { items: ['待審核', '待繳費', '新入會', '續會', '停權', '除籍', '榮譽'] } }),
      F('phone', '手機', 'phone', { ...sec, from: 'phone', help: '登入時比對末三碼。只有管理台看得到完整號碼，官網的公開名單與會員專區一律不回傳' }),
      F('email', 'Email', 'email', { ...stf, from: 'email' }),
      F('line_name', 'LINE 顯示名稱', 'text', { ...stf, from: 'line_name' }),
      F('community', '居住社區', 'text', { ...pub, ...list, from: 'community', help: '榮譽會員這一欄放頭銜' }),
      F('city', '社區所在地', 'text', { ...pub, from: 'city' }),
      F('address', '戶籍或聯絡地址', 'textarea', { ...sec, from: 'address' }),
      F('since', '會籍起始日', 'date', { ...mem, from: 'since', options: { roc: true } }),
      F('until', '會籍到期日', 'date', { ...mem, ...list, ...tracked, from: 'until', options: { roc: true }, help: '永久與榮譽會員留空' }),
      F('listing', '名單公開方式', 'select', { ...stf, from: 'listing', options: { items: ['公開', '匿名'] } }),
      F('note', '審核意見', 'textarea', { ...stf, lock_after: { mode: 'append' } }),
    ],
  },
  {
    // 官網「會員名單」頁用的公開名單。內容由 Apps Script 的 publicMembers() 算好推上來
    // （含公告對照的改名、匿名、榮譽會員與入會順序），這裡只負責存與讀。
    id: 'public_member', label: '公開會員名單', icon: 'user', sort: 11,
    title_field: 'name', sync: { compute: 'publicMembers' },
    acl: { list: ['guest'], read: ['guest'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('type', '類別', 'text', { ...pub, ...list, from: 'type' }),
      F('member_id', '會員編號', 'text', { ...pub, ...list, from: 'id' }),
      F('name', '姓名', 'text', { ...pub, ...list, from: 'name' }),
      F('community', '社區', 'text', { ...pub, ...list, from: 'community' }),
    ],
  },
  {
    id: 'dues', label: '會費繳納', icon: 'coin', sort: 20,
    id_rule: 'D{member}{roc}{plan}', title_field: 'member_name', source: 'sheet:會費繳納紀錄',
    acl: { list: ['staff'], read: ['member', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('id', '單號', 'sequence', { ...stf, ...list, ...locked }),
      F('member_id', '會員編號', 'text', { ...stf, ...list, ...req, ...locked }),
      F('member_name', '姓名', 'text', { ...stf, ...list }),
      F('year', '繳費年度', 'number', { ...stf, ...list, ...req, ...locked, options: { roc: true } }),
      F('plan', '方案', 'select', { ...stf, ...list, ...req, options: { items: ['常年會費', '永久會員'] } }),
      F('amount', '金額', 'money', { ...stf, ...list, ...req, ...locked }),
      F('last5', '匯款後五碼', 'text', stf),
      F('status', '狀態', 'select', { ...stf, ...list, options: { items: ['已回報', '已入帳'] } }),
      F('paid_at', '確認日期', 'date', { ...stf, ...locked }),
      F('note', '備註', 'text', stf),
    ],
  },
  {
    id: 'order', label: '訂單', icon: 'shop', sort: 30,
    id_rule: 'B{yyMMdd}{seq:3}', title_field: 'name', source: 'sheet:書籍訂單',
    acl: { list: ['staff'], read: ['staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('id', '訂單編號', 'sequence', { ...stf, ...list, ...locked }),
      F('created', '訂購時間', 'datetime', { ...stf, ...locked }),
      F('status', '狀態', 'select', { ...stf, ...list, options: { items: ['待付款', '已回報匯款', '已付款', '已備貨', '已出貨', '已面交', '取消'] } }),
      F('name', '姓名', 'text', { ...stf, ...list, ...req }),
      F('phone', '手機', 'phone', { ...sec, help: '出貨與聯絡用；官網不回傳' }),
      F('email', 'Email', 'email', stf),
      F('buyer_type', '身分', 'select', { ...stf, ...list, options: { items: ['一般', '會員'] } }),
      F('member_id', '會員編號', 'text', stf),
      F('volunteer', '志工', 'text', { ...stf, ...list, help: '勾「我是本會志工」並驗證通過才有' }),
      F('discount', '折扣', 'money', { ...stf, ...locked, help: '志工購書折扣總額（2026-11 起取代推廣補貼）' }),
      F('quantity', '數量', 'number', { ...stf, ...list, ...req, ...locked }),
      F('unit', '單價', 'money', { ...stf, ...locked }),
      F('shipping_fee', '運費', 'money', { ...stf, ...locked }),
      F('total', '總金額', 'money', { ...stf, ...list, ...locked }),
      F('shipping', '寄送方式', 'select', { ...stf, ...list, options: { items: ['郵局寄送', '7-11 店到店', '面交（臺中市西屯區國安國小附近）'] } }),
      F('address', '地址', 'textarea', { ...sec, help: '寄送地址；官網不回傳' }),
      F('store', '7-11門市', 'text', stf),
      F('receipt_title', '收據抬頭', 'text', stf),
      F('note', '備註', 'textarea', stf),
    ],
  },
  {
    id: 'event', label: '課程活動', icon: 'cal', sort: 40,
    id_rule: '{code}', title_field: 'title', source: 'sheet:課程活動', sync: { sheet: '課程活動', key: ['id', 'session'], statusField: 'status' },
    acl: { list: ['guest'], read: ['guest'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('id', '活動代號', 'text', { ...pub, ...list, ...req, from: '活動代號' }),
      F('title', '活動名稱', 'text', { ...pub, ...list, ...req, from: '活動名稱' }),
      F('session', '環節名稱', 'text', { ...pub, ...list, from: '環節名稱' }),
      F('date', '日期', 'date', { ...pub, ...list, ...req, from: '日期' }),
      F('time', '時間', 'text', { ...pub, ...list, from: '時間' }),
      F('place', '地點', 'text', { ...pub, ...list, from: '地點' }),
      F('speaker', '講師', 'text', { ...pub, from: '講師' }),
      F('seats', '名額', 'number', { ...pub, ...list, from: '名額' }),
      F('fee_member', '會員費用', 'money', { ...pub, from: '會員費用' }),
      F('fee_general', '非會員費用', 'money', { ...pub, from: '非會員費用' }),
      F('deadline', '報名截止日', 'date', { ...pub, from: '報名截止日' }),
      F('status', '狀態', 'select', { ...pub, ...list, from: '狀態', options: { items: ['草稿', '開放', '額滿', '結束', '取消'] } }),
      F('intro', '說明', 'textarea', { ...pub, from: '說明' }),
      F('notice', '注意事項', 'textarea', { ...stf, help: '行前提醒信會帶這段；沒填就不自動寄' }),
    ],
  },
  {
    // 官網「課程報名」頁用的公開活動。由 Apps Script 的 openEvents() 算好推上來（含環節、名額、已報名的名字）。
    // 剩餘名額會隨報名變動，所以前端是「先用這裡畫出來，再向 Apps Script 要權威資料更新」。
    id: 'event_open', label: '開放報名的活動', icon: 'cal', sort: 41,
    title_field: 'title', sync: { compute: 'openEventsPayload' },
    acl: { list: ['guest'], read: ['guest'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('event_id', '活動代號', 'text', { ...pub, ...list, ...req, from: 'id' }),
      F('title', '活動名稱', 'text', { ...pub, ...list, ...req, from: 'title' }),
      F('date', '日期', 'text', { ...pub, ...list, from: 'date' }),
      F('weekday', '星期', 'text', { ...pub, from: 'weekday' }),
      F('place', '地點', 'text', { ...pub, ...list, from: 'place' }),
      F('address', '地址', 'text', { ...pub, from: 'address', help: '有填就在卡片上顯示 Google 地圖連結' }),
      F('deadline', '報名截止日', 'text', { ...pub, ...list, from: 'deadline' }),
      F('sessions', '環節', 'json', { ...pub, from: 'sessions', help: '每個環節的時間、費用、名額、已報名人數' }),
    ],
  },
  {
    id: 'claim', label: '請款單', icon: 'receipt', sort: 50,
    id_rule: 'E{yyMMddHHmmss}{rand:2}', title_field: 'who', sync: { compute: 'claimsPayload', key: 'id' },
    acl: { list: ['volunteer', 'staff', 'board'], read: ['volunteer', 'staff', 'board'], create: ['volunteer'], update: ['staff', 'owner'], delete: ['admin'] },
    fields: [
      F('id', '請款單號', 'sequence', { ...stf, ...list, ...locked, from: 'id' }),
      F('who', '請款人', 'text', { ...stf, ...list, ...req, ...locked, from: 'who' }),
      F('submitted', '送出時間', 'datetime', { ...stf, ...list, ...locked, from: 'submitted' }),
      F('task', '任務名稱', 'text', { ...stf, ...list, from: 'task' }),
      F('items', '品項數', 'number', { ...stf, ...list, from: 'items' }),
      F('total', '金額', 'money', { ...stf, ...list, from: 'total', lock_after: { status: ['已審核', '已撥款'], mode: 'locked' } }),
      F('status', '狀態', 'select', { ...stf, ...list, from: 'status', options: { items: ['待審核', '已審核', '已撥款', '退回', '部分退回'] } }),
      F('method', '付款方式', 'text', { ...stf, from: 'method' }),
      F('batch', '付款批號', 'text', { ...stf, ...locked, from: 'batch' }),
      F('paid_at', '撥款日期', 'date', { ...stf, from: 'paid_at', lock_after: { status: ['已撥款'], mode: 'locked' } }),
      F('note', '說明', 'textarea', { ...stf, from: 'note' }),
    ],
  },
  {
    // 請款品項：「志工請款紀錄」一列就是一個品項，用「請款單號＋品項序」當鍵
    id: 'claim_item', label: '請款品項', icon: 'rows', sort: 51,
    title_field: 'name', sync: { sheet: '志工請款紀錄', key: ['claim_id', 'seq'] },
    acl: { list: ['volunteer', 'staff', 'board'], read: ['volunteer', 'staff', 'board'], create: ['volunteer'], update: ['staff', 'owner'], delete: ['admin'] },
    fields: [
      F('claim_id', '請款單號', 'text', { ...stf, ...list, ...req, ...locked, from: '請款單號' }),
      F('seq', '品項序', 'text', { ...stf, ...list, from: '品項序' }),
      F('who', '志工', 'text', { ...stf, ...list, from: '志工' }),
      F('task', '任務名稱', 'text', { ...stf, ...list, from: '任務名稱' }),
      F('name', '品名／事由', 'text', { ...stf, ...list, ...req, from: '品名', lock_after: { status: ['已審核', '已撥款'], mode: 'locked' } }),
      F('spent_at', '消費日期', 'date', { ...stf, ...list, ...tracked, from: '消費日期' }),
      F('amount', '小計', 'money', { ...stf, ...list, ...req, from: '小計', lock_after: { status: ['已審核', '已撥款'], mode: 'locked' } }),
      F('voucher', '收據種類', 'text', { ...stf, from: '收據種類' }),
      F('code', '會計科目', 'text', { ...stf, ...list, from: '科目代號' }),
      F('status', '狀態', 'select', { ...stf, ...list, from: '狀態', options: { items: ['待審核', '通過', '不通過', '已審核', '已撥款', '退回'] } }),
      F('method', '付款方式', 'text', { ...stf, from: '付款方式' }),
      F('note', '說明', 'textarea', { ...stf, from: '說明' }),
      F('receipt', '收據正本', 'text', { ...stf, from: '收據正本' }),
      F('batch', '付款批號', 'text', { ...stf, from: '付款批號' }),
      F('paid_at', '撥款日期', 'date', { ...stf, from: '撥款日期' }),
    ],
  },
  {
    // 會計科目一覽：直接鏡像「科目表」
    id: 'account', label: '會計科目一覽', icon: 'book', sort: 86,
    title_field: 'name', sync: { sheet: '科目表', key: 'code' },
    acl: { list: ['staff', 'board'], read: ['staff', 'board'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('code', '科目代號', 'text', { ...stf, ...list, ...req, from: '科目代號' }),
      F('name', '科目名稱', 'text', { ...stf, ...list, ...req, from: '科目名稱' }),
      F('kind', '類別', 'text', { ...stf, ...list, from: '類別' }),
      F('note', '說明', 'textarea', { ...stf, from: '說明' }),
    ],
  },
  {
    // 志工參與紀錄：任務、會議的出席與積分
    id: 'participation', label: '參與紀錄', icon: 'check', sort: 65,
    title_field: 'who', sync: { sheet: '參與紀錄', key: ['date', 'task', 'who'] },
    acl: { list: ['staff'], read: ['staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('date', '日期', 'date', { ...stf, ...list, from: '日期' }),
      F('task', '任務名稱', 'text', { ...stf, ...list, ...req, from: '任務名稱' }),
      F('who', '志工', 'text', { ...stf, ...list, ...req, from: '志工' }),
      F('role', '角色', 'text', { ...stf, ...list, from: '角色' }),
      F('hours', '時數', 'number', { ...stf, ...list, from: '時數' }),
      F('points', '積分', 'number', { ...stf, ...list, from: '積分' }),
      F('attended', '出席', 'text', { ...stf, ...list, from: '出席' }),
      F('note', '備註', 'text', { ...stf, from: '備註' }),
    ],
  },
  {
    // 任務底下的工作項目與進度
    id: 'work', label: '工作進度', icon: 'rows', sort: 66,
    title_field: 'item', sync: { sheet: '工作進度', key: ['task', 'item'] },
    acl: { list: ['volunteer', 'staff'], read: ['volunteer', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('task', '任務名稱', 'text', { ...stf, ...list, ...req, from: '任務名稱' }),
      F('item', '工作內容', 'text', { ...stf, ...list, ...req, from: '工作內容' }),
      F('owner', '負責人', 'text', { ...stf, ...list, from: '負責人' }),
      F('due', '截止日', 'date', { ...stf, ...list, from: '截止日' }),
      F('status', '狀態', 'select', { ...stf, ...list, from: '狀態', options: { items: ['未開始', '進行中', '完成', '取消', '延宕'] } }),
      F('note', '備註', 'textarea', { ...stf, from: '備註' }),
    ],
  },
  {
    // 活動建檔（過往成果的來源）
    id: 'archive', label: '活動建檔', icon: 'doc', sort: 96,
    title_field: 'title', sync: { sheet: '活動建檔', key: 'id' },
    acl: { list: ['volunteer', 'staff'], read: ['volunteer', 'staff'], create: ['volunteer'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('id', '建檔編號', 'text', { ...stf, ...list, ...req, ...locked, from: '建檔編號' }),
      F('task', '任務名稱', 'text', { ...stf, ...list, from: '任務名稱' }),
      F('title', '活動名稱', 'text', { ...stf, ...list, ...req, from: '活動名稱' }),
      F('type', '類型', 'text', { ...stf, ...list, from: '類型' }),
      F('date', '日期', 'date', { ...stf, ...list, from: '日期' }),
      F('place', '地點', 'text', { ...stf, from: '地點' }),
      F('attended', '實到人數', 'number', { ...stf, ...list, from: '實到人數' }),
      F('status', '狀態', 'select', { ...stf, ...list, from: '狀態', options: { items: ['草稿', '已送交', '退回', '已結案'] } }),
      F('report', '報告連結', 'url', { ...stf, from: '報告連結' }),
      F('folder', '資料夾連結', 'url', { ...stf, from: '資料夾連結' }),
    ],
  },
  {
    // 廠商資料（會員專區查詢用的那份）
    id: 'vendor', label: '廠商資料', icon: 'shop', sort: 92,
    title_field: 'name', sync: { sheet: '推薦廠商', key: ['name', 'category'] },
    acl: { list: ['member', 'volunteer', 'staff'], read: ['member', 'volunteer', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('name', '廠商名稱', 'text', { ...mem, ...list, ...req, from: '廠商名稱' }),
      F('category', '類別', 'text', { ...mem, ...list, from: '類別' }),
      F('contact', '聯絡方式', 'text', { ...mem, ...list, from: '聯絡方式' }),
      F('rating', '評等', 'text', { ...mem, ...list, from: '評等' }),
      F('who', '推薦人', 'text', { ...mem, from: '推薦人' }),
      F('note', '說明', 'textarea', { ...mem, from: '說明' }),
      F('status', '狀態', 'text', { ...stf, ...list, from: '狀態' }),
    ],
  },
  {
    id: 'asset', label: '器材', icon: 'mic', sort: 60,
    title_field: 'name', source: 'sheet:協會資產控管表',
    acl: { list: ['member', 'volunteer', 'staff'], read: ['member', 'volunteer', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('name', '名稱', 'text', { ...pub, ...list, ...req }),
      F('quantity', '數量', 'number', { ...pub, ...list }),
      F('lendable', '可出借', 'boolean', { ...pub, ...list, help: '會員能不能借' }),
      F('on_site', '上官網', 'boolean', { ...pub, ...list, help: '會員在官網看不看得到；與「可出借」分開' }),
      F('booking', '預約制', 'boolean', { ...pub, help: '線上會議室這類走時段預約，不是數量借用' }),
      F('holder', '保管人／所在位置', 'text', { ...stf, ...list }),
      F('status', '狀態', 'select', { ...stf, ...list, options: { items: ['在庫', '借出', '維修', '報廢', '遺失'] } }),
      F('note', '備註', 'text', stf),
    ],
  },
  {
    id: 'venue', label: '場地', icon: 'home', sort: 61,
    // 2026-11-18 搬到 D1：正本從此在這裡，不再同步試算表（試算表那張已改名「（舊）」）
    id_rule: 'V{seq:3}', title_field: 'name', source: 'd1',
    acl: { list: ['member', 'volunteer', 'staff'], read: ['member', 'volunteer', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('id', '編號', 'sequence', { ...stf, ...locked }),
      F('provider', '提供者', 'text', { ...pub, ...list, ...req, help: '社區／公司／團體名稱' }),
      F('name', '場地名稱', 'text', { ...pub, ...list, ...req }),
      F('capacity', '可容納人數', 'number', { ...pub, ...list }),
      F('hours', '可借用時段', 'text', { ...pub, ...list, help: '例 09:00-19:00' }),
      F('fee_points', '點數收費', 'text', { ...mem, help: '例 200點/1小時；0＝免收' }),
      F('fee_cash', '現金收費', 'text', { ...mem, ...list, help: '例 200元/1小時；0＝免收' }),
      F('facilities', '設備', 'multiselect', { ...pub, options: { items: ['有投影機及布幕', '有螢幕顯示設備 (有HDMI孔)', '有麥克風', '有USB播放設備', '有光碟播放設備', '有黑板／白板等大版面可書寫設備', '有牆面鏡', '有隔音裝潢', '獨立空間 (玻璃門窗)', '半開放式空間', '簡易廚房+宴客大圓桌', '有玻璃杯跟餐具可以借用'] } }),
      F('open_level', '開放層級', 'select', { ...pub, ...list, ...req, options: { items: ['一・僅理監事志工', '二・協會內部不可營利', '三・可作講座場地', '四・成員與非成員不可營利', '五・成員與非成員可營利'] }, help: '決定誰借得到、能不能收費' }),
      F('note', '備註', 'textarea', mem),
    ],
  },
  {
    id: 'volunteer', label: '志工', icon: 'user', sort: 62,
    title_field: 'nickname', sync: { compute: 'volunteers', key: 'nickname' },
    acl: { list: ['staff'], read: ['staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('code', '志工編號', 'text', { ...stf, ...list, from: 'code' }),
      F('nickname', '綽號', 'text', { ...stf, ...list, ...req, from: 'nickname' }),
      F('name', '本名', 'text', { ...stf, ...list, from: 'name' }),
      F('status', '狀態', 'select', { ...stf, ...list, from: 'status', options: { items: ['待確認', '在職', '暫停', '退出', '未錄取', '取消'] } }),
      F('joined', '加入日期', 'date', { ...stf, ...list, from: 'joined' }),
      F('skills', '專長', 'text', { ...stf, from: 'skills' }),
      F('email', 'Email', 'email', { ...stf, from: 'email' }),
      F('phone', '手機', 'phone', { ...sec, from: 'phone', help: '登入時比對末三碼。只有管理台看得到' }),
      F('line', 'LINE ID', 'text', { ...stf, from: 'line' }),
      F('member_id', '會員編號', 'text', { ...stf, ...list, from: 'memberId', help: '同一個人同時是會員與志工時，用這一欄把兩張卡接起來' }),
      F('note', '備註', 'textarea', { ...stf, from: 'note' }),
    ],
  },
  {
    id: 'task', label: '任務', icon: 'check', sort: 63,
    title_field: 'name', sync: { sheet: '任務', key: 'name' },
    acl: { list: ['volunteer', 'staff'], read: ['volunteer', 'staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('name', '任務名稱', 'text', { ...stf, ...list, ...req, from: '任務名稱' }),
      F('type', '類型', 'text', { ...stf, ...list, from: '類型' }),
      F('start', '開始日期', 'date', { ...stf, ...list, from: '開始日期' }),
      F('end', '結束日期', 'date', { ...stf, ...list, from: '結束日期' }),
      F('lead', '召集人', 'text', { ...stf, ...list, from: '召集人' }),
      F('status', '狀態', 'select', { ...stf, ...list, from: '狀態', options: { items: ['籌備中', '招募中', '進行中', '完成', '取消'] } }),
      F('need', '所需人數', 'number', { ...stf, from: '所需人數' }),
      F('points', '積分', 'text', { ...stf, from: '積分' }),
      F('reward', '回饋', 'text', { ...stf, from: '回饋' }),
      F('intro', '說明', 'textarea', { ...stf, from: '說明' }),
    ],
  },
  {
    id: 'meeting', label: '會議', icon: 'cal', sort: 64,
    title_field: 'name', sync: { sheet: '會議', key: ['name', 'date'] },
    acl: { list: ['staff'], read: ['staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('name', '會議名稱', 'text', { ...stf, ...list, ...req, from: '會議名稱' }),
      F('type', '類型', 'text', { ...stf, ...list, from: '類型' }),
      F('date', '日期', 'date', { ...stf, ...list, from: '日期' }),
      F('time', '時間', 'text', { ...stf, ...list, from: '時間' }),
      F('place', '地點', 'text', { ...stf, ...list, from: '地點' }),
      F('invited', '通知對象', 'text', { ...stf, from: '通知對象' }),
      F('status', '狀態', 'text', { ...stf, ...list, from: '狀態' }),
      F('doc', '會議文件', 'url', { ...stf, from: '會議文件' }),
      F('notified', '通知寄出日', 'date', { ...stf, from: '通知寄出日' }),
      F('note', '備註', 'textarea', { ...stf, from: '備註' }),
    ],
  },
  {
    // 外部提案：聯絡我們、社區坐一坐申請等，由 Apps Script 併成一份推上來
    id: 'proposal', label: '外部提案', icon: 'doc', sort: 95,
    title_field: 'who', sync: { compute: 'proposalsPayload', key: ['src', 'row'] },
    acl: { list: ['staff'], read: ['staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('kind', '類型', 'select', { ...stf, ...list, from: 'kind', options: { items: ['聯絡我們', '社區坐一坐', '活動協辦', '場地提供', '廠商自薦'] } }),
      F('at', '來信時間', 'datetime', { ...stf, ...list, from: 'at' }),
      F('who', '提案人', 'text', { ...stf, ...list, from: 'who' }),
      F('contact', '聯絡方式', 'text', { ...stf, ...list, from: 'contact' }),
      F('content', '內容', 'textarea', { ...stf, from: 'content' }),
      F('status', '狀態', 'select', { ...stf, ...list, from: 'status', options: { items: ['待回覆', '已回覆', '不處理'] } }),
      F('reply', '回覆紀錄', 'textarea', { ...stf, from: 'reply', lock_after: { mode: 'append' } }),
      // 這兩欄是給系統找回試算表那一列用的，管理台不列出來
      F('src', '來源表單', 'text', { ...stf, from: 'src' }),
      F('row', '表單列號', 'number', { ...stf, from: 'row' }),
    ],
  },
  {
    // 2026-11-18 搬到 D1：正本在這裡，試算表那張已改名「（舊）」
    id: 'prospect', label: '潛在會員', icon: 'user', sort: 70,
    title_field: 'name', source: 'd1',
    acl: { list: ['staff'], read: ['staff'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('name', '姓名', 'text', { ...stf, ...list, required: 1 }),
      F('phone', '電話', 'phone', { ...sec, ...list, help: '聯絡用；官網不回傳' }),
      F('email', 'Email', 'email', { ...stf, ...list }),
      F('line_name', 'LINE 名稱', 'text', { ...stf }),
      F('community', '社區', 'text', { ...stf, ...list }),
      F('status', '狀態', 'select', { ...stf, ...list, options: { items: ['待聯絡', '已聯絡', '已入會', '沒興趣', '不再聯絡'] } }),
      // 以下是互動紀錄：這個人從哪裡來、談過什麼、最後一次接觸
      F('source', '來源', 'textarea', { ...stf, ...list, help: '從哪一個活動或名單來的，可以有很多個，用「；」隔開。' }),
      F('intent', '意向／需求', 'textarea', { ...stf }),
      F('note', '備註', 'textarea', { ...stf }),
      F('created', '建立時間', 'date', { ...stf }),
      F('last_touch', '最後互動', 'date', { ...stf, ...list }),
      F('opt_out', '已取消訂閱', 'boolean', { ...stf }),
    ],
  },
  {
    id: 'journal', label: '日記帳', icon: 'book', sort: 80,
    title_field: 'summary', sync: { sheet: '日記帳', key: ['date', 'no', 'summary'] },
    acl: { list: ['staff', 'board'], read: ['staff', 'board'], create: ['staff'], update: ['staff'], delete: ['admin'] },
    fields: [
      F('date', '日期', 'date', { ...stf, ...list, ...req, from: '日期', lock_after: { mode: 'reverse_only' } }),
      F('source', '來源', 'text', { ...stf, from: '來源' }),
      F('no', '單號', 'text', { ...stf, ...locked, from: '單號' }),
      F('summary', '摘要', 'text', { ...stf, ...list, ...req, from: '摘要' }),
      F('code', '科目代號', 'text', { ...stf, ...list, ...req, from: '科目代號', lock_after: { mode: 'reverse_only' } }),
      F('code_name', '科目名稱', 'text', { ...stf, from: '科目名稱' }),
      F('income', '收入', 'money', { ...stf, ...list, from: '收入', lock_after: { mode: 'reverse_only' } }),
      F('expense', '支出', 'money', { ...stf, ...list, from: '支出', lock_after: { mode: 'reverse_only' } }),
      F('target', '對象', 'text', { ...stf, from: '對象' }),
      F('task', '任務／活動', 'text', { ...stf, ...list, from: '任務／活動' }),
      F('method', '付款方式', 'text', { ...stf, from: '付款方式' }),
      F('bank_row', '銀行列號', 'text', { ...stf, from: '銀行列號' }),
      F('batch', '付款批號', 'text', { ...stf, from: '付款批號' }),
      F('note', '備註', 'text', { ...stf, from: '備註' }),
    ],
  },
  {
    // 經典討論串。內容由 Apps Script 的 forumPayload() 算好推上來（含依最新暱稱重算的留言）。
    // guestLimit：沒登入只看得到前 3 則，其餘要加入會員 —— 這是「限制筆數」不是「隱藏欄位」，
    // 所以欄位都是 public，由 acl.guestLimit 控制訪客拿得到幾列。
    id: 'thread', label: '經典討論串', icon: 'doc', sort: 90,
    title_field: 'title', sync: { compute: 'forumPayload' },
    acl: { list: ['guest'], read: ['guest'], create: ['staff'], update: ['staff'], delete: ['admin'], guestLimit: 3 },
    fields: [
      F('topic_id', '代號', 'text', { ...pub, ...locked, from: 'id' }),
      F('title', '標題', 'text', { ...pub, ...list, ...req, from: 'title' }),
      F('category', '分類', 'text', { ...pub, ...list, from: 'category' }),
      F('date', '日期', 'text', { ...pub, ...list, from: 'date' }),
      F('question', '問題', 'textarea', { ...pub, from: 'question' }),
      F('views', '觀點', 'json', { ...pub, from: 'views' }),
      F('takeaway', '結論', 'textarea', { ...pub, from: 'takeaway' }),
      F('caveat', '注意', 'textarea', { ...pub, from: 'caveat' }),
      F('quote', '金句', 'text', { ...pub, from: 'quote' }),
      F('replies', '留言', 'json', { ...pub, from: 'replies', help: '依最新暱稱重算；下架的留言不會推上來' }),
    ],
  },
];

// 關聯。match 是「用哪個欄位的值對上」，section 是在主檔明細裡顯示的段落標題。
// 有 section 的關聯，點開一筆主檔時會自動把相關紀錄帶出來（見 Worker 的 /api/related）。
export const relations = [
  // 任務：點開一個任務，底下帶出工作進度、參與者、請款、建檔
  { id: 'task_work', label: '工作進度', from_object: 'task', to_object: 'work', kind: 'one_to_many', on_delete: 'cascade', embed: 'child', section: '工作進度', match: { from: 'name', to: 'task' } },
  { id: 'task_participation', label: '參與者', from_object: 'task', to_object: 'participation', kind: 'one_to_many', on_delete: 'cascade', embed: 'child', section: '參與者與積分', match: { from: 'name', to: 'task' } },
  { id: 'task_claim', label: '請款', from_object: 'task', to_object: 'claim_item', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '相關請款', match: { from: 'name', to: 'task' } },
  { id: 'task_archive', label: '活動建檔', from_object: 'task', to_object: 'archive', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '活動建檔', match: { from: 'name', to: 'task' } },
  { id: 'task_journal', label: '帳務', from_object: 'task', to_object: 'journal', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '帳務', match: { from: 'name', to: 'task' } },

  // 會議：點開一場會議，帶出出席紀錄與花費
  { id: 'meeting_participation', label: '出席', from_object: 'meeting', to_object: 'participation', kind: 'one_to_many', on_delete: 'cascade', embed: 'child', section: '出席紀錄', match: { from: 'name', to: 'task' } },
  { id: 'meeting_journal', label: '花費', from_object: 'meeting', to_object: 'journal', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '花費', match: { from: 'name', to: 'task' } },

  // 請款單：底下的品項（子表）
  { id: 'claim_item', label: '品項', from_object: 'claim', to_object: 'claim_item', kind: 'one_to_many', on_delete: 'cascade', embed: 'child', section: '品項明細', match: { from: 'id', to: 'claim_id' } },

  // 會員：點開一位會員，帶出會費、訂單、報名、留言（會員 360）
  { id: 'member_dues', label: '會費紀錄', from_object: 'member', to_object: 'dues', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '會費紀錄', match: { from: 'id', to: 'member_id' } },
  { id: 'member_order', label: '購買紀錄', from_object: 'member', to_object: 'order', kind: 'one_to_many', on_delete: 'set_null', embed: 'ref', section: '購買紀錄', match: { from: 'id', to: 'member_id' } },

  // 志工：點開一位志工，帶出參與紀錄與請款
  { id: 'volunteer_participation', label: '參與紀錄', from_object: 'volunteer', to_object: 'participation', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '參與紀錄與積分', match: { from: 'nickname', to: 'who' } },
  { id: 'volunteer_claim', label: '請款紀錄', from_object: 'volunteer', to_object: 'claim', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '請款紀錄', match: { from: 'nickname', to: 'who' } },
  { id: 'volunteer_work', label: '負責的工作', from_object: 'volunteer', to_object: 'work', kind: 'one_to_many', on_delete: 'restrict', embed: 'ref', section: '負責的工作', match: { from: 'nickname', to: 'owner' } },

  // 課程活動：點開一場活動，帶出各環節
  { id: 'event_session', label: '環節', from_object: 'event', to_object: 'event', kind: 'one_to_many', on_delete: 'cascade', embed: 'child', display: { note: '同一個活動代號的多個環節' } },
];
export const menus = [
  // 管理台左欄。依「秘書處的工作」分組，不是依「官網有哪些頁」分組。
  // 沒列在這裡的物件不會出現在左欄（例如公開會員名單、開放報名的活動、請款品項，
  // 那些是系統為了給官網用而算出來的中繼資料，不是行政工作項目）。
  // 主項目＝左欄的項目（照 ERP+CRM.xlsx 的分類）；子項目收在主項目裡面，
  // 不另外佔左欄的位置。例如「工作進度」是點開某個任務之後才出現的段落。
  { id: 'adm_dash', area: 'admin', label: '儀表板', icon: 'home', kind: 'page', target: 'dashboard', sort: 10, roles: ['staff', 'admin', 'board'] },
  { id: 'adm_approve', area: 'admin', label: '申請審核', icon: 'check', kind: 'page', target: 'approvals', sort: 11 },
  { id: 'adm_member', area: 'admin', label: '會員', icon: 'user', kind: 'object', target: 'member', sort: 20 },
  { id: 'adm_prospect', area: 'admin', label: '潛在會員', icon: 'user', kind: 'object', target: 'prospect', sort: 21 },
  { id: 'adm_volunteer', area: 'admin', label: '志工', icon: 'user', kind: 'object', target: 'volunteer', sort: 22 },
  { id: 'adm_order', area: 'admin', label: '書籍訂購', icon: 'shop', kind: 'object', target: 'order', sort: 23 },
  { id: 'adm_event', area: 'admin', label: '課程活動', icon: 'cal', kind: 'object', target: 'event', sort: 24 },
  { id: 'adm_task', area: 'admin', label: '任務', icon: 'check', kind: 'object', target: 'task', sort: 25 },
  { id: 'adm_meeting', area: 'admin', label: '會議', icon: 'cal', kind: 'object', target: 'meeting', sort: 26 },
  { id: 'adm_asset', area: 'admin', label: '器材', icon: 'mic', kind: 'object', target: 'asset', sort: 27 },
  { id: 'adm_proposal', area: 'admin', label: '外部提案', icon: 'doc', kind: 'object', target: 'proposal', sort: 28 },

  // 資料管理：四個子項目收在裡面
  { id: 'g_lib', area: 'admin', label: '資料', icon: 'db', kind: 'group', sort: 30 },
  { id: 'lib_shared', area: 'admin', parent_id: 'g_lib', label: '經營管理資料', icon: 'doc', kind: 'page', target: 'soon:經營管理資料:會員共享資料夾裡的表單、公告範本、課程簡報。在這裡管理上下架與分類，官網會員專區直接讀。', sort: 31 },
  { id: 'lib_community', area: 'admin', parent_id: 'g_lib', label: '社區資料', icon: 'home', kind: 'page', target: 'soon:社區資料:各社區的戶數、管理費、物業與廠商配合情形（來自「社區委員會聯誼交流群組分享資料」113 筆）。含各社區敏感資訊，上線前要先決定誰看得到。', sort: 32 },
  { id: 'lib_vendor', area: 'admin', parent_id: 'g_lib', label: '廠商資料', icon: 'shop', kind: 'object', target: 'vendor', sort: 33 },
  { id: 'lib_results', area: 'admin', parent_id: 'g_lib', label: '過往成果', icon: 'doc', kind: 'object', target: 'archive', sort: 34 },

  // 財務管理：十個子項目收在裡面
  { id: 'g_money', area: 'admin', label: '財務', icon: 'book', kind: 'group', sort: 40, roles: ['staff', 'admin', 'board'] },
  { id: 'fin_claim', area: 'admin', parent_id: 'g_money', label: '志工請款', icon: 'receipt', kind: 'object', target: 'claim', sort: 41, roles: ['staff', 'admin', 'board'] },
  { id: 'fin_expense', area: 'admin', parent_id: 'g_money', label: '支出登錄', icon: 'receipt', kind: 'page', target: 'soon:支出登錄:本會帳戶直接付出去的錢（網銀轉帳廠商、自動扣繳、秘書薪資）在這裡登錄，寫進日記帳。志工或秘書長先墊的錢走「志工請款」—— 以「錢從誰口袋出」區分。', sort: 42 },
  { id: 'fin_forms', area: 'admin', parent_id: 'g_money', label: '表單管理', icon: 'doc', kind: 'page', target: 'soon:表單管理:支出證明單、講師費領據、印領清冊、補助金領據。之後會由系統帶入資料後直接產生，不用手填。', sort: 43 },
  { id: 'fin_income', area: 'admin', parent_id: 'g_money', label: '收入登錄', icon: 'coin', kind: 'page', target: 'soon:收入登錄:官網來的訂單、報名、會費會自動入帳；贊助、補助、捐款在這裡手動登錄，寫進日記帳並登記收據編號。', sort: 44 },
  { id: 'fin_journal', area: 'admin', parent_id: 'g_money', label: '日記帳', icon: 'book', kind: 'object', target: 'journal', sort: 45, roles: ['staff', 'admin', 'board'] },
  { id: 'fin_statement', area: 'admin', parent_id: 'g_money', label: '收支表', icon: 'book', kind: 'page', target: 'soon:收支表:依月／年彙總的收支，含預算執行率。目前在試算表用公式算，之後搬到這裡。', sort: 46 },
  { id: 'fin_pl', area: 'admin', parent_id: 'g_money', label: '年度結餘表', icon: 'book', kind: 'page', target: 'soon:年度結餘表:本會是現金收支制，所以不做損益表，改做年度收支結餘。待預算表建好後一起做。', sort: 47 },
  { id: 'fin_cash', area: 'admin', parent_id: 'g_money', label: '現金收支餘額表', icon: 'book', kind: 'page', target: 'soon:現金收支餘額表:取代資產負債表（現金收支制不適用）。列出各帳戶期初、收入、支出、期末。', sort: 48 },
  { id: 'fin_account', area: 'admin', parent_id: 'g_money', label: '會計科目一覽', icon: 'book', kind: 'object', target: 'account', sort: 49, roles: ['staff', 'admin', 'board'] },
  { id: 'fin_budget', area: 'admin', parent_id: 'g_money', label: '會計科目預算表', icon: 'book', kind: 'page', target: 'soon:會計科目預算表:年度預算（會員大會決議後由秘書長輸入），與實際支出對照顯示執行率，超支提醒。來源是「寓委聯115年度計畫甘特圖與預算表」。', sort: 50 },

  // LINE 小幫手：兩個子項目
  { id: 'g_line', area: 'admin', label: 'LINE 小幫手', icon: 'menu', kind: 'group', sort: 55 },
  { id: 'line_cmd', area: 'admin', parent_id: 'g_line', label: '功能一覽', icon: 'rows', kind: 'page', target: 'soon:LINE 功能一覽:每個指令的觸發詞、回應文案、適用範圍與開關。測試期間可以單獨關掉某個指令，不用停整個機器人。資料表已經在設定庫裡（line_command）。', sort: 56 },
  { id: 'line_auto', area: 'admin', parent_id: 'g_line', label: '自動回應', icon: 'doc', kind: 'page', target: 'soon:自動回應:關鍵字自動回覆的文案設定，改文字不用改程式。', sort: 57 },

  { id: 'g_sys', area: 'admin', label: '系統', icon: 'gear', kind: 'group', sort: 60 },
  { id: 'adm_setup', area: 'admin', parent_id: 'g_sys', label: '系統設定', icon: 'cube', kind: 'page', target: 'setup', sort: 61, roles: ['staff', 'admin'] },
  { id: 'adm_sync', area: 'admin', parent_id: 'g_sys', label: '同步狀態', icon: 'db', kind: 'page', target: 'sync', sort: 62, roles: ['staff', 'admin'] },
  { id: 'adm_conn', area: 'admin', parent_id: 'g_sys', label: '連線', icon: 'plug', kind: 'page', target: 'connections', sort: 63, roles: ['staff', 'admin'] },
  { id: 'adm_permit', area: 'admin', parent_id: 'g_sys', label: '權限', icon: 'user', kind: 'page', target: 'permits', sort: 63, roles: ['admin'] },
  { id: 'adm_audit', area: 'admin', parent_id: 'g_sys', label: '留痕', icon: 'clock', kind: 'page', target: 'audit', sort: 64, roles: ['staff', 'admin'] },
  // 官網頂部（對照現況）
  { id: 'site_about', area: 'site', label: '關於本會', kind: 'page', target: 'about.html', sort: 10 },
  { id: 'site_activities', area: 'site', label: '活動成果', kind: 'page', target: 'activities.html', sort: 20 },
  { id: 'site_services', area: 'site', label: '服務項目', kind: 'page', target: 'services.html', sort: 30 },
  { id: 'site_events', area: 'site', label: '課程報名', kind: 'page', target: 'events.html', sort: 40 },
  { id: 'site_publications', area: 'site', label: '出版與製作', kind: 'page', target: 'publications.html', sort: 50 },
  { id: 'site_join', area: 'site', label: '加入我們', kind: 'page', target: 'join.html', sort: 60 },
  // 會員專區
  { id: 'portal_membership', area: 'portal', label: '我的會籍', icon: 'user', kind: 'view', target: 'member:me', sort: 10, roles: ['member'] },
  { id: 'portal_dues', area: 'portal', label: '續會繳費', icon: 'coin', kind: 'action', target: 'dues_pay', sort: 20, roles: ['member'] },
  { id: 'portal_resources', area: 'portal', label: '會員共享資料下載', icon: 'doc', kind: 'page', target: 'shared', sort: 30, roles: ['member'] },
  { id: 'portal_vendors', area: 'portal', label: '廠商資料庫查詢', icon: 'shop', kind: 'object', target: 'vendor', sort: 40, roles: ['member'] },
  { id: 'portal_borrow', area: 'portal', label: '租借道具器材', icon: 'mic', kind: 'page', target: 'equipment.html?as=member', sort: 50, roles: ['member'] },
  { id: 'portal_forum', area: 'portal', label: '經典討論串', icon: 'doc', kind: 'page', target: 'forum.html', sort: 60, roles: ['member'] },
];

export const settings = [
  { key: '信件簽名', group: '通知', type: 'textarea', help: '所有寄給會員／志工／客人的信，結尾自動接上這段。寄給秘書處自己的通知不會加。' },
  { key: '提醒收件人', group: '通知', type: 'text', help: '秘書處通知信的收件人。' },
  { key: '管理員會員編號', group: '權限與身分', type: 'text', help: '秘書長：行政中心什麼都能改。填會員編號，逗號分隔。' },
  { key: '理監事會員編號', group: '權限與身分', type: 'text', help: '理監事：只看得到財務那幾頁，什麼都不能改。填會員編號，逗號分隔。' },
  { key: '潛在會員名單網址', group: '外部連結', type: 'url', help: '要匯入潛在會員的名單試算表網址。只在按「搬家：匯入潛在會員」時讀一次，不會自動同步。' },
  { key: '備份資料夾 ID', group: '一般', type: 'text', help: '每天自動把官網資料庫倒一份 JSON 存進這個雲端硬碟資料夾（只留最近 30 份）。留空就存在試算表旁邊。檔案含個資，資料夾不要分享。' },
  { key: '線上付款方式', group: '金流', type: 'json', help: '藍新開通的付款方式代碼。填了官網才會出現線上付款。' },
  { key: '簽核門檻', group: '會籍規則', type: 'number', value: '10000', help: '撥款金額超過這個數字要加理事長簽核。' },
  { key: '潛在會員保存年限', group: '一般', type: 'number', value: '3', help: '最後一次互動起算幾年；到期系統提醒，不自動刪。' },
  { key: '會費繳費截止日', group: '會籍規則', type: 'text', value: '01-31', help: '逾期次日自動標示停權。' },
];

export const lineCommands = [
  { id: 'task_list', trigger: ['#任務'], label: '任務清單', handler: 'task.list', scope: ['volunteer_group'], reply_template: '目前進行中的任務：\n{{清單}}' },
  { id: 'my_points', trigger: ['#積分', '#我的積分'], label: '我的積分與等級', handler: 'volunteer.level', scope: ['private'], reply_template: '{{綽號}} 你好：\n年資 {{年資}}、積分 {{積分}}，目前是{{等級}}。\n{{晉級提示}}' },
  { id: 'equipment', trigger: ['#器材'], label: '可借器材', handler: 'asset.list', scope: ['volunteer_group', 'private'], reply_template: '目前可借的器材：\n{{清單}}\n\n借用請到志工專區填器材申請。' },
];
