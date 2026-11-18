/**
 * 寓委聯 Worker API（Cloudflare Workers ＋ D1）
 *
 * 這支程式不認識「會員」「訂單」是什麼，全部讀設定庫（meta_object／meta_field）運作。
 * 見 docs/系統規範.md 第三部分。
 *
 * 路由（只處理 /api/*，其餘交給靜態檔）：
 *   GET  /api/health            活著嗎、設定庫有幾個物件
 *   POST /api/setup             建表＋灌設定庫。只有在設定庫還空的時候能跑，跑過一次就拒絕
 *   GET  /api/meta              物件、欄位、關聯、選單（依 privacy 過濾）
 *   POST /api/list              { object, view, where, limit, cursor }
 *   POST /api/get               { object, id }
 *   POST /api/claim-key         第一次連線：Apps Script 自己產生金鑰存進來（只能跑一次）
 *   POST /api/reseed            改過 meta.mjs 部署後重灌設定庫（要金鑰，不碰 record）
 *   GET  /api/sync-map          要同步哪些物件、每個欄位對應工作表的哪一欄（要金鑰）
 *   POST /api/sync              Apps Script 把工作表推進來（要金鑰）
 *   POST /api/share-secret      Apps Script 把通行證的簽章密鑰交過來（要金鑰，只能設一次）
 *   POST /api/settings          Apps Script 把「設定」工作表推進來（要金鑰）
 *   GET  /api/settings-list    設定與文案（秘書處才看得到）
 *   POST /api/audit            記一筆留痕（Apps Script 用，要金鑰）
 *   GET  /api/audit            查留痕（秘書處才看得到）
 *   POST /api/related          點開一筆資料時，一起帶出相關紀錄（設定庫決定怎麼對上）
 *   GET  /api/pending         申請審核：所有還沒處理的申請（秘書處才看得到）
 *   POST /api/actions          Apps Script 把「可以按的動作」推進來（要金鑰）
 *   POST /api/record-status    審核按下去之後，只改那一筆的狀態並留痕（要金鑰）
 *   POST /api/save             新增或修改一筆（要通行證；正本在 D1 的資料才可以）
 *   GET  /api/permits          個別授權一覽（只有秘書長）
 *   GET  /api/export           整個資料庫倒出來備份（要金鑰）
 *   POST /api/find             依欄位值找資料（要金鑰；給 Apps Script 比對用）
 *   POST /api/bulk             一次匯入很多筆，重複的自動併（要金鑰）
 *   POST /api/field-clean      把某個欄位裡的某一項拿掉（要金鑰；例如來源裡的「總表」）
 *   POST /api/unsubscribe      取消訂閱（公開，給信件裡的退訂連結用）
 *   POST /api/permit-set       給某人某一種資料的權限（只有秘書長）
 *   POST /api/permit-remove    收回一筆授權（只有秘書長）
 *   POST /api/remove           刪除一筆（標記刪除，救得回來）
 *   GET  /api/stats           管理台首頁：各物件筆數與最近同步時間
 *   GET  /api/me                我是誰、看得到哪些資料（帶 Authorization: Bearer <通行證>）
 *
 * 權限：沿用 Apps Script 發的通行證（同一組密鑰、同一種格式），所以會員與志工在官網登入一次，
 *       這裡與 Apps Script 都認得。沒帶通行證就是訪客，只看得到 privacy=public 的欄位。
 */

import { SCHEMA } from './schema.js';
import { objects as SEED_OBJECTS, relations as SEED_RELATIONS, menus as SEED_MENUS, settings as SEED_SETTINGS, lineCommands as SEED_LINE } from './meta.mjs';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const ok = (data) => new Response(JSON.stringify({ ok: true, ...data }), { headers: JSON_HEADERS });
const fail = (error, status = 400, message) => new Response(JSON.stringify({ ok: false, error, message: message || null }), { status, headers: JSON_HEADERS });

// ── 設定庫讀取（每次請求讀一次就好）─────────────────────
async function loadMeta(env) {
  const [objects, fields, relations, menus, actions] = await Promise.all([
    env.DB.prepare("SELECT * FROM meta_object WHERE status = 'active' ORDER BY sort, id").all(),
    env.DB.prepare('SELECT * FROM meta_field ORDER BY object_id, sort').all(),
    env.DB.prepare('SELECT * FROM meta_relation').all(),
    env.DB.prepare('SELECT * FROM meta_menu WHERE visible = 1 ORDER BY area, sort').all(),
    env.DB.prepare('SELECT * FROM meta_action ORDER BY object_id, sort').all(),
  ]);
  const byObject = {};
  (fields.results || []).forEach((f) => {
    (byObject[f.object_id] = byObject[f.object_id] || []).push({
      key: f.key, label: f.label, type: f.type,
      options: parse(f.options), required: !!f.required, unique: !!f.is_unique,
      privacy: f.privacy, lockAfter: parse(f.lock_after), inList: !!f.show_in_list, help: f.help,
    });
  });
  return {
    objects: (objects.results || []).map((o) => ({
      id: o.id, label: o.label, labelPlural: o.label_plural, icon: o.icon,
      idRule: o.id_rule, titleField: o.title_field, source: o.source,
      acl: parse(o.acl) || {}, sort: o.sort, fields: byObject[o.id] || [],
    })),
    actions: (actions.results || []).map((a) => {
      const extra = parse(a.confirm_text) || {}; // 備註欄的設定跟確認語一起存在這裡
      return {
        id: a.id, object: a.object_id, label: a.label, icon: a.icon, kind: a.kind,
        to: a.target, roles: parse(a.roles) || [],
        confirm: extra.confirm || '', note: extra.note || null,
        from: String(a.when_cond || '').split(',').filter((x) => x !== undefined), sort: a.sort,
      };
    }),
    relations: (relations.results || []).map((r) => ({
      id: r.id, label: r.label, from: r.from_object, to: r.to_object, kind: r.kind,
      fromLabel: r.from_label, toLabel: r.to_label, onDelete: r.on_delete,
      required: !!r.required, embed: r.embed, match: parse(r.match_on), section: r.section, display: parse(r.display),
    })),
    menus: (menus.results || []).map((m) => ({
      id: m.id, area: m.area, parent: m.parent_id, label: m.label, icon: m.icon,
      kind: m.kind, target: m.target, roles: parse(m.roles), badge: m.badge, sort: m.sort,
    })),
  };
}

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } };

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 回傳 true＝這次請求帶的金鑰是對的
async function keyOk(request, env) {
  const header = request.headers.get('authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!key) return false;
  if (env.SYNC_KEY && key === env.SYNC_KEY) return true; // Cloudflare 後台設的
  const row = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('__sync_key_hash').first();
  if (!row || !row.value) return false;
  return row.value === (await sha256(key)); // Apps Script 自己 claim 的
}

// 把 worker/meta.mjs 的定義寫進設定庫。meta_* 整批換掉；settings 與 line_command 只補沒有的，不蓋掉改過的文案。
async function seedMeta(env) {
  // 舊資料庫可能還沒有 extras 欄（CREATE TABLE IF NOT EXISTS 不會補欄位）
  try { await env.DB.prepare('ALTER TABLE meta_object ADD COLUMN extras TEXT').run(); } catch (err) { /* 已經有了 */ }
  try { await env.DB.prepare('ALTER TABLE meta_relation ADD COLUMN match_on TEXT').run(); } catch (err) { /* 已經有了 */ }
  try { await env.DB.prepare('ALTER TABLE meta_relation ADD COLUMN section TEXT').run(); } catch (err) { /* 已經有了 */ }
  const now = new Date().toISOString();
  const J = (v) => (v == null ? null : JSON.stringify(v));
  const batch = [];
  // meta_action 認得 meta_object，要先清掉才刪得動物件（不然 FOREIGN KEY 擋下來整個 reseed 失敗）
  // 清掉沒關係：選單「同步：更新設定庫」接著就會把按鈕定義重新推上來
  ['meta_action', 'meta_field', 'meta_relation', 'meta_menu', 'meta_object'].forEach((t) => batch.push(env.DB.prepare('DELETE FROM ' + t)));
  SEED_OBJECTS.forEach((o) => {
    batch.push(env.DB.prepare(
      'INSERT INTO meta_object (id,label,label_plural,icon,id_rule,title_field,source,soft_delete,audit_level,acl,sort,status,extras,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(o.id, o.label, o.label_plural || null, o.icon || null, o.id_rule || null, o.title_field || null,
      o.sync ? (o.sync.compute ? 'compute:' + o.sync.compute : 'sheet:' + o.sync.sheet) : (o.source || 'd1'),
      o.soft_delete === 0 ? 0 : 1, o.audit_level || 'full', J(o.acl), o.sort || 0, o.status || 'active',
      J(o.sync ? { syncKey: o.sync.key || null } : null), now, 'seed'));
    o.fields.forEach((f, i) => batch.push(env.DB.prepare(
      'INSERT INTO meta_field (id,object_id,"key",label,type,options,required,is_unique,default_value,validate,privacy,lock_after,show_in_list,sort,help) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(o.id + '.' + f.key, o.id, f.key, f.label, f.type,
      J(f.from ? Object.assign({}, f.options || {}, { from: f.from }) : f.options),
      f.required ? 1 : 0, f.is_unique ? 1 : 0, f.default_value || null, f.validate || null,
      f.privacy || 'staff', J(f.lock_after), f.show_in_list ? 1 : 0, (i + 1) * 10, f.help || null)));
  });
  SEED_RELATIONS.forEach((r) => batch.push(env.DB.prepare(
    'INSERT INTO meta_relation (id,label,from_object,to_object,kind,from_label,to_label,on_delete,required,embed,match_on,section,display) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(r.id, r.label, r.from_object, r.to_object, r.kind, r.from_label || null, r.to_label || null,
    r.on_delete || 'restrict', r.required ? 1 : 0, r.embed || 'ref', J(r.match || null), r.section || null, J(r.display))));
  SEED_MENUS.forEach((m) => batch.push(env.DB.prepare(
    'INSERT INTO meta_menu (id,area,parent_id,label,icon,kind,target,roles,badge,sort,visible) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(m.id, m.area, m.parent_id || null, m.label, m.icon || null, m.kind, m.target || null,
    J(m.roles), m.badge || null, m.sort || 0, m.visible === 0 ? 0 : 1)));
  SEED_SETTINGS.forEach((x, i) => batch.push(env.DB.prepare(
    'INSERT OR IGNORE INTO settings ("key",group_name,type,value,help,sort,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(x.key, x.group || '一般', x.type || 'text', x.value || null, x.help || null, (i + 1) * 10, now, 'seed')));
  SEED_LINE.forEach((c, i) => batch.push(env.DB.prepare(
    'INSERT OR IGNORE INTO line_command (id,trigger_words,label,reply_template,handler,scope,roles,enabled,sort) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(c.id, J(c.trigger), c.label, c.reply_template || null, c.handler || null, J(c.scope), J(c.roles), 1, (i + 1) * 10)));
  await env.DB.batch(batch);
  return {
    tables: SCHEMA.length,
    objects: SEED_OBJECTS.length,
    fields: SEED_OBJECTS.reduce((t, o) => t + o.fields.length, 0),
    relations: SEED_RELATIONS.length, menus: SEED_MENUS.length,
    settings: SEED_SETTINGS.length, lineCommands: SEED_LINE.length,
  };
}
// ── 通行證（與 Apps Script 同一種格式：base64url(JSON).HMAC-SHA256）──
const b64urlFromBytes = (buf) => {
  let bin = '';
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
};
const b64urlToText = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

async function tokenSecret(env) {
  if (env.TOKEN_SECRET) return env.TOKEN_SECRET;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('__token_secret').first();
  return row && row.value ? row.value : '';
}

async function readToken(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const secret = await tokenSecret(env);
  if (!secret) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
    if (b64urlFromBytes(mac) !== parts[1]) return null;
    const data = JSON.parse(b64urlToText(parts[0]));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (err) {
    return null;
  }
}

// 通行證 → 角色。三種人有特別身分：
//   秘書長（「管理員會員編號」名單）→ admin，什麼都能改
//   理監事（「理監事會員編號」名單）→ board，只看得到財務，什麼都不能改
//   志工 → volunteer，再加上「個別授權」給的那幾種資料
// 其餘是一般會員或訪客。
async function roleOf(request, env) {
  const data = await readToken(request, env);
  if (!data) return { role: 'guest' };
  const id = String(data.id || '');
  const volunteer = id.indexOf('VOL:') === 0;
  const who = { role: volunteer ? 'volunteer' : 'member', id: volunteer ? id.slice(4) : id, name: data.name || '', suspended: !!data.s };
  if (who.suspended) return who; // 停權會員只剩繳費，資料一律不給
  const names = ['管理員會員編號', '理監事會員編號'];
  const rows = await env.DB.prepare(
    'SELECT "key", value FROM settings WHERE "key" IN (?, ?)'
  ).bind(names[0], names[1]).all();
  const listOf = (name) => {
    const hit = (rows.results || []).find((r) => r.key === name);
    return String((hit && hit.value) || '').split(/[\s,，、;；]+/).filter(Boolean).map((x) => x.toUpperCase());
  };
  const mine = who.id.toUpperCase();
  if (!volunteer && listOf(names[0]).indexOf(mine) !== -1) who.role = 'admin';
  else if (!volunteer && listOf(names[1]).indexOf(mine) !== -1) who.role = 'board';

  // 個別授權：用綽號、志工編號或會員編號都查得到；* 代表全體志工
  const keys = volunteer ? [who.id, '*'] : [who.id];
  const permits = await env.DB.prepare(
    'SELECT object_id, level FROM permit WHERE who IN (' + keys.map(() => '?').join(',') + ')'
  ).bind(...keys).all();
  who.permits = {};
  (permits.results || []).forEach((p) => {
    const now = who.permits[p.object_id];
    if (now === 'write') return; // 已經給到可以改了，不會被 read 降下來
    who.permits[p.object_id] = p.level;
  });
  return who;
}

// 個別授權有沒有給到這一種資料（物件代號，或 * 代表全部）
function permitLevel(who, objectId) {
  const p = (who && who.permits) || {};
  if (p[objectId] === 'write' || p['*'] === 'write') return 'write';
  if (p[objectId] === 'read' || p['*'] === 'read') return 'read';
  return '';
}

const VISIBLE = {
  guest: ['public'],
  member: ['public', 'member'],
  volunteer: ['public', 'member'],
  board: ['public', 'member', 'staff'],
  staff: ['public', 'member', 'staff'],
  // 只有秘書長看得到個資（手機、地址、身分證字號）
  admin: ['public', 'member', 'staff', 'secret'],
};

// 身分的涵蓋範圍：登入的人至少看得到訪客看得到的東西；秘書處涵蓋會員與志工。
const COVERS = {
  guest: ['guest'],
  member: ['guest', 'member'],
  volunteer: ['guest', 'volunteer'],
  board: ['guest', 'member', 'board'],
  staff: ['guest', 'member', 'volunteer', 'staff'],
  admin: ['guest', 'member', 'volunteer', 'staff', 'admin'],
};

// who 可以不給（舊的呼叫方式），給了才會把個別授權算進去
function canList(object, role, who) {
  if (role === 'admin') return true;
  if (who && permitLevel(who, object.id)) return true;
  const allow = (object.acl && object.acl.list) || [];
  const mine = COVERS[role] || COVERS.guest;
  return allow.some((r) => mine.indexOf(r) !== -1);
}

// 能不能改、能不能新增、能不能刪：跟 canList 同一套涵蓋規則
function canDo(object, role, what, who) {
  if (role === 'admin') return true;
  if (role === 'board') return false; // 理監事只看，不改
  // 個別授權給到 write 就能新增與修改；刪除永遠只有秘書長
  if (what !== 'delete' && who && permitLevel(who, object.id) === 'write') return true;
  const allow = (object.acl && object.acl[what]) || [];
  const mine = COVERS[role] || COVERS.guest;
  return allow.some((r) => mine.indexOf(r) !== -1);
}

// 正本在哪：source 是 d1（或沒寫）才可以在這裡改；還在試算表的要回去試算表改
function ownedHere(object) {
  const src = String(object.source || 'd1');
  return src === 'd1' || src === '';
}

// 一個欄位的值合不合格。回傳錯誤訊息，沒問題就回 null。
function fieldError(field, value) {
  const empty = value == null || String(value).trim() === '';
  if (field.required && empty) return field.label + ' 要填';
  if (empty) return null;
  if (field.type === 'number' || field.type === 'money') {
    if (isNaN(Number(value))) return field.label + ' 要填數字';
  }
  if (field.type === 'select' && field.options && Array.isArray(field.options.items) && field.options.items.length) {
    if (field.options.items.indexOf(String(value)) === -1) {
      return field.label + ' 只能是：' + field.options.items.join('、');
    }
  }
  if (field.type === 'date' || field.type === 'datetime') {
    if (isNaN(new Date(String(value)).getTime())) return field.label + ' 不是看得懂的日期';
  }
  return null;
}

// 這個欄位現在改不改得動（lock_after）。before 是原本的值，新增時沒有。
function lockError(field, before, after, role) {
  const mode = field.lockAfter && field.lockAfter.mode;
  if (!mode || mode === 'open' || mode === 'tracked') return null; // tracked 可以改，只是會留痕
  const had = before != null && String(before).trim() !== '';
  if (!had) return null; // 原本就空的，第一次填不算改
  if (String(before) === String(after)) return null;
  if (mode === 'locked') return field.label + ' 填過就不能再改了' + (role === 'admin' ? '' : '');
  if (mode === 'append') {
    return String(after).indexOf(String(before)) === 0 ? null : field.label + ' 只能往後接，不能改掉原本的內容';
  }
  if (mode === 'reverse_only') return field.label + ' 不能直接改，要另外開一筆沖銷';
  return null;
}

// 依角色把看不到的欄位拿掉；secret 永遠不回傳
function shape(object, row, role) {
  const data = parse(row.data) || {};
  let seen = VISIBLE[role] || VISIBLE.guest;
  // 理監事只有在財務那幾種資料上才看得到秘書處層級的欄位；其餘跟一般會員一樣
  if (role === 'board') {
    const forBoard = ((object.acl && object.acl.read) || []).indexOf('board') !== -1;
    if (!forBoard) seen = VISIBLE.member;
  }
  const out = {};
  object.fields.forEach((f) => {
    if (!seen.includes(f.privacy)) return; // secret 只在 VISIBLE.admin 裡，所以只有秘書長拿得到
    if (data[f.key] !== undefined) out[f.key] = data[f.key];
  });
  return { id: row.id, title: row.title, status: row.status, updatedAt: row.updated_at, data: out };
}

// 保留鍵（__ 開頭）只在伺服器內部使用，任何 API 都不會回傳：__sync_key_hash、__token_secret
// ── 路由 ────────────────────────────────────────────────
async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const who = await roleOf(request, env);
  // 停權會員只剩繳費：權限一律降到訪客，但 /api/me 仍照實回報他的身分
  const role = who.suspended ? 'guest' : who.role;

  if (path === 'health') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM meta_object').first();
    const s = await env.DB.prepare('SELECT COUNT(*) AS n FROM record WHERE deleted_at IS NULL').first();
    const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first();
    const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit').first();
    return ok({ service: 'ccs-worker', objects: r ? r.n : 0, records: s ? s.n : 0, settings: t ? t.n : 0, audit: u ? u.n : 0, at: new Date().toISOString() });
  }

  // 第一次上線：建表＋灌設定庫。設定庫已經有東西就拒絕，避免有人重跑把設定洗掉。
  if (path === 'setup') {
    for (const sql of SCHEMA) await env.DB.prepare(sql).run();
    const already = await env.DB.prepare('SELECT COUNT(*) AS n FROM meta_object').first();
    if (already && already.n > 0) return fail('already_initialized', 409, '設定庫已經有 ' + already.n + ' 個物件；要重灌請用 POST /api/reseed（要金鑰）');
    return ok(await seedMeta(env));
  }

  // 改過 worker/meta.mjs、部署之後呼叫這個，把設定庫重灌成新的定義。
  // 只動 meta_*，不碰 record 裡的實際資料；settings 與 line_command 既有的值也不會被蓋掉。
  if (path === 'reseed') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    for (const sql of SCHEMA) await env.DB.prepare(sql).run();
    return ok(await seedMeta(env));
  }
  if (path === 'claim-key') {
    const exists = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('__sync_key_hash').first();
    if (exists && exists.value) return fail('already_initialized', 409, '金鑰已經設定過了；要重設請先到 Cloudflare 後台把 settings 的 __sync_key_hash 清掉');
    const body0 = await request.json().catch(() => ({}));
    const key = String(body0.key || '');
    if (key.length < 24) return fail('weak_key', 400, '金鑰至少 24 個字');
    await env.DB.prepare(
      'INSERT INTO settings ("key",group_name,type,value,help,sort,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)'
    ).bind('__sync_key_hash', '系統', 'text', await sha256(key), '資料同步金鑰的雜湊；原文只存在 Apps Script 的指令碼屬性。', 999, new Date().toISOString(), 'claim').run();
    return ok({ claimed: true });
  }

  // 同步對照表：哪些物件要從試算表同步、每個欄位對應哪一欄
  if (path === 'sync-map') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const objects = await env.DB.prepare("SELECT id, label, source, title_field, extras FROM meta_object WHERE (source LIKE 'sheet:%' OR source LIKE 'compute:%') AND status = 'active' ORDER BY sort").all();
    // 所有欄位都同步，含 privacy=secret 的手機：CRM 要靠它把同一個人的會員與志工身分合起來，
    // 登入搬到 Worker 之後也要用它比對末三碼。保護靠的是「誰讀得到」：secret 欄位只有秘書長拿得到（見 VISIBLE.admin 與 shape()）。
    const fields = await env.DB.prepare('SELECT object_id, "key", type, options FROM meta_field ORDER BY object_id, sort').all();
    const byObject = {};
    (fields.results || []).forEach((f) => {
      const opt = parse(f.options) || {};
      if (!opt.from) return;
      (byObject[f.object_id] = byObject[f.object_id] || []).push({ key: f.key, type: f.type, from: opt.from });
    });
    return ok({
      objects: (objects.results || []).map((o) => ({
        id: o.id, label: o.label, titleField: o.title_field, fields: byObject[o.id] || [],
        key: (parse(o.extras) || {}).syncKey || null, // 哪個（些）欄位當主鍵；沒指定就用 id
        sheet: String(o.source).indexOf('sheet:') === 0 ? String(o.source).slice(6) : '',
        compute: String(o.source).indexOf('compute:') === 0 ? String(o.source).slice(8) : '',
      })).filter((o) => o.fields.length),
    });
  }

  if (path === 'me') {
    const meta = await loadMeta(env);
    return ok({
      role: who.role, id: who.id || null, name: who.name || null, suspended: !!who.suspended,
      canList: meta.objects.filter((o) => canList(o, who.role, who)).map((o) => o.id),
      // 管理台靠這個決定要不要顯示「新增」「儲存」
      canWrite: meta.objects.filter((o) => canDo(o, who.role, 'update', who)).map((o) => o.id),
      permits: who.permits || {},
    });
  }

  // Apps Script 把通行證的簽章密鑰交過來，兩邊才認得同一張通行證。只能設一次。
  if (path === 'share-secret') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const exists = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('__token_secret').first();
    if (exists && exists.value) return fail('already_initialized', 409, '已經設定過了');
    const b = await request.json().catch(() => ({}));
    const secret = String(b.secret || '');
    if (secret.length < 24) return fail('weak_key', 400, '密鑰太短');
    await env.DB.prepare(
      'INSERT INTO settings ("key",group_name,type,value,help,sort,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)'
    ).bind('__token_secret', '系統', 'text', secret, '通行證的簽章密鑰，與 Apps Script 的 TOKEN_SECRET 相同。任何 API 都不會回傳。', 998, new Date().toISOString(), 'share').run();
    return ok({ shared: true });
  }

  // Apps Script 把「設定」工作表推進來。__ 開頭的保留鍵（金鑰、通行證密鑰）不受影響。
  if (path === 'settings') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const b = await request.json().catch(() => ({}));
    const rows = Array.isArray(b.rows) ? b.rows.filter((r) => r && r.key && String(r.key).indexOf('__') !== 0) : [];
    if (!rows.length) return fail('missing_fields');
    const now = new Date().toISOString();
    await env.DB.batch(rows.slice(0, 200).map((r, i) => env.DB.prepare(
      `INSERT INTO settings ("key",group_name,type,value,help,sort,updated_at,updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sync')
       ON CONFLICT ("key") DO UPDATE SET group_name = excluded.group_name, type = excluded.type,
         value = excluded.value, help = excluded.help, updated_at = excluded.updated_at, updated_by = 'sync'`
    ).bind(String(r.key), String(r.group || '一般'),
      String(r.key).indexOf('文案：') === 0 ? 'template' : 'text',
      r.value == null ? null : String(r.value), r.help == null ? null : String(r.help), (i + 1) * 10, now)));
    return ok({ written: Math.min(rows.length, 200) });
  }

  // 管理台首頁要的數字：每個物件幾筆、最近同步時間。一次問完，不用一個物件打一次
  if (path === 'stats') {
    const meta = await loadMeta(env);
    const mine = meta.objects.filter((o) => canList(o, role, who));
    const counts = await env.DB.prepare(
      'SELECT object_id, COUNT(*) AS n FROM record WHERE deleted_at IS NULL GROUP BY object_id'
    ).all();
    const byId = {};
    (counts.results || []).forEach((r) => (byId[r.object_id] = r.n));
    const sync = await env.DB.prepare('SELECT object_id, synced_at, rows, source FROM sync_state').all();
    const syncById = {};
    (sync.results || []).forEach((r) => (syncById[r.object_id] = { at: r.synced_at, rows: r.rows, source: r.source }));
    return ok({
      role: role,
      objects: mine.map((o) => ({ id: o.id, label: o.label, icon: o.icon, count: byId[o.id] || 0, sync: syncById[o.id] || null })),
      totalRecords: Object.keys(byId).reduce((n, k) => n + byId[k], 0),
    });
  }

  // 申請審核：所有還沒處理的申請（會員入會、志工申請、器材借用、請款…）一次撈出來。
  // 「還沒處理」的狀態字詞放在設定〈待辦狀態〉，秘書處可以自己加字詞，不用改程式。
  if (path === 'actions' && request.method === 'POST') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const payload = await request.json().catch(() => ({}));
    const list = Array.isArray(payload.actions) ? payload.actions : [];
    await env.DB.prepare('DELETE FROM meta_action').run();
    if (list.length) {
      await env.DB.batch(list.map((a, i) => env.DB.prepare(
        `INSERT INTO meta_action (id, object_id, label, icon, kind, target, roles, confirm_text, when_cond, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        String(a.id), String(a.object), String(a.label), String(a.icon || 'check'), String(a.kind || 'status'),
        a.target == null ? null : String(a.target), JSON.stringify(a.roles || []),
        JSON.stringify({ confirm: a.confirm || '', note: a.note || null }), String(a.when || ''), Number(a.sort || (i + 1) * 10),
      )));
    }
    return ok({ written: list.length });
  }

  // ── 備份：把整個資料庫倒出來 ────────────────────────
  // 用金鑰認證（不是通行證），因為這是機器對機器：Apps Script 每天來拿一份存到雲端硬碟。
  // 倒出來的是原始資料，含個資，所以存放的地方要跟試算表一樣小心。
  if (path === 'export') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const [records, settings, permits, actions] = await Promise.all([
      env.DB.prepare('SELECT object_id, id, data, status, title, created_at, created_by, updated_at, updated_by, deleted_at FROM record ORDER BY object_id, id').all(),
      env.DB.prepare('SELECT "key", group_name, type, value, help FROM settings WHERE "key" NOT LIKE ? ORDER BY "key"').bind('\\_\\_%').all(),
      env.DB.prepare('SELECT * FROM permit').all(),
      env.DB.prepare('SELECT * FROM meta_action').all(),
    ]);
    const byObject = {};
    (records.results || []).forEach((r) => {
      (byObject[r.object_id] = byObject[r.object_id] || []).push({
        id: r.id, data: parse(r.data), status: r.status, title: r.title,
        createdAt: r.created_at, createdBy: r.created_by,
        updatedAt: r.updated_at, updatedBy: r.updated_by, deletedAt: r.deleted_at,
      });
    });
    return ok({
      at: new Date().toISOString(),
      counts: Object.keys(byObject).reduce((t, k) => Object.assign(t, { [k]: byObject[k].length }), {}),
      records: byObject,
      settings: settings.results || [],
      permits: permits.results || [],
      actions: actions.results || [],
    });
  }

  // ── 個別授權：誰可以碰哪一種資料 ────────────────────
  if (path === 'permits') {
    if (role !== 'admin') return fail('forbidden', 403);
    const meta = await loadMeta(env);
    const rows = await env.DB.prepare('SELECT * FROM permit ORDER BY who, object_id').all();
    const labels = {};
    meta.objects.forEach((o) => (labels[o.id] = o.label));
    return ok({
      rows: (rows.results || []).map((r) => ({
        id: r.id, who: r.who, object: r.object_id, objectLabel: labels[r.object_id] || r.object_id,
        level: r.level, note: r.note, at: r.created_at,
      })),
      objects: meta.objects.map((o) => ({ id: o.id, label: o.label })),
    });
  }

  if (path === 'permit-set' && request.method === 'POST') {
    if (role !== 'admin') return fail('forbidden', 403);
    const b = await request.json().catch(() => ({}));
    const target = String(b.who || '').trim();
    const objectId = String(b.object || '').trim();
    const level = String(b.level || '').trim();
    if (!target || !objectId) return fail('missing_fields');
    if (level !== 'read' && level !== 'write') return fail('invalid', 400, '只能給「看」或「可以改」');
    const meta = await loadMeta(env);
    if (objectId !== '*' && !meta.objects.some((o) => o.id === objectId)) return fail('object_not_found', 404);
    const now = new Date().toISOString();
    const me = who.name || who.id || 'console';
    const id = (target + '|' + objectId).toLowerCase();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO permit (id, who, object_id, level, note, created_at, created_by) VALUES (?,?,?,?,?,?,?)' +
        ' ON CONFLICT(id) DO UPDATE SET level = excluded.level, note = excluded.note, created_at = excluded.created_at, created_by = excluded.created_by'
      ).bind(id, target, objectId, level, b.note == null ? null : String(b.note), now, me),
      env.DB.prepare('INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind((Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase(), now, me, role, 'permit', id, 'grant', null, JSON.stringify({ who: target, object: objectId, level: level })),
    ]);
    return ok({ id: id });
  }

  if (path === 'permit-remove' && request.method === 'POST') {
    if (role !== 'admin') return fail('forbidden', 403);
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || '').trim();
    if (!id) return fail('missing_id');
    const row = await env.DB.prepare('SELECT * FROM permit WHERE id = ?').bind(id).first();
    if (!row) return fail('not_found', 404);
    const now = new Date().toISOString();
    const me = who.name || who.id || 'console';
    await env.DB.batch([
      env.DB.prepare('DELETE FROM permit WHERE id = ?').bind(id),
      env.DB.prepare('INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind((Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase(), now, me, role, 'permit', id, 'revoke', JSON.stringify({ who: row.who, object: row.object_id, level: row.level }), null),
    ]);
    return ok({ removed: true });
  }

  // 帶金鑰來的是我們自己的程式（Apps Script）：等同秘書長，但留痕要記成真正動手的那個人。
  // 用在「志工申請不通過自動建潛在會員」這種系統寫入。
  async function asSystem(body) {
    if (role === 'admin') return { role: role, who: who };
    if (await keyOk(request, env)) {
      return { role: 'admin', who: { role: 'admin', id: 'system', name: String((body && body.who) || '系統'), permits: {} } };
    }
    return { role: role, who: who };
  }

  // ── 取消訂閱 ────────────────────────────────────────
  // 公開的，因為是給信件裡的退訂連結用，對方不會有帳號。
  // 只做一件事：把名單上這個信箱標成已取消訂閱。即使信箱不在名單裡，回覆也一樣，
  // 這樣別人沒辦法拿它來試探誰在我們的名單上。
  if (path === 'unsubscribe' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('invalid_email', 400, '請輸入正確的 Email');
    const rows = await env.DB.prepare(
      "SELECT id, data FROM record WHERE object_id = 'prospect' AND deleted_at IS NULL AND lower(json_extract(data, '$.email')) = ?"
    ).bind(email).all();
    const now = new Date().toISOString();
    const writes = [];
    (rows.results || []).forEach((r) => {
      const data = parse(r.data) || {};
      if (String(data.opt_out || '') === '是') return;
      data.opt_out = '是';
      data.last_touch = now.slice(0, 10);
      writes.push(env.DB.prepare(
        'UPDATE record SET data = ?, updated_at = ?, updated_by = ? WHERE object_id = ? AND id = ?'
      ).bind(JSON.stringify(data), now, '本人退訂', 'prospect', r.id));
      writes.push(env.DB.prepare(
        'INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind((Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase(), now, '本人退訂', 'guest', 'prospect', r.id, 'unsubscribe',
        JSON.stringify({ opt_out: '' }), JSON.stringify({ opt_out: '是' })));
    });
    for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
    return ok({ done: true });
  }

  // ── 把某個欄位裡的某一項拿掉 ────────────────────────
  // 欄位內容是用「；」串起來的（例如來源「總表；交流日」），這裡只拿掉指定的那一項。
  if (path === 'field-clean' && request.method === 'POST') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const b = await request.json().catch(() => ({}));
    const meta = await loadMeta(env);
    const object = meta.objects.find((o) => o.id === b.object);
    if (!object) return fail('object_not_found', 404);
    const field = String(b.field || '').trim();
    const remove = String(b.remove || '').trim();
    if (!field || !remove) return fail('missing_fields');
    if (!object.fields.some((f) => f.key === field)) return fail('field_not_found', 404);

    const rows = await env.DB.prepare('SELECT id, data FROM record WHERE object_id = ? AND deleted_at IS NULL').bind(object.id).all();
    const now = new Date().toISOString();
    const who = String(b.who || '整理');
    const writes = [];
    (rows.results || []).forEach((r) => {
      const data = parse(r.data) || {};
      const current = String(data[field] == null ? '' : data[field]).trim();
      if (!current) return;
      const parts = current.split('；').map((x) => x.trim()).filter(Boolean);
      const kept = parts.filter((x) => x !== remove);
      if (kept.length === parts.length) return;
      data[field] = kept.join('；');
      writes.push(env.DB.prepare(
        'UPDATE record SET data = ?, updated_at = ?, updated_by = ? WHERE object_id = ? AND id = ?'
      ).bind(JSON.stringify(data), now, who, object.id, r.id));
    });
    for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
    if (writes.length) {
      await env.DB.prepare(
        'INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind((Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase(), now, who, 'admin', object.id, '(整批)', 'field-clean',
        JSON.stringify({ field: field, removed: remove }), JSON.stringify({ changed: writes.length })).run();
    }
    return ok({ changed: writes.length });
  }

  // ── 批次匯入 ────────────────────────────────────────
  // 搬家時一次塞幾百筆用的。一筆一筆打 API 會打到逾時，所以這裡一次收一整批。
  // dedupe 填哪些欄位算「同一個人」（例如 ["phone","email"]）：對得上就補資料，不會變兩筆。
  if (path === 'bulk' && request.method === 'POST') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const b = await request.json().catch(() => ({}));
    const meta = await loadMeta(env);
    const object = meta.objects.find((o) => o.id === b.object);
    if (!object) return fail('object_not_found', 404);
    const incoming = Array.isArray(b.rows) ? b.rows : [];
    if (!incoming.length) return ok({ created: 0, merged: 0, skipped: 0 });
    if (incoming.length > 500) return fail('too_many', 400, '一次最多 500 筆');
    const keys = Array.isArray(b.dedupe) ? b.dedupe.filter(Boolean).slice(0, 3) : [];
    const appendFields = Array.isArray(b.appendFields) ? b.appendFields : [];
    const onlyExisting = b.onlyExisting === true;
    const who = String(b.who || '匯入');
    const now = new Date().toISOString();

    // 先把現有的資料讀進來，用來比對（潛在會員這種表頂多幾千筆，一次讀得完）
    const existing = await env.DB.prepare('SELECT id, data FROM record WHERE object_id = ? AND deleted_at IS NULL').bind(object.id).all();
    const index = {};
    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
    // 連電話 Email 都沒有的（有些名單只留名字），改用「名字＋一樣沒有聯絡方式」當作同一個人，
    // 不然每匯入一次就多一筆。有聯絡方式的不會走這條，免得同名同姓被誤併。
    const bare = (d) => !keys.some((k) => norm(d[k]));
    (existing.results || []).forEach((r) => {
      const d = parse(r.data) || {};
      keys.forEach((k) => { const v = norm(d[k]); if (v) index[k + ':' + v] = { id: r.id, data: d }; });
      if (bare(d)) { const n = norm(d[object.titleField]); if (n) index['(無聯絡方式):' + n] = { id: r.id, data: d }; }
    });

    const writes = [];
    let created = 0;
    let merged = 0;
    let skipped = 0;
    incoming.forEach((row) => {
      const data = (row && typeof row === 'object' && row.data) ? row.data : row;
      if (!data || typeof data !== 'object') { skipped++; return; }
      let hit = null;
      for (const k of keys) {
        const v = norm(data[k]);
        if (v && index[k + ':' + v]) { hit = index[k + ':' + v]; break; }
      }
      if (!hit && bare(data)) {
        const n = norm(data[object.titleField]);
        if (n && index['(無聯絡方式):' + n]) hit = index['(無聯絡方式):' + n];
      }
      if (hit) {
        // 有這個人了：只補原本空著的欄位，不覆蓋既有內容
        const next = Object.assign({}, hit.data);
        let changed = false;
        Object.keys(data).forEach((k) => {
          const incomingValue = String(data[k] == null ? '' : data[k]).trim();
          const current = String(next[k] == null ? '' : next[k]).trim();
          if (!incomingValue) return;
          if (appendFields.indexOf(k) !== -1) {
            // 接在後面，但同樣的字不重複接（重跑這支工具不會愈接愈長）
            const parts = current ? current.split('；').map((x) => x.trim()).filter(Boolean) : [];
            if (parts.indexOf(incomingValue) !== -1) return;
            parts.push(incomingValue);
            next[k] = parts.join('；');
            changed = true;
            return;
          }
          if (!current) { next[k] = data[k]; changed = true; }
        });
        if (!changed) { merged++; return; }
        const title = String(next[object.titleField] == null ? '' : next[object.titleField]).slice(0, 120);
        writes.push(env.DB.prepare(
          'UPDATE record SET data = ?, title = ?, updated_at = ?, updated_by = ? WHERE object_id = ? AND id = ?'
        ).bind(JSON.stringify(next), title, now, who, object.id, hit.id));
        keys.forEach((k) => { const v = norm(next[k]); if (v) index[k + ':' + v] = { id: hit.id, data: next }; });
        if (bare(next)) { const n = norm(next[object.titleField]); if (n) index['(無聯絡方式):' + n] = { id: hit.id, data: next }; }
        merged++;
        return;
      }
      if (onlyExisting) { skipped++; return; }
      const id = object.id.toUpperCase().slice(0, 3) + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 7).toUpperCase();
      const title = String(data[object.titleField] == null ? '' : data[object.titleField]).slice(0, 120);
      const status = String(data.status == null ? '' : data.status);
      writes.push(env.DB.prepare(
        'INSERT INTO record (id, object_id, data, status, title, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(id, object.id, JSON.stringify(data), status, title, now, who, now, who));
      keys.forEach((k) => { const v = norm(data[k]); if (v) index[k + ':' + v] = { id: id, data: data }; });
      if (bare(data)) { const n = norm(data[object.titleField]); if (n) index['(無聯絡方式):' + n] = { id: id, data: data }; }
      created++;
    });

    // 分批寫，免得一次送太多句
    for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
    if (created || merged) {
      await env.DB.prepare(
        'INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind((Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase(), now, who, 'admin', object.id, '(批次匯入)', 'import', null,
        JSON.stringify({ created: created, merged: merged, skipped: skipped })).run();
    }
    return ok({ created: created, merged: merged, skipped: skipped });
  }

  // ── 依欄位值找資料（Apps Script 比對用）────────────────
  if (path === 'find' && request.method === 'POST') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const b = await request.json().catch(() => ({}));
    const meta = await loadMeta(env);
    const object = meta.objects.find((o) => o.id === b.object);
    if (!object) return fail('object_not_found', 404);
    const where = (b.where && typeof b.where === 'object') ? b.where : {};
    const keys = Object.keys(where).slice(0, 4);
    if (!keys.length) return fail('missing_fields');
    // 任何一個條件對上就算（給「同一個人用電話或 Email 比對」用）
    const sql = 'SELECT id, data, status, title FROM record WHERE object_id = ? AND deleted_at IS NULL AND (' +
      keys.map(() => "json_extract(data, '$.' || ?) = ?").join(' OR ') + ') LIMIT 20';
    const args = [object.id];
    keys.forEach((k) => { args.push(k); args.push(String(where[k])); });
    const rows = await env.DB.prepare(sql).bind(...args).all();
    return ok({ rows: (rows.results || []).map((r) => ({ id: r.id, status: r.status, title: r.title, data: parse(r.data) || {} })) });
  }

  // ── 新增或修改一筆 ──────────────────────────────────
  // 正本在 D1 的資料才走這裡。還在試算表的，改了也會被下一次同步蓋掉，所以直接擋下來。
  if (path === 'save' && request.method === 'POST') {
    const meta = await loadMeta(env);
    const body2 = await request.json().catch(() => ({}));
    const object = meta.objects.find((o) => o.id === body2.object);
    if (!object) return fail('object_not_found', 404);
    if (!ownedHere(object)) return fail('not_editable_here', 409, '「' + object.label + '」的正本還在試算表，請到試算表改');
    const id = String(body2.id == null ? '' : body2.id).trim();
    const isNew = !id;
    const act = await asSystem(body2);
    if (!canDo(object, act.role, isNew ? 'create' : 'update', act.who)) return fail('forbidden', 403);
    const input = body2.data && typeof body2.data === 'object' ? body2.data : {};

    let before = null;
    if (!isNew) {
      const row = await env.DB.prepare('SELECT * FROM record WHERE object_id = ? AND id = ? AND deleted_at IS NULL').bind(object.id, id).first();
      if (!row) return fail('not_found', 404);
      before = parse(row.data) || {};
    }

    // 只收這個角色看得到的欄位：看不到的欄位不會被誤清空，secret 也不會被偷改
    const seen = VISIBLE[act.role] || VISIBLE.guest;
    const data = Object.assign({}, before || {});
    const problems = [];
    object.fields.forEach((f) => {
      if (f.privacy === 'secret' && act.role !== 'admin') return; // 只有秘書長能改個資
      if (!seen.includes(f.privacy)) return;
      if (!Object.prototype.hasOwnProperty.call(input, f.key)) {
        const err0 = fieldError(f, data[f.key]);
        if (err0 && isNew) problems.push(err0);
        return;
      }
      const value = input[f.key];
      const err = fieldError(f, value);
      if (err) { problems.push(err); return; }
      const locked = isNew ? null : lockError(f, before ? before[f.key] : null, value, act.role);
      if (locked) { problems.push(locked); return; }
      data[f.key] = value === '' ? null : value;
    });
    if (problems.length) return fail('invalid', 400, problems.join('；'));

    // 不重複的欄位：同一種資料裡不能有第二筆一樣的
    for (const f of object.fields.filter((x) => x.unique)) {
      const v = data[f.key];
      if (v == null || String(v).trim() === '') continue;
      const dup = await env.DB.prepare(
        "SELECT id FROM record WHERE object_id = ? AND deleted_at IS NULL AND id != ? AND json_extract(data, '$.' || ?) = ?"
      ).bind(object.id, id || '\u0000', f.key, String(v)).first();
      if (dup) return fail('duplicate', 409, f.label + '「' + v + '」已經有一筆了（' + dup.id + '）');
    }

    const now = new Date().toISOString();
    const me = act.who.name || act.who.id || 'console';
    const title = String(data[object.titleField] == null ? '' : data[object.titleField]).slice(0, 120);
    const status = String(data.status == null ? '' : data.status);
    const newId = isNew ? (object.id.toUpperCase().slice(0, 3) + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()) : id;

    const writes = [];
    if (isNew) {
      writes.push(env.DB.prepare(
        'INSERT INTO record (id, object_id, data, status, title, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(newId, object.id, JSON.stringify(data), status, title, now, me, now, me));
    } else {
      writes.push(env.DB.prepare(
        'UPDATE record SET data = ?, status = ?, title = ?, updated_at = ?, updated_by = ? WHERE object_id = ? AND id = ?'
      ).bind(JSON.stringify(data), status, title, now, me, object.id, newId));
    }
    const auditId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
    writes.push(env.DB.prepare(
      'INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(auditId, now, me, act.role, object.id, newId, isNew ? 'create' : 'update',
      before == null ? null : JSON.stringify(before), JSON.stringify(data)));
    await env.DB.batch(writes);
    return ok({ id: newId, created: isNew });
  }

  // ── 刪除一筆 ────────────────────────────────────────
  // 標記刪除，資料還在，留痕也還在，救得回來
  if (path === 'remove' && request.method === 'POST') {
    const meta = await loadMeta(env);
    const body3 = await request.json().catch(() => ({}));
    const object = meta.objects.find((o) => o.id === body3.object);
    if (!object) return fail('object_not_found', 404);
    if (!ownedHere(object)) return fail('not_editable_here', 409, '「' + object.label + '」的正本還在試算表');
    const act2 = await asSystem(body3);
    if (!canDo(object, act2.role, 'delete', act2.who)) return fail('forbidden', 403);
    const id = String(body3.id || '').trim();
    if (!id) return fail('missing_id');
    const row = await env.DB.prepare('SELECT * FROM record WHERE object_id = ? AND id = ? AND deleted_at IS NULL').bind(object.id, id).first();
    if (!row) return fail('not_found', 404);

    // 別人還指著它就不給刪（on_delete = restrict）
    for (const rel of meta.relations.filter((r) => r.from === object.id && r.onDelete === 'restrict' && r.match)) {
      const value = (parse(row.data) || {})[rel.match.from];
      if (value == null || value === '') continue;
      const used = await env.DB.prepare(
        "SELECT id FROM record WHERE object_id = ? AND deleted_at IS NULL AND json_extract(data, '$.' || ?) = ? LIMIT 1"
      ).bind(rel.to, rel.match.to, String(value)).first();
      if (used) return fail('in_use', 409, '還有「' + rel.label + '」指著這一筆（' + used.id + '），不能刪');
    }

    const now = new Date().toISOString();
    const me = act2.who.name || act2.who.id || 'console';
    const auditId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
    await env.DB.batch([
      env.DB.prepare('UPDATE record SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE object_id = ? AND id = ?').bind(now, now, me, object.id, id),
      env.DB.prepare('INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(auditId, now, me, act2.role, object.id, id, 'delete', row.data, null),
    ]);
    return ok({ deleted: true, id: id });
  }

  // 審核動作的快路：只改一筆，不必整個物件重新同步（整批同步要重讀整張工作表，慢很多）。
  // 正本還是試算表，這裡只是把剛剛寫進去的那一筆同步過來；夜裡的全量同步會再對一次。
  if (path === 'record-status' && request.method === 'POST') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const b = await request.json().catch(() => ({}));
    const objectId = String(b.object || '');
    const recordId = String(b.id || '');
    if (!objectId || !recordId) return fail('missing_fields');
    const row = await env.DB.prepare('SELECT data FROM record WHERE object_id = ? AND id = ? AND deleted_at IS NULL').bind(objectId, recordId).first();
    if (!row) return fail('not_found', 404);
    const data = Object.assign({}, parse(row.data) || {}, b.patch || {});
    const status = b.status == null ? '' : String(b.status);
    if (status) data.status = status;
    const now = new Date().toISOString();
    const writes = [env.DB.prepare(
      'UPDATE record SET status = ?, data = ?, updated_at = ?, updated_by = ? WHERE object_id = ? AND id = ?'
    ).bind(status, JSON.stringify(data), now, String(b.who || 'console'), objectId, recordId)];
    if (b.audit && b.audit.action) {
      const auditId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
      writes.push(env.DB.prepare(
        'INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(auditId, now, b.who || null, b.audit.role || 'staff', objectId, recordId, String(b.audit.action),
        b.audit.before == null ? null : JSON.stringify(b.audit.before),
        b.audit.after == null ? null : JSON.stringify(b.audit.after)));
    }
    await env.DB.batch(writes);
    return ok({ updated: true, status: status });
  }

  if (path === 'pending') {
    if (role !== 'staff' && role !== 'admin') return fail('forbidden', 403);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('待辦狀態').first();
    const words = String((row && row.value) || '待審核,待確認,待繳費,已回報,已回報匯款,待對帳,待核准,待回覆,待聯絡')
      .split(/[s,，、;；]+/).filter(Boolean);
    const meta = await loadMeta(env);
    const allowed = meta.objects.filter((o) => canList(o, role, who)).map((o) => o.id);
    if (!allowed.length || !words.length) return ok({ words: words, rows: [] });
    const marks = words.map(() => '?').join(',');
    const objMarks = allowed.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      'SELECT object_id, id, title, status, updated_at FROM record WHERE deleted_at IS NULL AND status IN (' + marks + ') AND object_id IN (' + objMarks + ') ORDER BY updated_at DESC LIMIT 300'
    ).bind(...words, ...allowed).all();
    const labels = {};
    meta.objects.forEach((o) => (labels[o.id] = { label: o.label, icon: o.icon }));
    return ok({
      words: words,
      rows: (rows.results || []).map((r) => Object.assign({}, r, labels[r.object_id] || { label: r.object_id, icon: 'rows' })),
    });
  }

  // 點開一筆資料時，把相關的紀錄一起帶出來（例如任務底下的工作進度、參與者、請款、建檔）。
  // 怎麼對上是設定庫決定的（meta_relation 的 match_on），程式不認識任何業務欄位。
  if (path === 'related') {
    const meta = await loadMeta(env);
    const object = meta.objects.find((o) => o.id === body.object);
    if (!object) return fail('object_not_found', 404);
    if (!canList(object, role, who)) return fail('forbidden', 403);
    const row = await env.DB.prepare('SELECT * FROM record WHERE object_id = ? AND id = ? AND deleted_at IS NULL').bind(object.id, String(body.id || '')).first();
    if (!row) return fail('not_found', 404);
    const data = parse(row.data) || {};
    const rels = meta.relations.filter((r) => r.from === object.id && r.match && r.section);
    const out = [];
    for (const rel of rels) {
      const target = meta.objects.find((o) => o.id === rel.to);
      if (!target || !canList(target, role, who)) continue;
      const value = data[rel.match.from];
      if (value == null || value === '') continue;
      const found = await env.DB.prepare(
        "SELECT * FROM record WHERE object_id = ? AND deleted_at IS NULL AND json_extract(data, '$.' || ?) = ? ORDER BY id LIMIT 200"
      ).bind(target.id, rel.match.to, String(value)).all();
      out.push({
        relation: rel.id, section: rel.section, object: target.id, label: target.label, icon: target.icon,
        fields: target.fields.filter((f) => f.inList && f.privacy !== 'secret' && (VISIBLE[role] || VISIBLE.guest).includes(f.privacy)),
        rows: (found.results || []).map((r) => shape(target, r, role)),
      });
    }
    return ok({ object: object.id, id: row.id, sections: out });
  }

  // 設定與文案：給管理台顯示用。保留鍵（__ 開頭）永遠不回傳。
  if (path === 'settings-list') {
    if (role !== 'staff' && role !== 'admin') return fail('forbidden', 403);
    const rows = await env.DB.prepare(
      // 保留鍵（__ 開頭）在下面用 JavaScript 過濾，不要在 SQL 裡用 LIKE：
      // SQL 的底線是萬用字元，'__%' 等於「任何兩個字以上」，NOT LIKE 會把全部排除掉（2026-11-17 踩過）
      'SELECT "key", group_name, type, value, help, variables, sample, sort FROM settings ORDER BY group_name, sort, "key"'
    ).all();
    return ok({ rows: (rows.results || []).filter((r) => String(r.key).indexOf('__') !== 0) });
  }

  // 留痕：Apps Script 做完一個動作後記一筆（要金鑰）；秘書處可以查
  if (path === 'audit') {
    if (request.method === 'POST') {
      if (!(await keyOk(request, env))) return fail('unauthorized', 401);
      const b = await request.json().catch(() => ({}));
      if (!b.action || !b.scope) return fail('missing_fields');
      const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
      await env.DB.prepare(
        'INSERT INTO audit (id, at, who, role, scope, target, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(id, new Date().toISOString(), b.who || null, b.role || null, String(b.scope), b.target || null, String(b.action),
        b.before == null ? null : JSON.stringify(b.before), b.after == null ? null : JSON.stringify(b.after)).run();
      return ok({ id: id });
    }
    if (role !== 'staff' && role !== 'admin') return fail('forbidden', 403);
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const rows = await env.DB.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').bind(limit).all();
    return ok({
      rows: (rows.results || []).map((r) => ({
        id: r.id, at: r.at, who: r.who, role: r.role, scope: r.scope, target: r.target, action: r.action,
        before: parse(r.before_json), after: parse(r.after_json),
      })),
    });
  }

  if (path === 'meta') {
    const meta = await loadMeta(env);
    const objects = meta.objects.filter((o) => canList(o, role, who)).map((o) => ({
      ...o, fields: o.fields.filter((f) => f.privacy !== 'secret' && (VISIBLE[role] || VISIBLE.guest).includes(f.privacy)),
    }));
    const actions = (meta.actions || []).filter((a) => !a.roles.length || a.roles.includes(role));
    // 行政中心的選單預設是秘書處專用；要給別人看就在設定庫寫明 roles
    const seeable = meta.menus.filter((m) => {
      if (m.area !== 'admin') return true;
      const need = (m.roles && m.roles.length) ? m.roles : ['staff', 'admin'];
      return need.indexOf(role) !== -1;
    });
    return ok({ objects, relations: meta.relations, menus: seeable, actions, role });
  }

  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : Object.fromEntries(url.searchParams);

  if (path === 'list' || path === 'get') {
    const meta = await loadMeta(env);
    const object = meta.objects.find((o) => o.id === body.object);
    if (!object) return fail('object_not_found', 404);
    if (!canList(object, role, who)) return fail('forbidden', 403);

    if (path === 'get') {
      if (!body.id) return fail('missing_id');
      const row = await env.DB.prepare('SELECT * FROM record WHERE object_id = ? AND id = ? AND deleted_at IS NULL').bind(object.id, String(body.id)).first();
      if (!row) return fail('not_found', 404);
      return ok({ object: object.id, row: shape(object, row, role) });
    }

    // acl.guestLimit：訪客只拿得到前幾列（例如討論串前 3 則），其餘要登入
    const guestCap = role === 'guest' && Number(object.acl.guestLimit) > 0 ? Number(object.acl.guestLimit) : 0;
    const limit = Math.min(guestCap || 200, Math.max(1, Number(body.limit) || 50));
    const cursor = body.cursor ? String(body.cursor) : null;
    const args = [object.id];
    let where = 'object_id = ? AND deleted_at IS NULL';
    if (body.status) { where += ' AND status = ?'; args.push(String(body.status)); }
    if (cursor) { where += ' AND id > ?'; args.push(cursor); }
    const rows = await env.DB.prepare(`SELECT * FROM record WHERE ${where} ORDER BY id LIMIT ?`).bind(...args, limit + 1).all();
    const got = rows.results || [];
    const more = got.length > limit;
    const page = more ? got.slice(0, limit) : got;
    const out = {
      object: object.id,
      fields: object.fields.filter((f) => f.inList && f.privacy !== 'secret' && (VISIBLE[role] || VISIBLE.guest).includes(f.privacy)),
      rows: page.map((r) => shape(object, r, role)),
      nextCursor: more || guestCap ? (page.length ? page[page.length - 1].id : null) : null,
    };
    const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM record WHERE object_id = ? AND deleted_at IS NULL').bind(object.id).first();
    out.total = all ? all.n : out.rows.length;
    if (Number(object.acl.guestLimit) > 0) out.locked = guestCap > 0 && out.total > out.rows.length; // 還有幾則要登入才看得到
    return ok(out);
  }

  // Apps Script 推資料進來：一次一個物件的整批列。需要 SYNC_KEY。
  if (path === 'sync') {
    if (!(await keyOk(request, env))) return fail('unauthorized', 401);
    const objectId = String(body.object || '').trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!objectId || !rows.length) return fail('missing_fields');
    const exists = await env.DB.prepare('SELECT id FROM meta_object WHERE id = ?').bind(objectId).first();
    if (!exists) return fail('object_not_found', 404);

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(
      `INSERT INTO record (id, object_id, data, status, title, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 'sync', ?, 'sync')
       ON CONFLICT (object_id, id) DO UPDATE SET data = excluded.data, status = excluded.status,
         title = excluded.title, updated_at = excluded.updated_at, updated_by = 'sync', deleted_at = NULL`
    );
    const batch = rows.slice(0, 500).map((r) => stmt.bind(
      String(r.id), objectId, JSON.stringify(r.data || {}),
      r.status == null ? null : String(r.status), r.title == null ? null : String(r.title), now, now
    ));
    if (body.replace) batch.unshift(env.DB.prepare('UPDATE record SET deleted_at = ? WHERE object_id = ? AND deleted_at IS NULL').bind(now, objectId));
    batch.push(env.DB.prepare(
      `INSERT INTO sync_state (object_id, synced_at, rows, source, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (object_id) DO UPDATE SET synced_at = excluded.synced_at, rows = excluded.rows, source = excluded.source, note = excluded.note`
    ).bind(objectId, now, rows.length, String(body.source || 'apps-script'), body.note == null ? null : String(body.note)));
    await env.DB.batch(batch);
    return ok({ object: objectId, written: Math.min(rows.length, 500), at: now });
  }

  return fail('unknown_action', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: JSON_HEADERS });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!env.DB) return fail('no_database', 500, 'Worker 還沒綁定 D1（wrangler.jsonc 的 d1_databases）');
      try {
        return await api(request, env, url);
      } catch (err) {
        return fail('server_error', 500, String(err && err.message ? err.message : err));
      }
    }
    // 其餘交給靜態檔（官網），找不到就回官網的 404
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
