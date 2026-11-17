-- 寓委聯 D1 資料庫結構（docs/系統規範.md 第三部分）
-- 三層：設定庫 meta_* ／ 資料庫 record・link ／ 系統庫 settings・connection・audit
-- 執行：npx wrangler d1 execute ccs --remote --file=worker/schema.sql

-- ── 設定庫 ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meta_object (
  id            TEXT PRIMARY KEY,            -- 英文代號，例 member
  label         TEXT NOT NULL,               -- 顯示名稱，例 會員
  label_plural  TEXT,
  icon          TEXT,                        -- 圖示代號（行政中心的線條圖示）
  id_rule       TEXT,                        -- 編號規則，例 {city}{seq:5}；空＝ULID
  title_field   TEXT,                        -- 哪個欄位當標題
  source        TEXT NOT NULL DEFAULT 'd1',  -- d1 ／ sheet:<試算表ID>/<工作表>（過渡期鏡像）
  soft_delete   INTEGER NOT NULL DEFAULT 1,
  audit_level   TEXT NOT NULL DEFAULT 'full',
  acl           TEXT,                        -- JSON：誰能看／建／改／刪
  sort          INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active', -- active／draft／hidden／archived
  extras        TEXT,                        -- JSON：同步設定等額外資訊（sync.key 等）
  updated_at    TEXT,
  updated_by    TEXT
);

CREATE TABLE IF NOT EXISTS meta_field (
  id            TEXT PRIMARY KEY,
  object_id     TEXT NOT NULL REFERENCES meta_object(id),
  "key"         TEXT NOT NULL,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL,               -- text／number／date／select／relation／file…
  options       TEXT,                        -- JSON
  required      INTEGER NOT NULL DEFAULT 0,
  is_unique     INTEGER NOT NULL DEFAULT 0,  -- unique 是保留字，欄名加 is_
  default_value TEXT,
  validate      TEXT,
  privacy       TEXT NOT NULL DEFAULT 'staff', -- public／member／staff／secret
  lock_after    TEXT,                        -- JSON：核准後規則 {"status":[…],"mode":"locked"}
  show_in_list  INTEGER NOT NULL DEFAULT 0,
  sort          INTEGER NOT NULL DEFAULT 0,
  help          TEXT,
  UNIQUE (object_id, "key")
);
CREATE INDEX IF NOT EXISTS ix_field_obj ON meta_field (object_id, sort);

CREATE TABLE IF NOT EXISTS meta_relation (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  from_object TEXT NOT NULL REFERENCES meta_object(id),
  to_object   TEXT NOT NULL REFERENCES meta_object(id),
  kind        TEXT NOT NULL,                 -- many_to_one／one_to_many／many_to_many
  from_label  TEXT,
  to_label    TEXT,
  on_delete   TEXT NOT NULL DEFAULT 'restrict',
  required    INTEGER NOT NULL DEFAULT 0,
  embed       TEXT NOT NULL DEFAULT 'ref',   -- child（子表）／ref（獨立物件）
  match_on    TEXT,                          -- JSON：用欄位值對上，例 {"from":"name","to":"task"}（鏡像期沒有真正的外鍵）
  section     TEXT,                          -- 在主檔明細裡顯示的段落標題；空＝不顯示
  display     TEXT                           -- JSON
);

CREATE TABLE IF NOT EXISTS meta_menu (
  id        TEXT PRIMARY KEY,
  area      TEXT NOT NULL,                   -- site／portal／volunteer／admin／line
  parent_id TEXT,
  label     TEXT NOT NULL,
  icon      TEXT,
  kind      TEXT NOT NULL,                   -- page／object／view／url／action
  target    TEXT,
  roles     TEXT,                            -- JSON 陣列；空＝所有人
  badge     TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  visible   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_menu_area ON meta_menu (area, sort);

CREATE TABLE IF NOT EXISTS meta_view (
  id        TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES meta_object(id),
  label     TEXT NOT NULL,
  filter    TEXT,                            -- JSON where 條件
  columns   TEXT,                            -- JSON 欄位代號陣列
  order_by  TEXT,
  group_by  TEXT,
  roles     TEXT,
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta_action (
  id          TEXT PRIMARY KEY,
  object_id   TEXT REFERENCES meta_object(id),
  label       TEXT NOT NULL,
  icon        TEXT,
  kind        TEXT NOT NULL,                 -- status_change／notify／export／webhook／script
  target      TEXT,
  roles       TEXT,
  confirm_text TEXT,
  when_cond   TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);

-- 個別授權：某位志工（或全體志工）可以看或可以改哪一種資料。
-- 誰：志工綽號、志工編號、會員編號，或 * 代表全體志工。
-- 給到什麼：read＝看得到，write＝可以新增與修改（刪除永遠只有秘書長）。
CREATE TABLE IF NOT EXISTS permit (
  id         TEXT PRIMARY KEY,
  who        TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  level      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_permit_who ON permit (who);

CREATE TABLE IF NOT EXISTS meta_release (
  version    INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by TEXT,
  note       TEXT,
  snapshot   TEXT NOT NULL                   -- JSON：整份設定庫快照，可一鍵回復
);

-- ── 資料庫 ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS record (
  id         TEXT NOT NULL,                  -- 業務編號（依 id_rule）或 ULID
  object_id  TEXT NOT NULL,
  data       TEXT NOT NULL,                  -- JSON，鍵＝meta_field.key
  status     TEXT,
  title      TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  deleted_at TEXT,
  PRIMARY KEY (object_id, id)
);
CREATE INDEX IF NOT EXISTS ix_record_obj    ON record (object_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS ix_record_title  ON record (object_id, title);
CREATE INDEX IF NOT EXISTS ix_record_update ON record (object_id, updated_at);

CREATE TABLE IF NOT EXISTS link (
  relation_id TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  data        TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  PRIMARY KEY (relation_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS ix_link_to ON link (relation_id, to_id);

-- ── 系統庫 ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  "key"      TEXT PRIMARY KEY,
  group_name TEXT NOT NULL DEFAULT '一般',
  type       TEXT NOT NULL DEFAULT 'text',   -- text／textarea／number／boolean／select／json／template
  value      TEXT,
  help       TEXT,
  roles      TEXT,
  variables  TEXT,                           -- template：可用變數清單（JSON）
  sample     TEXT,                           -- template：預覽用的資料來源
  test_to    TEXT,                           -- template：試寄對象
  sort       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS connection (
  id          TEXT PRIMARY KEY,              -- newebpay／line_oa／telegram_bot／google／mcp
  kind        TEXT NOT NULL,                 -- payment／chat／mcp／google／webhook／custom
  label       TEXT NOT NULL,
  fields      TEXT,                          -- JSON：需要哪些值與說明
  secrets     TEXT,                          -- 以 MASTER_KEY 加密後的 JSON，畫面只顯示末四碼
  config      TEXT,                          -- JSON：非機密設定
  status      TEXT NOT NULL DEFAULT 'disabled',
  webhook_url TEXT,
  last_ok_at  TEXT,
  last_error  TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS line_command (
  id             TEXT PRIMARY KEY,
  trigger_words  TEXT NOT NULL,              -- JSON 陣列，例 ["#任務","#任務清單"]
  label          TEXT NOT NULL,
  reply_template TEXT,
  handler        TEXT,                       -- 具名流程（L2），下拉選既有的
  scope          TEXT,                       -- JSON：志工群組／理監事群組／私訊
  roles          TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id        TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  who       TEXT,
  role      TEXT,
  scope     TEXT NOT NULL,                   -- meta／record／settings／connection／auth
  target    TEXT,
  action    TEXT NOT NULL,                   -- create／update／delete／restore／login／export
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at     ON audit (at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit (target, at DESC);

-- 同步狀態：Apps Script 每次把工作表推進來時記一筆，看得出哪個物件多久沒同步
CREATE TABLE IF NOT EXISTS sync_state (
  object_id  TEXT PRIMARY KEY,
  synced_at  TEXT,
  rows       INTEGER,
  source     TEXT,
  note       TEXT
);
