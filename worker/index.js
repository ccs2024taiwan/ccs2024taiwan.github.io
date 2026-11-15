/**
 * 寓委聯 Worker API（Cloudflare Workers ＋ D1）
 *
 * 這支程式不認識「會員」「訂單」是什麼，全部讀設定庫（meta_object／meta_field）運作。
 * 見 docs/系統規範.md 第三部分。
 *
 * 路由（只處理 /api/*，其餘交給靜態檔）：
 *   GET  /api/health            活著嗎、設定庫有幾個物件
 *   GET  /api/meta              物件、欄位、關聯、選單（依 privacy 過濾）
 *   POST /api/list              { object, view, where, limit, cursor }
 *   POST /api/get               { object, id }
 *   POST /api/sync              Apps Script 把工作表推進來（要 SYNC_KEY）
 *
 * 權限：這一版只開放 privacy=public 的欄位給所有人（官網讀取加速用）。
 *       會員／志工／秘書處的身分驗證在下一批接上（沿用 Apps Script 既有的 token）。
 */

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
      required: !!r.required, embed: r.embed, display: parse(r.display),
    })),
    menus: (menus.results || []).map((m) => ({
      id: m.id, area: m.area, parent: m.parent_id, label: m.label, icon: m.icon,
      kind: m.kind, target: m.target, roles: parse(m.roles), badge: m.badge, sort: m.sort,
    })),
  };
}

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } };

// 這一版只有 guest；之後接上 token 會回傳 member／volunteer／staff／admin
function roleOf() { return 'guest'; }

const VISIBLE = { guest: ['public'], member: ['public', 'member'], volunteer: ['public', 'member'], staff: ['public', 'member', 'staff'], admin: ['public', 'member', 'staff'] };

function canList(object, role) {
  const allow = (object.acl && object.acl.list) || [];
  return role === 'admin' || allow.includes(role) || (role === 'guest' && allow.includes('guest'));
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

// ── 路由 ────────────────────────────────────────────────
async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const role = roleOf();

  if (path === 'health') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM meta_object').first();
    const s = await env.DB.prepare('SELECT COUNT(*) AS n FROM record WHERE deleted_at IS NULL').first();
    return ok({ service: 'ccs-worker', objects: r ? r.n : 0, records: s ? s.n : 0, at: new Date().toISOString() });
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

    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
    const cursor = body.cursor ? String(body.cursor) : null;
    const args = [object.id];
    let where = 'object_id = ? AND deleted_at IS NULL';
    if (body.status) { where += ' AND status = ?'; args.push(String(body.status)); }
    if (cursor) { where += ' AND id > ?'; args.push(cursor); }
    const rows = await env.DB.prepare(`SELECT * FROM record WHERE ${where} ORDER BY id LIMIT ?`).bind(...args, limit + 1).all();
    const got = rows.results || [];
    const more = got.length > limit;
    const page = more ? got.slice(0, limit) : got;
    return ok({
      object: object.id,
      fields: object.fields.filter((f) => f.inList && f.privacy !== 'secret' && (VISIBLE[role] || VISIBLE.guest).includes(f.privacy)),
      rows: page.map((r) => shape(object, r, role)),
      nextCursor: more ? page[page.length - 1].id : null,
    });
  }

  // Apps Script 推資料進來：一次一個物件的整批列。需要 SYNC_KEY。
  if (path === 'sync') {
    const key = request.headers.get('authorization') || '';
    if (!env.SYNC_KEY || key !== 'Bearer ' + env.SYNC_KEY) return fail('unauthorized', 401);
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
