/**
 * 寓委聯管理台。
 *
 * 這支程式不認識「會員」「訂單」是什麼：畫面上有哪些項目、每個項目有哪些欄位，
 * 全部是向 /api/meta 問來的（設定庫）。要讓管理台多管一種資料，是改 worker/meta.mjs，不是改這裡。
 *
 * 登入沿用官網那一套（會員編號＋手機末三碼 → Apps Script 發通行證），
 * 之後拿同一張通行證去問 D1，由「設定」工作表的〈管理員會員編號〉決定是不是秘書處。
 */

const API_URL = 'https://script.google.com/macros/s/AKfycbxigcc2shJfw4vbTUrbdPv-qwj6EWj-BWc076FtN6YJxhhx78l6lcJ7yMKwaXWet1NbXA/exec';
const DB_URL = 'https://ccs.ccs2024taiwan.workers.dev';
const KEY = 'ccs-console';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + (name || 'rows'));
  svg.append(use);
  return svg;
};
const fmtDate = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');

const session = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } },
  set(v) { localStorage.setItem(KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(KEY); },
};

const db = async (path, body) => {
  const s = session.get();
  const headers = { 'content-type': 'application/json' };
  if (s && s.token) headers.authorization = 'Bearer ' + s.token;
  const res = await fetch(DB_URL + '/api/' + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  return res.json();
};

const appsScript = async (payload) => {
  // 與官網 script.js 相同：用 text/plain 送，才不會觸發 Apps Script 擋掉的預檢請求
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  return res.json();
};

// ── 登入 ────────────────────────────────────────────────
const errors = {
  invalid_credentials: '會員編號或手機末三碼不對。',
  locked: '連續輸入錯誤太多次，請稍後再試。',
  suspended: '你的會籍目前停權中，無法使用管理台。',
};

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = $('loginBtn');
  const err = $('loginErr');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = '登入中…';
  let step = '準備送出';
  try {
    step = '連線到 Apps Script';
    const result = await appsScript({ action: 'login', memberId: $('mid').value.trim(), phone: $('mpw').value.trim() });
    step = '檢查登入結果';
    if (!result || typeof result !== 'object') throw new Error('後端回傳的不是預期的格式');
    if (!result.ok) throw new Error(errors[result.error] || ('登入失敗（' + (result.error || '沒有錯誤代碼') + '）'));
    if (!result.token) throw new Error('後端沒有給通行證，請通知管理員');
    session.set({ token: result.token, member: result.member });
    step = '向官網資料庫確認身分';
    const me = await db('me');
    if (!me || !me.ok) { session.clear(); throw new Error('官網資料庫沒有回應身分：' + ((me && (me.message || me.error)) || '未知原因')); }
    if (me.role !== 'staff' && me.role !== 'admin') {
      const who = me.role === 'member' ? '一般會員' : me.role === 'volunteer' ? '志工' : me.role;
      session.clear();
      throw new Error('你目前的身分是「' + who + '」，不是秘書處管理員，所以進不了管理台。請在試算表「設定」的〈管理員會員編號〉加上 ' + ($('mid').value.trim() || '你的編號') + '，再按一次選單「同步：更新設定庫」。');
    }
    step = '載入管理台';
    await start(me);
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    err.textContent = detail.indexOf('登入') === 0 || detail.indexOf('你目前') === 0 ? detail : '在「' + step + '」這一步出錯：' + detail;
    console.error('[管理台] 登入失敗，步驟：' + step, e);
  } finally {
    btn.disabled = false;
    btn.textContent = '登入';
  }
});
$('logout').addEventListener('click', () => { session.clear(); location.reload(); });

// ── 啟動 ────────────────────────────────────────────────
let META = null;
let STATS = null;
let ME = null;
let current = null;
let PENDING_COUNT = null;

async function start(me) {
  ME = me;
  const [meta, stats, pending] = await Promise.all([db('meta'), db('stats'), db('pending').catch(() => null)]);
  META = meta;
  STATS = stats;
  PENDING_COUNT = pending && pending.ok ? pending.rows.length : null;
  if (!META || !META.ok) throw new Error('讀不到設定庫：' + ((META && (META.message || META.error)) || '未知原因'));
  $('gate').hidden = true;
  $('app').hidden = false;
  window.scrollTo(0, 0);
  const s = session.get();
  const name = (s && s.member && s.member.name) || me.name || me.id || '';
  $('whoName').textContent = name + '　·　' + (me.role === 'admin' ? '系統管理員' : '秘書處');
  $('whoInitial').textContent = name.slice(0, 1) || '·';
  $('dbInfo').textContent = '官網資料庫　' + (STATS.ok ? STATS.totalRecords + ' 筆' : '讀取失敗');
  buildNav();
  go(location.hash.slice(1) || 'dash');
}

function showError(message) {
  $('main').replaceChildren(el('p', 'err', message));
}

// 左欄完全由設定庫的選單決定（meta_menu 的 area=admin）。主項目一行；有子項目的會收起來，點一下展開。
// 子項目不會另外佔一行 —— 像「工作進度」是點開某個任務之後才出現的段落，不是左欄項目。
let OPEN_GROUP = null;
function buildNav() {
  const list = $('navList');
  list.replaceChildren();
  const countOf = (id) => {
    const found = STATS.ok ? STATS.objects.find((o) => o.id === id) : null;
    return found ? found.count : null;
  };
  const visible = (m) => !m.roles || !m.roles.length || m.roles.indexOf(ME.role) !== -1;
  const parentOf = (m) => m.parent || m.parent_id || null; // Worker 回傳的是 parent，設定庫裡寫 parent_id
  const admin = (META.menus || []).filter((m) => m.area === 'admin' && visible(m)).sort((x, y) => (x.sort || 0) - (y.sort || 0));
  const keyOf = (m) => {
    if (m.kind === 'object') return 'o:' + m.target;
    if (m.target === 'dashboard') return 'dash';
    return m.target;
  };
  const item = (m, sub) => {
    if (m.kind === 'object' && !(META.objects || []).some((o) => o.id === m.target)) return;
    const key = keyOf(m);
    const b = el('button', 'nav' + (sub ? ' sub' : ''));
    b.type = 'button';
    b.dataset.key = key;
    b.append(icon(m.icon), el('span', '', m.label));
    const n = m.kind === 'object' ? countOf(m.target) : key === 'approvals' ? PENDING_COUNT : null;
    if (n != null) b.append(el('span', 'n', String(n)));
    b.addEventListener('click', () => go(key));
    list.append(b);
  };
  const group = (g, kids) => {
    const b = el('button', 'nav group' + (OPEN_GROUP === g.id ? ' open' : ''));
    b.type = 'button';
    b.dataset.group = g.id;
    b.append(icon(g.icon), el('span', '', g.label), el('span', 'caret', OPEN_GROUP === g.id ? '－' : '＋'));
    b.addEventListener('click', () => { OPEN_GROUP = OPEN_GROUP === g.id ? null : g.id; buildNav(); });
    list.append(b);
    if (OPEN_GROUP === g.id) kids.forEach((k) => item(k, true));
  };
  admin.filter((m) => !parentOf(m)).forEach((m) => {
    if (m.kind === 'group') {
      const kids = admin.filter((k) => parentOf(k) === m.id);
      if (kids.length) group(m, kids); // 一個子項目都看不到的群組就不要顯示，免得點了沒反應
    }
    else item(m, false);
  });
  document.querySelectorAll('.nav').forEach((x) => x.classList.toggle('on', Boolean(x.dataset.key) && x.dataset.key === current));
}
function go(key) {
  current = key;
  location.hash = key;
  if (META && META.menus) {
    const hit = META.menus.find((m) => m.area === 'admin' && (m.parent || m.parent_id) && (m.kind === 'object' ? 'o:' + m.target : m.target === 'dashboard' ? 'dash' : m.target) === key);
    const owner = hit ? (hit.parent || hit.parent_id) : null;
    if (owner && OPEN_GROUP !== owner) { OPEN_GROUP = owner; buildNav(); }
  }
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.key === key));
  $('q').value = '';
  if (key === 'dash') return viewDash();
  if (key === 'setup') return viewSetup();
  if (key === 'sync') return viewSync();
  if (key === 'approvals') return viewApprovals();
  if (key === 'line') return viewSoon('LINE 小幫手', '指令一覽與自動回應的文案會在這裡設定：每個指令可以改觸發詞、回應文字，也能單獨關掉某個指令先停用。資料表已經在設定庫裡（line_command），畫面在下一批加上。');
  if (key === 'connections') return viewSoon('連線', '藍新金流、LINE 官方帳號、Telegram、Google、MCP 的金鑰會在這裡設定。存進去只會顯示末四碼，每個連線都有「測試連線」與「複製 Webhook 網址」。畫面在下一批加上。');
  if (key.indexOf('soon:') === 0) { const p = key.split(':'); return viewSoon(p[1], p.slice(2).join(':')); }
  if (key === 'audit') return viewAudit();
  if (key === 'audit_old') return viewSoon('留痕', '誰在什麼時候改了什麼，連改前改後都留著，刪掉的東西可以還原。要等管理台開放「寫入」之後才會有內容，和寫入功能同一批。');
  if (key.indexOf('o:') === 0) return viewObject(key.slice(2));
  viewDash();
}

// ── 儀表板 ──────────────────────────────────────────────
function viewDash() {
  $('crumb').textContent = '儀表板';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  box.append(el('h1', 'page', '儀表板'), el('p', '', new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })));
  head.append(box);
  main.append(head);

  if (!STATS.ok) return main.append(el('p', 'err', '讀不到統計：' + (STATS.message || STATS.error)));
  const withData = STATS.objects.filter((o) => o.count > 0).sort((a, b) => b.count - a.count);
  const tiles = el('div', 'tiles');
  withData.slice(0, 4).forEach((o) => {
    const t = el('div', 'tile');
    const k = el('span', 'k');
    k.append(icon(o.icon), el('span', '', o.label));
    t.append(k, el('span', 'v', String(o.count)), el('span', 's', o.sync ? '同步於 ' + fmtDate(o.sync.at) : '尚未同步'));
    t.addEventListener('click', () => go('o:' + o.id));
    t.style.cursor = 'pointer';
    tiles.append(t);
  });
  main.append(tiles);

  const panel = el('div', 'sheet');
  panel.style.borderRadius = 'var(--r)';
  panel.append(hint('這些數字來自官網資料庫（D1）。資料由試算表每天自動同步，也可以在試算表按「同步：立刻同步到官網資料庫」手動更新。'));
  const table = el('table');
  table.append(headerRow(['資料', '筆數', '最近同步', '來源']));
  const body = el('tbody');
  STATS.objects.forEach((o) => {
    const tr = el('tr');
    const first = el('td');
    const wrap = el('span');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '8px';
    const ic = icon(o.icon);
    ic.style.width = '15px';
    ic.style.height = '15px';
    ic.style.color = 'var(--faint)';
    wrap.append(ic, el('span', '', o.label));
    first.append(wrap);
    const count = el('td', 'num mono', String(o.count));
    const at = el('td', 'mono', o.sync ? fmtDate(o.sync.at) : '—');
    const src = el('td');
    src.append(o.sync ? el('span', 'tag plain', o.sync.source) : el('span', 'tag', '尚未同步'));
    tr.append(first, count, at, src);
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => go('o:' + o.id));
    body.append(tr);
  });
  table.append(body);
  const tw = el('div', 'tw');
  tw.append(table);
  panel.append(tw);
  main.append(panel);
}

const hint = (text) => {
  const p = el('p', 'hint');
  p.append(icon('info'), el('span', '', text));
  return p;
};
const headerRow = (labels) => {
  const thead = el('thead');
  const tr = el('tr');
  labels.forEach((l, i) => {
    const th = el('th', i > 0 && /筆數|金額|數量/.test(l) ? 'num' : '', l);
    tr.append(th);
  });
  thead.append(tr);
  return thead;
};

// ── 任一物件的列表（欄位全部來自設定庫）────────────────────
// 任一物件的列表。欄位、權限、要顯示哪幾欄全部來自設定庫；
// 資料多的時候先載入前 200 筆，按「載入更多」再接下去（日記帳這類會越長越多）。
async function viewObject(objectId) {
  const obj = (META.objects || []).find((o) => o.id === objectId);
  const main = $('main');
  main.replaceChildren();
  if (!obj) return showError('設定庫裡沒有這個項目：' + objectId);
  $('crumb').textContent = '資料 › ' + obj.label;

  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', obj.label), info);
  head.append(box, el('span', 'sp'));
  main.append(head);

  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);

  const rows = [];
  let cols = null;
  let cursor = null;
  let total = null;
  const tw = el('div', 'tw');
  const table = el('table');
  const body = el('tbody');
  const moreBox = el('div');
  moreBox.style.marginTop = '12px';

  const cellOf = (r, f, i) => {
    const raw = r.data[f.key];
    const text = raw == null ? '' : Array.isArray(raw) ? raw.length + ' 項' : typeof raw === 'object' ? JSON.stringify(raw).slice(0, 40) : String(raw);
    const kind = /date|datetime/.test(f.type) || i === 0 ? 'mono' : /money|number/.test(f.type) ? 'num mono' : /textarea|text/.test(f.type) ? 'wrap-ok' : '';
    return el('td', kind, text);
  };

  const paint = (keyword) => {
    body.replaceChildren();
    const lower = String(keyword || '').trim().toLowerCase();
    const shown = lower
      ? rows.filter((r) => JSON.stringify(r.data).toLowerCase().indexOf(lower) !== -1 || String(r.id).toLowerCase().indexOf(lower) !== -1)
      : rows;
    shown.forEach((r) => {
      const tr = el('tr');
      cols.forEach((f, i) => tr.append(cellOf(r, f, i)));
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openDrawer(obj, r));
      body.append(tr);
    });
    if (!shown.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '沒有符合的資料');
      td.colSpan = cols.length;
      tr.append(td);
      body.append(tr);
    }
    info.textContent = (total != null ? total + ' 筆' : rows.length + ' 筆')
      + (total != null && rows.length < total ? '（已載入 ' + rows.length + '）' : '')
      + (lower ? '　·　符合「' + keyword + '」' + shown.length + ' 筆' : '')
      + '　·　' + obj.fields.length + ' 個欄位';
  };

  const loadMore = async () => {
    const result = await db('list', { object: objectId, limit: 200, cursor: cursor });
    if (!result.ok) { sheet.replaceChildren(el('p', 'err', '讀不到：' + (result.message || result.error))); return; }
    if (!cols) {
      cols = (result.fields && result.fields.length ? result.fields : obj.fields.slice(0, 6));
      table.append(headerRow(cols.map((f) => f.label)));
      table.append(body);
      tw.append(table);
      sheet.replaceChildren(tw, moreBox);
    }
    rows.push.apply(rows, result.rows);
    cursor = result.nextCursor;
    total = result.total != null ? result.total : rows.length;
    paint($('q').value);
    moreBox.replaceChildren();
    if (cursor && rows.length < total) {
      const more = el('button', 'btn');
      more.type = 'button';
      more.textContent = '載入更多（還有 ' + (total - rows.length) + ' 筆）';
      more.addEventListener('click', async () => { more.disabled = true; more.textContent = '載入中…'; await loadMore(); });
      moreBox.append(more);
    } else if (rows.length) {
      moreBox.append(hint('全部 ' + rows.length + ' 筆都載入了。點任何一列可以看完整內容與相關紀錄。'));
    }
    if (!rows.length) {
      sheet.replaceChildren(el('div', 'empty', '這個項目還沒有資料。試算表那邊同步過來之後就會出現。'));
      info.textContent = '0 筆';
    }
  };

  sheet.append(el('p', 'hint', '讀取中…'));
  await loadMore();
  $('q').oninput = () => { if (current === 'o:' + objectId && cols) paint($('q').value); };
}
const PRIVACY = { public: ['公開', 'pub'], member: ['登入後', 'mem'], staff: ['秘書處', 'stf'], secret: ['只比對', 'sec'] };

// 明細抽屜：從右邊滑出，蓋在列表上，所以表格可以用滿整個寬度
let drawerEls = null;
function ensureDrawer() {
  if (drawerEls) return drawerEls;
  const scrim = el('div', 'scrim');
  const drawer = el('div', 'drawer');
  const top = el('div', 'top');
  const title = el('h3');
  const close = el('button', 'btn quiet');
  close.type = 'button';
  close.textContent = '關閉';
  const body = el('div', 'body');
  top.append(title, close);
  drawer.append(top, body);
  document.body.append(scrim, drawer);
  const hide = () => { scrim.classList.remove('on'); drawer.classList.remove('on'); };
  scrim.addEventListener('click', hide);
  close.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  drawerEls = { scrim, drawer, title, body, hide };
  return drawerEls;
}

function openDrawer(obj, row) {
  const d = ensureDrawer();
  d.title.replaceChildren(el('span', '', String(row.title || row.id)));
  d.body.replaceChildren();
  showDetail(obj, row, d.body);
  d.scrim.classList.add('on');
  d.drawer.classList.add('on');
  d.body.scrollTop = 0;
}

function showDetail(obj, row, box) {
  if (!row) return;
  obj.fields.forEach((f) => {
    const value = row.data[f.key];
    if (value == null || value === '') return;
    const fld = el('div', 'fld');
    const label = el('label');
    label.append(el('span', '', f.label));
    const p = PRIVACY[f.privacy];
    if (p) label.append(el('span', 'chip ' + p[1], p[0]));
    if (f.lockAfter && f.lockAfter.mode && f.lockAfter.mode !== 'open') label.append(el('span', 'chip', { locked: '鎖住', tracked: '留紀錄', append: '只能補', reverse_only: '只能沖銷' }[f.lockAfter.mode] || f.lockAfter.mode));
    const v = el('div', 'v');
    if (Array.isArray(value)) {
      v.style.display = 'block';
      value.slice(0, 12).forEach((x) => v.append(el('div', '', typeof x === 'object' ? (x.name ? x.name + '：' + (x.text || '') : JSON.stringify(x)) : String(x))));
      if (value.length > 12) v.append(el('div', '', '…共 ' + value.length + ' 項'));
    } else if (typeof value === 'object') {
      v.textContent = JSON.stringify(value);
    } else {
      v.textContent = String(value);
    }
    fld.append(label, v);
    box.append(fld);
  });
  const foot = el('p', 'hint');
  foot.append(icon('info'), el('span', '', '這一版只能看。修改、簽核與留痕會在下一批加上。'));
  box.append(foot);
  loadRelated(obj, row, box);
}

// 相關紀錄：哪些資料要跟著帶出來、用哪個欄位對上，都是設定庫決定的
async function loadRelated(obj, row, box) {
  const holder = el('div');
  box.append(holder);
  const result = await db('related', { object: obj.id, id: row.id });
  if (!result.ok || !result.sections || !result.sections.length) return;
  result.sections.forEach((sec) => {
    if (!sec.rows.length) return;
    const h = el('h3', '', '');
    h.style.margin = '14px 0 6px';
    h.style.fontSize = '13.5px';
    h.append(icon(sec.icon), el('span', '', sec.section + '（' + sec.rows.length + '）'));
    holder.append(h);
    const cols = sec.fields.length ? sec.fields.slice(0, 4) : [{ key: 'title', label: '內容' }];
    holder.append(tableOf(cols.map((f) => f.label), sec.rows.slice(0, 20).map((r) => cols.map((f) => {
      const v = r.data ? r.data[f.key] : '';
      return v == null ? '' : Array.isArray(v) ? v.length + ' 項' : String(v);
    }))));
    if (sec.rows.length > 20) holder.append(el('p', 'hint', '…共 ' + sec.rows.length + ' 筆'));
  });
}

// ── 系統設定（唯讀）────────────────────────────────────
function viewSetup() {
  $('crumb').textContent = '設定 › 系統設定';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  box.append(el('h1', 'page', '系統設定'), el('p', '', '這些定義放在 worker/meta.mjs，改過之後在試算表按「同步：更新設定庫」就生效'));
  head.append(box);
  main.append(head);

  const tabs = el('div', 'tabs');
  const sheet = el('div', 'sheet');
  const panes = {
    objects: () => tableOf(['代號', '名稱', '編號規則', '資料來源', '欄位數', '狀態'], META.objects.map((o) => [
      mono(o.id), o.label, mono(o.idRule || '—'), sourceText(o.source), String(o.fields.length), tagOf('ok', '使用中'),
    ])),
    fields: () => {
      const wrap = el('div');
      wrap.append(hint('「隱私」決定誰看得到：公開＝官網、登入後＝會員、秘書處＝只有管理台、只比對＝任何畫面都拿不到。「核准後」決定單據過了某個狀態還能不能改。'));
      META.objects.forEach((o) => {
        wrap.append(el('h3', '', o.label));
        wrap.append(tableOf(['代號', '名稱', '型別', '必填', '隱私', '核准後', '列表'], o.fields.map((f) => [
          mono(f.key), f.label, tagOf('plain', f.type), f.required ? '✓' : '—',
          chipOf(f.privacy), f.lockAfter && f.lockAfter.mode ? tagOf(f.lockAfter.mode === 'locked' ? 'alert' : 'plain', { locked: '鎖住', tracked: '留紀錄', append: '只能補', reverse_only: '只能沖銷', open: '可改' }[f.lockAfter.mode] || f.lockAfter.mode) : tagOf('plain', '可改'),
          f.inList ? '✓' : '—',
        ])));
      });
      return wrap;
    },
    relations: () => tableOf(['代號', '來源', '目標', '種類', '子表或獨立', '刪除時'], (META.relations || []).map((r) => [
      mono(r.id), labelOf(r.from), labelOf(r.to), r.kind,
      tagOf(r.embed === 'child' ? 'info' : 'plain', r.embed === 'child' ? '子表' : '獨立'),
      { restrict: '不准刪', cascade: '一起刪', set_null: '留空' }[r.onDelete] || r.onDelete,
    ])),
    menus: () => {
      const wrap = el('div');
      wrap.append(hint('一張表管五個地方：官網頂部、會員專區、志工專區、管理台左欄、LINE 圖文選單。'));
      const areas = { site: '官網頂部', portal: '會員專區', volunteer: '志工專區', admin: '管理台左欄', line: 'LINE 圖文選單' };
      Object.keys(areas).forEach((area) => {
        const rows = (META.menus || []).filter((m) => m.area === area);
        if (!rows.length) return;
        wrap.append(el('h3', '', areas[area]));
        wrap.append(tableOf(['名稱', '種類', '指向', '誰看得到'], rows.map((m) => [
          m.label, { page: '頁面', object: '資料', view: '檢視', url: '外部連結', action: '動作' }[m.kind] || m.kind,
          mono(m.target || '—'), (m.roles && m.roles.length ? m.roles.join('、') : '所有人'),
        ])));
      });
      return wrap;
    },
  };
  panes.settings = () => {
    const wrap = el('div');
    wrap.append(hint('這些是「換個值就好」的設定：文案、天數、金額門檻、開關。改了按儲存，會寫回試算表的「設定」工作表並同步到這裡，同時留下紀錄。'));
    const holder = el('div');
    wrap.append(holder);
    db('settings-list').then((result) => {
      holder.replaceChildren();
      if (!result.ok) return holder.append(el('p', 'err', '讀不到：' + (result.message || result.error)));
      const groups = {};
      const order = [];
      result.rows.forEach((r) => {
        const g = r.group_name || '一般';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(r);
      });
      order.forEach((g) => {
        const h = el('h3', '', g);
        h.style.margin = '18px 0 8px';
        h.style.fontSize = '14px';
        holder.append(h);
        groups[g].forEach((r) => holder.append(settingRow(r)));
      });
    });
    return wrap;
  };
  const names = { objects: ['物件', 'cube'], fields: ['欄位', 'rows'], relations: ['關聯', 'link'], menus: ['選單', 'menu'], settings: ['設定與文案', 'gear'] };
  Object.keys(panes).forEach((key, i) => {
    const b = el('button', 'tab' + (i ? '' : ' on'));
    b.type = 'button';
    b.append(icon(names[key][1]), el('span', '', names[key][0]));
    b.addEventListener('click', () => {
      tabs.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
      sheet.replaceChildren(panes[key]());
    });
    tabs.append(b);
  });
  sheet.replaceChildren(panes.objects());
  main.append(tabs, sheet);
}

const mono = (text) => { const s = el('span', 'mono', text); return s; };
const tagOf = (kind, text) => el('span', 'tag ' + kind, text);
const chipOf = (privacy) => {
  const p = PRIVACY[privacy];
  return p ? el('span', 'chip ' + p[1], p[0]) : el('span', 'chip', privacy || '');
};
const labelOf = (objectId) => {
  const o = (META.objects || []).find((x) => x.id === objectId);
  return o ? o.label : objectId;
};
const sourceText = (source) => {
  if (!source || source === 'd1') return '資料庫';
  if (source.indexOf('sheet:') === 0) return '試算表：' + source.slice(6);
  if (source.indexOf('compute:') === 0) return '程式計算';
  return source;
};

function tableOf(headers, rows) {
  const tw = el('div', 'tw');
  const table = el('table');
  table.append(headerRow(headers));
  const body = el('tbody');
  rows.forEach((cells) => {
    const tr = el('tr');
    cells.forEach((c) => {
      const td = el('td');
      if (c instanceof Node) td.append(c);
      else td.textContent = c == null ? '' : String(c);
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  tw.append(table);
  return tw;
}

// ── 同步狀態 ────────────────────────────────────────────
async function viewSync() {
  $('crumb').textContent = '設定 › 同步狀態';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  box.append(el('h1', 'page', '同步狀態'), el('p', '', '試算表 → 官網資料庫。方向只有一個，資料庫是鏡像'));
  head.append(box);
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  sheet.append(hint('每天早上自動同步一次。要立刻更新，到試算表按「同步：立刻同步到官網資料庫」。'));
  const fresh = await db('stats');
  STATS = fresh;
  if (!fresh.ok) { sheet.append(el('p', 'err', '讀不到：' + (fresh.message || fresh.error))); main.append(sheet); return; }
  sheet.append(tableOf(['資料', '筆數', '最近同步', '來源'], fresh.objects.map((o) => [
    o.label, el('span', 'num mono', String(o.count)), mono(o.sync ? fmtDate(o.sync.at) : '—'),
    o.sync ? o.sync.source : tagOf('plain', '尚未同步'),
  ])));
  main.append(sheet);
}

// ── 開場：已經登入過就直接進去 ──────────────────────────
(async () => {
  const s = session.get();
  if (!s || !s.token) return;
  const me = await db('me').catch(() => null);
  if (me && me.ok && (me.role === 'staff' || me.role === 'admin')) start(me);
  else session.clear();
})();

// ── 申請審核：所有還沒處理的申請集中在這裡 ──────────────
async function viewApprovals() {
  $('crumb').textContent = '工作 › 申請審核';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const sub = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '申請審核'), sub);
  head.append(box);
  main.append(head);

  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  const result = await db('pending');
  if (!result.ok) { sub.textContent = ''; sheet.append(el('p', 'err', '讀不到：' + (result.message || result.error))); return; }
  PENDING_COUNT = result.rows.length;
  buildNav();
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.key === 'approvals'));
  sub.textContent = result.rows.length + ' 件等著處理';
  sheet.append(hint('這裡集中所有「還沒處理完」的申請。判斷依據是狀態欄的字詞，清單放在試算表「設定」的〈待辦狀態〉，你可以自己增減，不用改程式。目前認的是：' + result.words.join('、')));
  if (!result.rows.length) { sheet.append(el('div', 'empty', '目前沒有待處理的申請。')); return; }

  const byKind = {};
  result.rows.forEach((r) => { (byKind[r.object_id] = byKind[r.object_id] || []).push(r); });
  Object.keys(byKind).forEach((objectId) => {
    const rows = byKind[objectId];
    const title = el('h3', '', rows[0].label + '（' + rows.length + '）');
    title.style.margin = '18px 0 8px';
    title.style.fontSize = '14px';
    sheet.append(title);
    const table = tableOf(['編號', '內容', '狀態', '最後更新'], rows.map((r) => [
      mono(r.id), r.title || '', tagOf('warn', r.status || ''), mono(fmtDate(r.updated_at)),
    ]));
    // 點一列就從右邊滑出完整內容，跟各資料頁一樣
    Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openById(rows[i].object_id, rows[i].id));
    });
    sheet.append(table);
    const go2 = el('button', 'btn quiet');
    go2.type = 'button';
    go2.append(el('span', '', '到「' + rows[0].label + '」看全部'));
    go2.addEventListener('click', () => go('o:' + objectId));
    sheet.append(go2);
  });
}

// 由物件代號與編號開啟抽屜（申請審核那類「跨物件的清單」會用到）
async function openById(objectId, id) {
  const obj = (META.objects || []).find((o) => o.id === objectId);
  if (!obj) return;
  const result = await db('get', { object: objectId, id: id });
  if (result.ok && result.row) openDrawer(obj, result.row);
}

// 還沒做的頁面：老實說明會有什麼，不要給一個壞掉的畫面
function viewSoon(title, what) {
  $('crumb').textContent = title;
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  box.append(el('h1', 'page', title), el('p', '', '下一批'));
  head.append(box);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  sheet.append(hint(what));
  main.append(head, sheet);
}

// 一列設定：長文用多行框，其餘用單行；改了才會出現儲存按鈕
function settingRow(r) {
  const box = el('div', 'fld');
  box.style.marginBottom = '12px';
  const label = el('label');
  label.append(el('span', '', r.key));
  if (r.type) label.append(el('span', 'chip', r.type === 'template' ? '文案' : r.type));
  box.append(label);
  const long = r.type === 'template' || r.type === 'textarea' || String(r.value || '').length > 60 || String(r.value || '').indexOf('\n') !== -1;
  const input = el(long ? 'textarea' : 'input');
  input.value = r.value == null ? '' : String(r.value);
  if (long) input.rows = Math.min(10, Math.max(3, input.value.split('\n').length + 1));
  input.style.cssText = 'font:inherit;font-size:13.5px;line-height:1.7;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);width:100%;resize:vertical';
  box.append(input);
  if (r.help) box.append(el('small', '', r.help)).style.cssText = 'color:var(--muted);font-size:12px;line-height:1.6';
  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px';
  bar.hidden = true;
  const save = el('button', 'btn pri');
  save.type = 'button';
  save.textContent = '儲存';
  const cancel = el('button', 'btn quiet');
  cancel.type = 'button';
  cancel.textContent = '取消';
  const note = el('span', '', '');
  note.style.cssText = 'font-size:12.5px;color:var(--muted)';
  bar.append(save, cancel, note);
  box.append(bar);
  const original = input.value;
  input.addEventListener('input', () => { bar.hidden = input.value === original; note.textContent = ''; });
  cancel.addEventListener('click', () => { input.value = original; bar.hidden = true; });
  save.addEventListener('click', async () => {
    save.disabled = true;
    note.textContent = '儲存中…';
    const session = sessionStorageToken();
    const result = await appsScript({ action: 'settingSet', token: session, key: r.key, value: input.value });
    save.disabled = false;
    if (!result || !result.ok) { note.textContent = '沒存成功：' + ((result && (result.message || result.error)) || '未知原因'); return; }
    note.textContent = '已儲存' + (result.pushed ? '，官網資料庫也更新了' : '（官網資料庫稍後由排程更新）');
    bar.hidden = true;
  });
  return box;
}

function sessionStorageToken() {
  const s = session.get();
  return s && s.token ? s.token : '';
}

// ── 留痕 ────────────────────────────────────────────────
async function viewAudit() {
  $('crumb').textContent = '系統 › 留痕';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const sub = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '留痕'), sub);
  head.append(box);
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  const result = await db('audit');
  if (!result.ok) { sub.textContent = ''; sheet.append(el('p', 'err', '讀不到：' + (result.message || result.error))); return; }
  sub.textContent = result.rows.length + ' 筆';
  sheet.append(hint('誰、什麼時候、改了什麼，連改前改後都留著。目前記錄設定與文案的修改；等管理台開放改資料之後，資料的異動也會進來。'));
  if (!result.rows.length) {
    sheet.append(el('div', 'empty', '還沒有紀錄。到「系統設定 → 設定與文案」改一項，這裡就會出現。'));
    return;
  }
  const short = (v) => { const t = v == null ? '' : typeof v === 'object' ? (v.value != null ? String(v.value) : JSON.stringify(v)) : String(v); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
  sheet.append(tableOf(['時間', '誰', '動作', '對象', '改前', '改後'], result.rows.map((r) => [
    mono(fmtDate(r.at)), r.who || '', tagOf(r.action === 'delete' ? 'alert' : r.action === 'create' ? 'ok' : 'plain', { update: '修改', create: '新增', delete: '刪除', restore: '還原' }[r.action] || r.action),
    r.target || r.scope, short(r.before), short(r.after),
  ])));
}
