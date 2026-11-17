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
  const [objects, fields, relations, menus] = await Promise.all([
    env.DB.prepare("SELECT * FROM meta_object WHERE status = 'active' ORDER BY sort, id").all(),
    env.DB.prepare('SELECT * FROM meta_field ORDER BY object_id, sort').all(),
    env.DB.prepare('SELECT * FROM meta_relation').all(),
    env.DB.prepare('SELECT * FROM meta_menu WHERE visible = 1 ORDER BY area, sort').all(),
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
  ['meta_field', 'meta_relation', 'meta_menu', 'meta_object'].forEach((t) => batch.push(env.DB.prepare('DELETE FROM ' + t)));
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

// 通行證 → 角色。VOL: 開頭是志工，其餘是會員編號；在「管理員會員編號」名單裡的再升級為秘書處。
async function roleOf(request, env) {
  const data = await readToken(request, env);
  if (!data) return { role: 'guest' };
  const id = String(data.id || '');
  const volunteer = id.indexOf('VOL:') === 0;
  const who = { role: volunteer ? 'volunteer' : 'member', id: volunteer ? id.slice(4) : id, name: data.name || '', suspended: !!data.s };
  if (who.suspended) return who; // 停權會員只剩繳費，資料一律不給
  const row = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('管理員會員編號').first();
  const admins = String((row && row.value) || '').split(/[\s,，、;；]+/).filter(Boolean).map((x) => x.toUpperCase());
  if (!volunteer && admins.indexOf(who.id.toUpperCase()) !== -1) who.role = 'staff';
  return who;
}

const VISIBLE = { guest: ['public'], member: ['public', 'member'], volunteer: ['public', 'member'], staff: ['public', 'member', 'staff'], admin: ['public', 'member', 'staff'] };

// 身分的涵蓋範圍：登入的人至少看得到訪客看得到的東西；秘書處涵蓋會員與志工。
const COVERS = {
  guest: ['guest'],
  member: ['guest', 'member'],
  volunteer: ['guest', 'volunteer'],
  staff: ['guest', 'member', 'volunteer', 'staff'],
  admin: ['guest', 'member', 'volunteer', 'staff', 'admin'],
};

function canList(object, role) {
  if (role === 'admin') return true;
  const allow = (object.acl && object.acl.list) || [];
  const mine = COVERS[role] || COVERS.guest;
  return allow.some((r) => mine.indexOf(r) !== -1);
}

// 依角色把看不到的欄位拿掉；secret 永遠不回傳
function shape(object, row, role) {
  const data = parse(row.data) || {};
  const seen = VISIBLE[role] || VISIBLE.guest;
  const out = {};
  object.fields.forEach((f) => {
    if (f.privacy === 'secret') return;
    if (!seen.includes(f.privacy)) return;
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
    // 登入搬到 Worker 之後也要用它比對末三碼。保護靠的是「誰讀得到」：secret 欄位任何角色、任何 API 都拿不到（見 shape()）。
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
      canList: meta.objects.filter((o) => canList(o, who.role)).map((o) => o.id),
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
    const mine = meta.objects.filter((o) => canList(o, role));
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
  if (path === 'pending') {
    if (role !== 'staff' && role !== 'admin') return fail('forbidden', 403);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE "key" = ?').bind('待辦狀態').first();
    const words = String((row && row.value) || '待審核,待確認,待繳費,已回報,已回報匯款,待對帳,待核准,待回覆,待聯絡')
      .split(/[s,，、;；]+/).filter(Boolean);
    const meta = await loadMeta(env);
    const allowed = meta.objects.filter((o) => canList(o, role)).map((o) => o.id);
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
    if (!canList(object, role)) return fail('forbidden', 403);
    const row = await env.DB.prepare('SELECT * FROM record WHERE object_id = ? AND id = ? AND deleted_at IS NULL').bind(object.id, String(body.id || '')).first();
    if (!row) return fail('not_found', 404);
    const data = parse(row.data) || {};
    const rels = meta.relations.filter((r) => r.from === object.id && r.match && r.section);
    const out = [];
    for (const rel of rels) {
      const target = meta.objects.find((o) => o.id === rel.to);
      if (!target || !canList(target, role)) continue;
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
    const objects = meta.objects.filter((o) => canList(o, role)).map((o) => ({
      ...o, fields: o.fields.filter((f) => f.privacy !== 'secret' && (VISIBLE[role] || VISIBLE.guest).includes(f.privacy)),
    }));
    return ok({ objects, relations: meta.relations, menus: meta.menus, role });
  }

  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : Object.fromEntries(url.searchParams);

  if (path === 'list' || path === 'get') {
    const meta = await loadMeta(env);
    const object = meta.objects.find((o) => o.id === body.object);
    if (!object) return fail('object_not_found', 404);
    if (!canList(object, role)) return fail('forbidden', 403);

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
