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
    if (!mayEnter(me)) {
      session.clear();
      throw new Error('你目前的身分是「' + roleName(me.role) + '」，還沒有行政中心的權限。要進來有三種方式：加入〈管理員會員編號〉（什麼都能改）、加入〈理監事會員編號〉（只看財務），或是請秘書長到「系統 → 權限」給你某一種資料的權限。');
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

// 身分的中文名字，講給人聽
function roleName(role) {
  return { admin: '秘書長', staff: '秘書處', board: '理監事', volunteer: '志工', member: '會員', guest: '訪客' }[role] || role;
}

// 進得了行政中心嗎：秘書長、秘書處、理監事，或拿到個別授權的志工
function mayEnter(me) {
  if (!me) return false;
  if (me.role === 'admin' || me.role === 'staff' || me.role === 'board') return true;
  return Boolean(me.permits && Object.keys(me.permits).length);
}

// 這一種資料我改不改得動：要有權限，而且正本已經在 D1（還在試算表的要回試算表改）
function canEdit(obj) {
  if (!obj || !ME) return false;
  const here = !obj.source || obj.source === 'd1';
  return here && Array.isArray(ME.canWrite) && ME.canWrite.indexOf(obj.id) !== -1;
}

// 刪除永遠只有秘書長
function canDelete(obj) {
  return canEdit(obj) && ME && ME.role === 'admin';
}
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
  $('whoName').textContent = name + '　·　' + roleName(me.role);
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
  // 目前只有「秘書處」這個管理身分；設定裡寫 admin 的項目一併視為秘書處可見
  const covers = ME.role === 'staff' || ME.role === 'admin' ? ['staff', 'admin'] : [ME.role];
  const visible = (m) => !m.roles || !m.roles.length || m.roles.some((r) => covers.indexOf(r) !== -1);
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
  if (key === 'statement') return viewStatement();
  if (key === 'recon') return viewRecon();
  if (key === 'yearly') return viewYearly();
  if (key === 'cash') return viewCash();
  if (key === 'bankimport') return viewBankImport();
  if (key === 'stock') return viewStock();
  if (key === 'pay_in') return viewLedgerEntry('in');
  if (key === 'pay_out') return viewLedgerEntry('out');
  if (key === 'dues_remind') return viewDuesRemind();
  if (key === 'event_sheet') return viewEventSheet();
  if (key === 'claim_review') return viewClaimReview();
  if (key === 'recon_report') return viewReconReport();
  if (key === 'tools') return viewTools();
  if (key === 'permits') return viewPermits();
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
// 清單的欄位設定（哪些欄位、各多寬）記在這台電腦的瀏覽器裡，一頁一份
const colPrefKey = (objectId) => 'cols:' + objectId;
function colPrefGet(objectId) {
  try {
    const raw = localStorage.getItem(colPrefKey(objectId));
    const got = raw ? JSON.parse(raw) : null;
    return got && typeof got === 'object' ? got : {};
  } catch (err) { return {}; }
}
function colPrefSet(objectId, pref) {
  try { localStorage.setItem(colPrefKey(objectId), JSON.stringify(pref)); } catch (err) { /* 瀏覽器不給存就算了 */ }
}
function colPrefClear(objectId) {
  try { localStorage.removeItem(colPrefKey(objectId)); } catch (err) { /* 同上 */ }
}

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
  if (canEdit(obj)) {
    const add = el('button', 'btn pri');
    add.type = 'button';
    add.append(icon('check'), el('span', '', '新增' + obj.label));
    add.addEventListener('click', () => openForm(obj, null, rows));
    head.append(add);
  }
  main.append(head);

  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);

  const rows = [];
  const chosen = {};            // 勾起來的那幾列（用編號記）
  let activeTags = [];          // 來源篩選：選了哪幾個
  let activeStatus = '__main';  // 狀態分頁：__main＝主要名單、__all＝全部、其餘是某一個狀態
  let cols = null;
  let cursor = null;
  let total = null;
  const tw = el('div', 'tw');
  const table = el('table');
  const body = el('tbody');
  const moreBox = el('div');
  moreBox.style.marginTop = '12px';

  // 狀態分頁：主要名單只留正常的，其餘狀態資料裡有什麼就開什麼分頁。
  // 哪些算主要名單寫在設定庫那個欄位的 options.main，不用改這裡的程式。
  const statusField = obj.fields.filter((f) => f.key === 'status')[0];
  const mainList = (statusField && statusField.options && statusField.options.main) || [];
  // 幾個狀態要併成同一個分頁（例如「退出」併進「已停權」），寫在設定庫 status 欄的 options.groups
  const statusGroups = (statusField && statusField.options && statusField.options.groups) || {};
  const statusBar = el('div', 'tabs');
  statusBar.style.cssText = 'margin:0 0 14px';
  statusBar.hidden = true;

  const statusOf = (r) => String((r.data && r.data[statusField.key]) || '').trim() || '（沒填狀態）';

  function paintStatusBar() {
    if (!statusField || !mainList.length) return;
    const others = asideStatuses(rows.map(statusOf), mainList, statusGroups, (statusField.options && statusField.options.order) || []);
    if (!others.length) { statusBar.hidden = true; return; }
    const mainCount = rows.filter((r) => mainList.indexOf(statusOf(r)) !== -1).length;
    statusBar.replaceChildren();
    statusBar.hidden = false;

    const tab = (key, text, n) => {
      const b = el('button', 'tab' + (activeStatus === key ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', '', text + '（' + n + '）'));
      b.addEventListener('click', () => { activeStatus = key; paint($('q').value); });
      return b;
    };
    const mainLabel = (statusField.options && statusField.options.mainLabel) || (obj.label + '名單');
    statusBar.append(tab('__main', mainLabel, mainCount));
    others.forEach((x) => statusBar.append(tab(x.value, x.value, x.count)));
    statusBar.append(tab('__all', '全部', rows.length));
  }

  // 分組（篩選）：想按什麼分就按什麼分——所在地區、類別、入會年份、來源…
  // 哪些欄位適合，要等資料載進來才知道（值太多、或每個人都不一樣的就不列，例如姓名、地址）。
  // 設定庫標了 facet 的欄位一定會列，而且是預設選的（潛在會員的來源、請款品項的科目代號）。
  let tagField = null;
  let tagFields = [];
  const facetSaved = 'facet:' + obj.id;

  // 一筆資料在某個欄位上算哪一組：日期看年份，文字可以用「；」隔成好幾組
  const facetValuesOf = (f, r) => {
    if (f.valuesOf) return f.valuesOf(r.data || {}); // 算出來的（縣市、年資）
    const v = r.data && r.data[f.key];
    if (f.type === 'date' || f.type === 'datetime') {
      const y = String(v == null ? '' : v).slice(0, 4);
      return /^\d{4}$/.test(y) ? [y + ' 年'] : [];
    }
    return tagsIn(v);
  };

  // 算出來的分組主題：原始欄位不好分的，幫它整理一下
  const derivedFacets = () => {
    const out = [];
    const has = (k) => obj.fields.some((f) => f.key === k);
    // 「社區所在地」存的是「臺中市北屯區」，按縣市分比較好看
    if (has('city')) {
      out.push({
        key: '__city', label: '縣市', type: 'text', curated: 1,
        valuesOf: (d) => {
          const m = /^([\u4e00-\u9fa5]{2}[市縣])/.exec(String(d.city == null ? '' : d.city).trim());
          return m ? [m[1]] : [];
        },
      });
    }
    // 入會時間長短
    if (has('since')) {
      out.push({
        key: '__years', label: '入會年資', type: 'text', curated: 1,
        valuesOf: (d) => {
          const y = String(d.since == null ? '' : d.since).slice(0, 4);
          if (!/^\d{4}$/.test(y)) return [];
          const years = new Date().getFullYear() - Number(y);
          if (years < 1) return ['未滿一年'];
          if (years < 3) return ['1–3 年'];
          if (years < 5) return ['3–5 年'];
          if (years < 10) return ['5–10 年'];
          return ['10 年以上'];
        },
      });
    }
    return out;
  };

  // 挑出適合分組的欄位
  const findFacets = () => {
    const skipType = ['email', 'phone', 'textarea', 'json', 'money', 'number', 'sequence'];
    const out = [];
    obj.fields.concat(derivedFacets()).forEach((f) => {
      if (f.key === 'status') return; // 狀態已經有分頁了
      const forced = Boolean(f.options && f.options.facet);
      const keep = forced || Boolean(f.curated); // 一定列出來的
      if (!keep && skipType.indexOf(f.type) !== -1) return;
      const seen = {};
      let filled = 0;
      rows.forEach((r) => {
        const vs = facetValuesOf(f, r);
        if (vs.length) filled++;
        vs.forEach((v) => (seen[v] = 1));
      });
      const n = Object.keys(seen).length;
      if (!n || !filled) return;
      // 值太多、或每一筆都不一樣的（姓名、地址、日期）不適合分組
      const everyoneDifferent = n === filled && n > 1;
      const tooMany = n > 40 || (rows.length >= 8 && n > rows.length * 0.6);
      if (!keep && (everyoneDifferent || tooMany)) return;
      out.push({ field: f, forced: forced, n: n });
    });
    out.sort((a, b) => (b.forced ? 1 : 0) - (a.forced ? 1 : 0));
    return out;
  };
  const tagBar = el('div');
  tagBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px';
  tagBar.hidden = true;

  const tagsOf = (r) => (tagField ? facetValuesOf(tagField, r) : []);

  function paintTagBar() {
    if (!tagFields.length) { tagBar.hidden = true; return; }
    tagBar.replaceChildren();
    tagBar.hidden = false;

    // 要按什麼分組，自己挑
    const pickLabel = el('span', '', '分組依據：');
    pickLabel.style.cssText = 'font-size:12.5px;color:var(--muted);align-self:center';
    const pick = el('select');
    pick.style.cssText = 'font:inherit;font-size:12.5px;padding:3px 8px;border:1px solid var(--line);border-radius:20px;background:var(--sub);color:var(--ink)';
    const none = el('option', '', '不分組');
    none.value = '';
    pick.append(none);
    tagFields.forEach((x) => {
      const o = el('option', '', x.field.label + '（' + x.n + ' 組）');
      o.value = x.field.key;
      if (tagField && tagField.key === x.field.key) o.selected = true;
      pick.append(o);
    });
    pick.addEventListener('change', () => {
      const hit = tagFields.filter((x) => x.field.key === pick.value)[0];
      tagField = hit ? hit.field : null;
      activeTags = [];
      try { localStorage.setItem(facetSaved, pick.value); } catch (err) { /* 瀏覽器不給存就算了 */ }
      paint($('q').value);
    });
    tagBar.append(pickLabel, pick);

    if (!tagField) return;
    const count = {};
    rows.forEach((r) => tagsOf(r).forEach((t) => (count[t] = (count[t] || 0) + 1)));
    const order = ['未滿一年', '1–3 年', '3–5 年', '5–10 年', '10 年以上'];
    const names = Object.keys(count).sort((a, b) => {
      if (tagField.key === '__years') return order.indexOf(a) - order.indexOf(b);
      if (tagField.type === 'date' || tagField.type === 'datetime') return b.localeCompare(a);
      return count[b] - count[a];
    });
    if (!names.length) return;

    const label = el('span', '', '挑' + tagField.label + '：');
    label.style.cssText = 'font-size:12.5px;color:var(--muted);align-self:center;margin-left:6px';
    tagBar.append(label);

    const chip = (text, on, onClick) => {
      const b = el('button', 'btn quiet');
      b.type = 'button';
      b.style.cssText = 'padding:4px 11px;font-size:12.5px;border-radius:20px' +
        (on ? ';background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft)' : '');
      b.append(el('span', '', text));
      b.addEventListener('click', onClick);
      return b;
    };

    tagBar.append(chip('全部（' + rows.length + '）', activeTags.length === 0, () => {
      activeTags = [];
      paint($('q').value);
    }));
    names.forEach((t) => {
      const on = activeTags.indexOf(t) !== -1;
      tagBar.append(chip(t + '（' + count[t] + '）', on, () => {
        if (on) activeTags = activeTags.filter((x) => x !== t);
        else activeTags = activeTags.concat([t]);
        paint($('q').value);
      }));
    });

    if (activeTags.length > 1) {
      const note = el('span', '', '（符合其中任一個就列出）');
      note.style.cssText = 'font-size:12px;color:var(--faint);align-self:center';
      tagBar.append(note);
    }
  }

  // 只有「一列就是一個人」的名單才給勾選複製聯絡方式（設定庫在那個欄位標 contact）。
  // 像請款品項那種一列是一個花費的，就算有 Email 也不該出現複製名單的工具。
  const contactFields = obj.fields.filter((f) => (f.type === 'email' || f.type === 'phone') && f.options && f.options.contact);
  let lastShown = [];
  const pickBar = el('div');
  pickBar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px';
  pickBar.hidden = true;

  // 訂單勾選之後可以做的事（出貨那一套）
  async function orderBulkDo(what, ids, extra) {
    const body = Object.assign({ action: 'orderBulk', token: sessionStorageToken(), what: what, ids: ids }, extra || {});
    return appsScript(body);
  }

  function paintPickBar() {
    if (!contactFields.length && obj.id !== 'order') return;
    const picked = Object.keys(chosen);
    pickBar.replaceChildren();
    pickBar.hidden = false;

    const all = el('button', 'btn quiet');
    all.type = 'button';
    const everyShown = lastShown.length > 0 && lastShown.every((r) => chosen[r.id]);
    all.append(el('span', '', everyShown ? '取消全選' : '全選這一頁（' + lastShown.length + '）'));
    all.addEventListener('click', () => {
      if (everyShown) lastShown.forEach((r) => delete chosen[r.id]);
      else lastShown.forEach((r) => (chosen[r.id] = r));
      paint($('q').value);
    });
    pickBar.append(all);

    const unit = obj.id === 'order' ? ' 筆' : ' 位';
    const count = el('span', '', picked.length ? '已勾選 ' + picked.length + unit
      : (obj.id === 'order' ? '勾選後可以產生信封、交貨便匯入表、填收據編號' : '勾選後可以複製聯絡方式'));
    count.style.cssText = 'font-size:12.5px;color:var(--muted)';
    pickBar.append(count);

    contactFields.forEach((f) => {
      const b = el('button', 'btn' + (picked.length ? ' pri' : ''));
      b.type = 'button';
      b.disabled = !picked.length;
      b.append(icon(f.type === 'email' ? 'doc' : 'user'), el('span', '', '複製 ' + f.label));
      b.addEventListener('click', () => copyContacts(obj, Object.keys(chosen).map((id) => chosen[id]), f));
      pickBar.append(b);
    });

    if (obj.id === 'order') {
      const rowsOf = () => Object.keys(chosen).map((id) => chosen[id]);
      const shipBtn = (label, iconName, run) => {
        const b = el('button', 'btn' + (picked.length ? ' pri' : ''));
        b.type = 'button';
        b.disabled = !picked.length;
        b.append(icon(iconName), el('span', '', label));
        b.addEventListener('click', async () => {
          const ids = rowsOf().map((r) => r.id);
          const old = b.textContent;
          b.disabled = true;
          b.replaceChildren(el('span', '', '處理中…'));
          try { await run(ids, rowsOf()); } finally {
            b.disabled = false;
            b.replaceChildren(icon(iconName), el('span', '', old));
          }
        });
        return b;
      };

      pickBar.append(shipBtn('產生郵局信封', 'doc', async (ids) => {
        const r = await orderBulkDo('envelope', ids);
        if (!r || !r.ok) return alert('沒有成功：' + ((r && (r.message || r.error)) || '未知原因') +
          (r && r.error === 'no_postal_orders' ? '\n\n（勾選的訂單裡沒有「郵局寄送、已付款、還沒出貨」的）' : ''));
        if (window.confirm('信封已產生（' + r.count + ' 件），順便標成「已備貨」' + (r.marked ? ' ' + r.marked + ' 筆' : '') + '。要現在開啟檔案嗎？')) window.open(r.url, '_blank');
        viewObject(obj.id);
      }));

      pickBar.append(shipBtn('產生 7-11 匯入表', 'shop', async (ids) => {
        const r = await orderBulkDo('cvs', ids);
        if (!r || !r.ok) return alert('沒有成功：' + ((r && (r.message || r.error)) || '未知原因') +
          (r && r.error === 'no_cvs_orders' ? '\n\n（勾選的訂單裡沒有「7-11 店到店、已付款、還沒出貨」的）' : ''));
        if (window.confirm('交貨便匯入表已產生（' + r.count + ' 件），順便標成「已備貨」' + (r.marked ? ' ' + r.marked + ' 筆' : '') + '。要現在開啟檔案嗎？')) window.open(r.url, '_blank');
        viewObject(obj.id);
      }));

      pickBar.append(shipBtn('填收據編號', 'receipt', async (ids) => {
        const start = window.prompt('這批收據的第一個號碼（後面會自動往下加；已經有編號的不會被蓋掉）', '');
        if (start === null || !start.trim()) return;
        const r = await orderBulkDo('receipt', ids, { start: start.trim() });
        if (!r || !r.ok) return alert('沒有成功：' + ((r && (r.message || r.error)) || '未知原因'));
        alert('填好 ' + r.done + ' 筆：\n' + (r.list || []).join('\n') + '\n\n下一個號碼是 ' + r.next);
        viewObject(obj.id);
      }));

      pickBar.append(shipBtn('標記已備貨', 'check', async (ids) => {
        if (!window.confirm('把勾選的 ' + ids.length + ' 筆標成「已備貨」？（只有已付款的會改）')) return;
        const r = await orderBulkDo('prepared', ids);
        if (!r || !r.ok) return alert('沒有成功：' + ((r && (r.message || r.error)) || '未知原因'));
        alert('已標記 ' + r.marked + ' 筆為已備貨。');
        viewObject(obj.id);
      }));
    }

    if (picked.length) {
      const clear = el('button', 'btn quiet');
      clear.type = 'button';
      clear.append(el('span', '', '清除勾選'));
      clear.addEventListener('click', () => { Object.keys(chosen).forEach((k) => delete chosen[k]); paint($('q').value); });
      pickBar.append(clear);
    }
  }

  const cellOf = (r, f, i) => {
    const raw = r.data[f.key];
    const text = raw == null ? '' : Array.isArray(raw) ? raw.length + ' 項' : typeof raw === 'object' ? JSON.stringify(raw).slice(0, 40) : String(raw);
    const kind = /date|datetime/.test(f.type) || i === 0 ? 'mono' : /money|number/.test(f.type) ? 'num mono' : /textarea|text/.test(f.type) ? 'wrap-ok' : '';
    const td = el('td', kind, text);
    // 狀態、日期、金額這種短欄位不要被擠成一字一行
    if (/select|date|datetime|money|number|phone|sequence/.test(f.type)) td.style.whiteSpace = 'nowrap';
    // 自己調過欄寬的：超出就用「…」收起來（滑過去看得到全文，點進去是完整的）
    const w = pref.width && pref.width[f.key];
    if (w) { td.style.overflow = 'hidden'; td.style.textOverflow = 'ellipsis'; td.style.whiteSpace = 'nowrap'; td.title = text; }
    return td;
  };

  // 設定庫可以指定清單的排序（例如訂單＝訂購時間新的在前）
  const sortSpec = (obj.extras && obj.extras.sort) || null;
  const sortRows = (list) => {
    if (!sortSpec || !sortSpec.field) return list;
    const dir = sortSpec.dir === 'asc' ? 1 : -1;
    const key = sortSpec.field;
    const at = (r) => String((r.data && r.data[key]) || '');
    return list.slice().sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0) * dir);
  };

  const paint = (keyword) => {
    body.replaceChildren();
    const lower = String(keyword || '').trim().toLowerCase();
    let shown = lower
      ? rows.filter((r) => JSON.stringify(r.data).toLowerCase().indexOf(lower) !== -1 || String(r.id).toLowerCase().indexOf(lower) !== -1)
      : rows;
    if (tagField && activeTags.length) {
      shown = shown.filter((r) => matchTags(tagsOf(r), activeTags));
    }
    if (statusField && mainList.length) {
      shown = shown.filter((r) => matchStatus(statusOf(r), activeStatus, mainList, statusGroups));
    }
    shown = sortRows(shown); // 設定庫指定的排序（例如訂單：最新的在第一列）
    shown.forEach((r) => {
      const tr = el('tr');
      if (contactFields.length) {
        const pick = el('td');
        pick.style.width = '34px';
        const box = el('input');
        box.type = 'checkbox';
        box.checked = Boolean(chosen[r.id]);
        box.style.cssText = 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer';
        box.addEventListener('click', (e) => e.stopPropagation()); // 勾選不要順便打開抽屜
        box.addEventListener('change', () => { if (box.checked) chosen[r.id] = r; else delete chosen[r.id]; paintPickBar(); });
        pick.append(box);
        tr.append(pick);
      }
      cols.forEach((f, i) => tr.append(cellOf(r, f, i)));
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openDrawer(obj, r));
      body.append(tr);
    });
    shown = sortRows(shown);
    lastShown = shown;
    paintStatusBar();
    paintTagBar();
    paintPickBar();
    if (!shown.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '沒有符合的資料');
      td.colSpan = cols.length + (contactFields.length ? 1 : 0);
      tr.append(td);
      body.append(tr);
    }
    // 金額欄位加總：挑了某個科目之後，直接看得到小計
    const moneyFields = cols.filter((f) => f.type === 'money');
    const sums = moneyFields.map((f) => {
      const n = shown.reduce((t, r) => t + (Number(r.data[f.key]) || 0), 0);
      return n ? f.label + ' ' + n.toLocaleString('zh-TW') + ' 元' : '';
    }).filter(Boolean);
    info.textContent = (total != null ? total + ' 筆' : rows.length + ' 筆')
      + (total != null && rows.length < total ? '（已載入 ' + rows.length + '）' : '')
      + (lower ? '　·　符合「' + keyword + '」' + shown.length + ' 筆' : '')
      + (activeTags.length ? '　·　' + activeTags.join('、') + '　' + shown.length + ' 位' : '')
      + (statusField && mainList.length && activeStatus !== '__all'
        ? '　·　' + (activeStatus === '__main' ? '主要名單' : activeStatus) + ' ' + shown.length + ' 筆' : '')
      + (sums.length ? '　·　' + sums.join('　') : '')
      + '　·　' + obj.fields.length + ' 個欄位';
  };

  // 要顯示哪幾欄：自己設過就照設的，沒設過就照設定庫的預設
  let defaultCols = [];
  const pref = colPrefGet(objectId);
  const fieldOf = (key) => obj.fields.filter((f) => f.key === key)[0];
  const pickedCols = () => {
    const keys = (pref.show && pref.show.length ? pref.show : defaultCols).filter((k) => fieldOf(k));
    return (keys.length ? keys : defaultCols).map(fieldOf).filter(Boolean);
  };

  // 把現在的欄寬固定下來，表格才拉得動（自動寬度的表格會被內容撐著不動）
  const lockWidths = () => {
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) return;
    ths.forEach((x) => {
      if (x.style.width) return;
      const w = Math.round(x.getBoundingClientRect().width);
      if (w) { x.style.width = w + 'px'; }
    });
    table.style.tableLayout = 'fixed';
    table.style.width = Math.round(table.getBoundingClientRect().width) + 'px';
    table.classList.add('fixed-cols');
  };

  // 表頭：可以拖右邊界調寬
  const colHeader = () => {
    const thead = el('thead');
    const tr = el('tr');
    if (contactFields.length || obj.id === 'order') tr.append(el('th'));
    cols.forEach((f) => {
      const th = el('th', /money|number/.test(f.type) ? 'num' : '', f.label);
      th.style.position = 'relative';
      const w = pref.width && pref.width[f.key];
      if (w) th.style.width = w + 'px';
      // 右邊界：按住往左右拉就能調寬
      const grip = el('span');
      grip.title = '按住往左右拉可以調整欄寬（雙擊回到自動）';
      grip.style.cssText = 'position:absolute;top:0;right:-4px;width:9px;height:100%;cursor:col-resize;user-select:none;border-right:2px solid transparent';
      grip.addEventListener('mouseenter', () => { grip.style.borderRightColor = 'var(--accent)'; });
      grip.addEventListener('mouseleave', () => { grip.style.borderRightColor = 'transparent'; });
      grip.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        lockWidths(); // 先把每一欄現在的寬度固定住，拉才會動
        const startX = ev.clientX;
        const startW = th.getBoundingClientRect().width;
        const startTable = table.getBoundingClientRect().width;
        document.body.style.cursor = 'col-resize';
        const move = (e) => {
          const delta = e.clientX - startX;
          const next = Math.max(48, Math.round(startW + delta));
          th.style.width = next + 'px';
          table.style.width = Math.max(240, Math.round(startTable + (next - startW))) + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          pref.width = pref.width || {};
          pref.width[f.key] = Math.round(th.getBoundingClientRect().width);
          colPrefSet(objectId, pref);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        if (pref.width) delete pref.width[f.key];
        colPrefSet(objectId, pref);
        viewObject(objectId);
      });
      th.append(grip);
      tr.append(th);
    });
    thead.append(tr);
    return thead;
  };

  // 「顯示欄位」那顆按鈕
  const colBar = el('div');
  colBar.style.cssText = 'display:flex;justify-content:flex-end;margin:0 0 8px';
  const colBtn = el('button', 'btn quiet');
  colBtn.type = 'button';
  colBtn.append(icon('rows'), el('span', '', '顯示欄位'));
  colBtn.addEventListener('click', () => colChooser(obj, objectId, defaultCols));
  colBar.append(colBtn);

  const loadMore = async () => {
    const result = await db('list', { object: objectId, limit: 1000, cursor: cursor });
    if (!result.ok) { sheet.replaceChildren(el('p', 'err', '讀不到：' + (result.message || result.error))); return; }
    if (!cols) {
      defaultCols = (result.fields && result.fields.length ? result.fields : obj.fields.slice(0, 6)).map((f) => f.key);
      cols = pickedCols();
      table.append(colHeader());
      table.append(body);
      tw.append(table);
      sheet.replaceChildren(colBar, statusBar, tagBar, pickBar, tw, moreBox);
      // 調過欄寬的，畫完第一批資料就把寬度固定住，畫面才跟設定一致
      if (pref.width && Object.keys(pref.width).length) setTimeout(lockWidths, 0);
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
      // 正本在哪，講法就不一樣：還在試算表的要等同步，已經在 D1 的要自己加或用匯入工具
      const here = !obj.source || obj.source === 'd1';
      sheet.replaceChildren(el('div', 'empty', here
        ? '還沒有資料。按右上角「新增' + obj.label + '」自己加一筆，或用試算表選單裡的匯入工具一次搬進來。'
        : '這個項目還沒有資料。試算表那邊同步過來之後就會出現。'));
      info.textContent = '0 筆';
    }
  };

  sheet.append(el('p', 'hint', '讀取中…'));
  await loadMore();
  // 要分組或要分頁就得看到整份；兩千筆以內一次載完（日記帳那種很長的就不勉強）
  const facetMarked = obj.fields.some((f) => f.options && f.options.facet);
  if (facetMarked || (statusField && mainList.length) || (total != null && total <= 2000)) {
    while (cursor && rows.length < total) await loadMore();
  }
  tagFields = findFacets();
  let want = null;
  try { want = localStorage.getItem(facetSaved); } catch (err) { want = null; }
  if (want == null) {
    const forced = tagFields.filter((x) => x.forced)[0];
    tagField = forced ? forced.field : null;
  } else {
    const hit = tagFields.filter((x) => x.field.key === want)[0];
    tagField = hit ? hit.field : null;
  }
  paint($('q').value);
  $('q').oninput = () => { if (current === 'o:' + objectId && cols) paint($('q').value); };
}
const PRIVACY = { public: ['公開', 'pub'], member: ['登入後', 'mem'], staff: ['秘書處', 'stf'], secret: ['個資', 'sec'] };

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
    } else if (/^https?:\/\//.test(String(value))) {
      // 簽名、戳章、上傳的檔案：給連結，是圖的話順便顯示縮圖
      v.style.display = 'block';
      const a = el('a', '', '開啟（' + String(value).slice(0, 48) + (String(value).length > 48 ? '…' : '') + '）');
      a.href = String(value);
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'color:var(--accent);word-break:break-all;font-size:12.5px';
      const thumb = driveThumb(String(value));
      if (thumb) {
        const img = el('img');
        img.src = thumb;
        img.alt = f.label;
        img.style.cssText = 'display:block;max-width:260px;max-height:160px;margin:0 0 6px;border:1px solid var(--line);border-radius:8px;background:#fff';
        img.addEventListener('error', () => { img.remove(); });
        v.append(img);
      }
      v.append(a);
    } else {
      v.textContent = String(value);
    }
    fld.append(label, v);
    box.append(fld);
  });
  // 編輯與刪除：正本已經在 D1、而且我有權限才會出現
  if (canEdit(obj)) {
    const bar0 = el('div');
    bar0.style.cssText = 'display:flex;gap:8px;margin:18px 0 0;padding-top:16px;border-top:1px solid var(--line)';
    const editBtn = el('button', 'btn');
    editBtn.type = 'button';
    editBtn.append(icon('rows'), el('span', '', '編輯'));
    editBtn.addEventListener('click', () => openForm(obj, row));
    bar0.append(editBtn);
    if (canDelete(obj)) {
      const delBtn = el('button', 'btn quiet');
      delBtn.type = 'button';
      delBtn.append(icon('out'), el('span', '', '刪除'));
      delBtn.addEventListener('click', () => removeRecord(obj, row));
      bar0.append(delBtn);
    }
    box.append(bar0);
  } else if (obj.source && obj.source.indexOf('sheet:') === 0) {
    const note = el('p', 'hint');
    note.style.marginTop = '18px';
    note.append(icon('info'), el('span', '', '這一種資料的正本還在試算表「' + obj.source.slice(6) + '」，要改請到那裡改，改完會同步過來。'));
    box.append(note);
  }

  const acts = actionsFor(obj.id, row);
  if (acts.length) {
    const bar = el('div');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 4px;padding-top:16px;border-top:1px solid var(--line)';
    acts.forEach((a, i) => bar.append(actionButton(a, obj, row, i === 0)));
    box.append(bar);
  }
  const foot = el('p', 'hint');
  foot.append(icon('info'), el('span', '', acts.length
    ? '按下去會直接改這一筆，並留下誰在什麼時候改了什麼。'
    : '這一筆目前沒有可以按的動作。要改內容請按上面的「編輯」。'));
  box.append(foot);
  loadRelated(obj, row, box);
}

// 這一筆現在可以按哪些動作：看它屬於哪種資料、現在是什麼狀態
function actionsFor(objectId, row) {
  const now = String((row && (row.status || (row.data && row.data.status))) || '').trim();
  return (META.actions || [])
    .filter((a) => a.object === objectId)
    .filter((a) => !a.from || !a.from.length || a.from.indexOf(now) !== -1)
    .sort((x, y) => (x.sort || 0) - (y.sort || 0));
}

// 一顆動作按鈕：按下去先問一次，需要填一句話的就先讓你填
function actionButton(a, obj, row, primary) {
  const b = el('button', 'btn' + (primary ? ' pri' : ' quiet'));
  b.type = 'button';
  b.append(icon(a.icon || 'check'), el('span', '', a.label));
  b.addEventListener('click', () => runAction(a, obj, row, b));
  return b;
}

async function runAction(a, obj, row, button) {
  let note = null;
  if (a.note) {
    const asked = window.prompt((a.note.label || '請輸入說明') + (a.note.required ? '（必填）' : '（可留白）'), '');
    if (asked === null) return; // 按了取消
    note = asked.trim();
    if (a.note.required && !note) { alert('這個動作需要填一句話。'); return; }
  } else if (a.confirm && !window.confirm(a.confirm)) {
    return;
  }
  const label = String(row.title || row.id);
  const before = button.textContent;
  button.disabled = true;
  button.replaceChildren(el('span', '', '處理中…'));
  const result = await appsScript({
    action: 'recordAction', token: sessionStorageToken(),
    action_id: a.id, object: obj.id, id: row.id, note: note,
  });
  button.disabled = false;
  if (!result || !result.ok) {
    button.replaceChildren(icon(a.icon || 'check'), el('span', '', before));
    alert('沒有成功：' + ((result && (result.message || result.error)) || '未知原因') +
      (result && result.error === 'status_changed' ? '\n\n（這一筆的狀態已經被改過了，重新整理看看最新狀況。）' : ''));
    return;
  }
  dropRowsCache(obj.id);
  alert(label + '：' + (result.message || '已處理。'));
  if (drawerEls) drawerEls.hide();
  if (current === 'approvals') viewApprovals(); else go(current);
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
    wrap.append(hint('這些是「換個值就好」的設定：文案、天數、金額門檻、開關。點大類展開再改，改了按儲存，會寫回試算表的「設定」工作表並同步到這裡，同時留下紀錄。文案改壞了把內容清空，就會回到系統預設的那一份。'));

    // 搜尋框：打字就跨所有大類找，有符合的自動展開
    const search = el('div', 'find');
    search.style.cssText = 'margin:4px 0 14px;width:320px;max-width:100%';
    const si = el('input');
    si.type = 'search';
    si.placeholder = '搜尋設定或文案（例：訂單、提醒、簽名）';
    search.append(icon('find'), si);
    wrap.append(search);

    const holder = el('div');
    wrap.append(holder);

    db('settings-list').then((result) => {
      holder.replaceChildren();
      if (!result.ok) return holder.append(el('p', 'err', '讀不到：' + (result.message || result.error)));
      const groups = {};
      const order = [];
      (result.rows || []).forEach((r) => {
        const g = r.group_name || '一般';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(r);
      });
      // 一般設定排前面、文案排後面，各自照名稱順序
      const isTpl = (g) => (g.indexOf('文案') === 0 ? 1 : 0);
      order.sort((x, y) => isTpl(x) - isTpl(y) || x.localeCompare(y, 'zh-Hant'));

      const open = {};
      const render = (keyword) => {
        holder.replaceChildren();
        const word = String(keyword || '').trim().toLowerCase();
        const hit = (r) => !word
          || String(r.key || '').toLowerCase().indexOf(word) !== -1
          || String(r.value || '').toLowerCase().indexOf(word) !== -1
          || String(r.help || '').toLowerCase().indexOf(word) !== -1;
        let found = 0;
        try {
          order.forEach((g) => {
            const rows = groups[g].filter(hit);
            if (!rows.length) return;
            found += rows.length;
            const isOpen = word ? true : Boolean(open[g]); // 搜尋時全部攤開
            const head = el('button', 'nav group' + (isOpen ? ' open' : ''));
            head.type = 'button';
            head.style.cssText = 'width:100%;margin-top:2px';
            const n = el('span', 'n', String(rows.length));
            const caret = el('span', 'caret', isOpen ? '－' : '＋');
            caret.style.marginLeft = '8px'; // 不要跟右邊的筆數搶同一個 auto 邊界
            head.append(icon(isTpl(g) ? 'doc' : 'gear'), el('span', '', g), n, caret);
            head.addEventListener('click', () => { open[g] = !isOpen; render(si.value); });
            holder.append(head);
            if (!isOpen) return;
            const box = el('div');
            box.style.cssText = 'margin:2px 0 10px 12px;padding:8px 0 6px 14px;border-left:2px solid var(--line-soft)';
            rows.forEach((r) => box.append(settingRow(r)));
            holder.append(box);
          });
        } catch (err) {
          // 畫不出來時要說話，不要留一片空白（2026-11-17 踩過這個坑）
          holder.append(el('p', 'err', '這一頁畫到一半出錯了：' + (err && err.message ? err.message : err)));
          console.error('[管理台] 設定頁', err);
          return;
        }
        if (!found) {
          holder.append(el('div', 'empty', word
            ? '沒有符合「' + String(keyword).trim() + '」的設定或文案。'
            : '設定表目前是空的。到試算表「設定」工作表加一列，或按一次「同步：更新設定庫」。'));
        }
      };
      si.addEventListener('input', () => render(si.value));
      render('');
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
  sheet.append(hint('大部分資料的正本已經在這個資料庫了，不需要同步；剩下還放在試算表的（活動建檔）與算出來的公開名單，每天早上自動更新一次。改過設定庫的定義之後，按「更新設定庫」。'));

  // 試算表選單上的兩件事，搬到這裡
  const tools = el('div');
  tools.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 16px';
  const out = el('p', 'hint');
  out.hidden = true;
  const toolBtn = (label, tool, confirmText) => {
    const b = el('button', 'btn' + (tool === 'reseed' ? ' pri' : ''));
    b.type = 'button';
    b.append(icon('check'), el('span', '', label));
    b.addEventListener('click', async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      const old = b.textContent;
      b.disabled = true;
      b.replaceChildren(el('span', '', '執行中…'));
      out.hidden = false;
      out.className = 'hint';
      out.textContent = label + '：執行中，請稍候…';
      const r = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: tool });
      b.disabled = false;
      b.replaceChildren(icon('check'), el('span', '', old));
      if (!r || !r.ok) {
        out.className = 'err';
        out.textContent = label + '：沒有成功 — ' + ((r && (r.message || r.error)) || '未知原因');
        return;
      }
      out.className = 'hint';
      out.textContent = r.text || '完成';
      dropRowsCache();
      if (tool === 'reseed') {
        const meta = await db('meta');
        if (meta.ok) { META = meta; buildNav(); }
      }
      viewSync();
    });
    return b;
  };
  tools.append(toolBtn('更新設定庫', 'reseed'));
  tools.append(toolBtn('立刻同步', 'sync', '把還放在試算表的資料推上來（活動建檔、公開名單這些）。要繼續嗎？'));
  sheet.append(tools, out);

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
  if (me && me.ok && mayEnter(me)) start(me);
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
    const obj = (META.objects || []).find((o) => o.id === objectId);
    const table = tableOf(['編號', '內容', '狀態', '最後更新', ''], rows.map((r) => [
      mono(r.id), r.title || '', tagOf('warn', r.status || ''), mono(fmtDate(r.updated_at)), '',
    ]));
    // 點一列就從右邊滑出完整內容；最後一欄直接放可以按的動作，常用的不必先點開
    Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openById(rows[i].object_id, rows[i].id));
      if (!obj) return;
      const acts = actionsFor(objectId, rows[i]);
      if (!acts.length) return;
      const cell = tr.lastElementChild;
      cell.style.cssText = 'text-align:right;white-space:nowrap';
      const bar = el('span');
      bar.style.cssText = 'display:inline-flex;gap:6px;justify-content:flex-end';
      bar.addEventListener('click', (e) => e.stopPropagation()); // 按按鈕不要順便把抽屜打開
      acts.forEach((a, n) => bar.append(actionButton(a, obj, rows[i], n === 0)));
      cell.replaceChildren(bar);
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

// 把各種寫法的日期轉成 <input type="date"> 吃得下的格式；轉不出來回空字串
function forDateInput(value, type) {
  const text = String(value).trim();
  if (!text) return '';
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})([T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (!iso) {
    // 沒有四位數年份就不要猜（例如「11/18」會被 JavaScript 當成 2001 年），留給文字框原樣保存
    if (!/\d{4}/.test(text)) return '';
    const d = new Date(text);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => ('0' + n).slice(-2);
    const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return type === 'date' ? day : day + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const pad = (n) => ('0' + Number(n)).slice(-2);
  const day = iso[1] + '-' + pad(iso[2]) + '-' + pad(iso[3]);
  if (type === 'date') return day;
  return day + 'T' + (iso[5] ? pad(iso[5]) + ':' + iso[6] : '00:00');
}

// ── 狀態分頁 ────────────────────────────────────────────
// main＝算在主要名單那一頁的狀態（設定庫 status 欄的 options.main）。
// 其餘狀態不預先列舉：資料裡出現什麼就開什麼分頁，所以「已停權」「無回應/失效」這種寫法都認得。
// active：__main＝主要名單、__all＝全部、其餘＝只看那一個狀態。
function matchStatus(value, active, main, groups) {
  if (active === '__all') return true;
  if (active === '__main') return (main || []).indexOf(value) !== -1;
  const members = groups && groups[active];
  if (members) return members.indexOf(value) !== -1;
  return value === active;
}

// 幾個狀態併成同一個分頁時，回傳它要掛在哪一個分頁底下
function statusTabOf(value, groups) {
  const names = Object.keys(groups || {});
  for (let i = 0; i < names.length; i++) {
    if (groups[names[i]].indexOf(value) !== -1) return names[i];
  }
  return value;
}

// 資料裡實際出現、而且不算主要名單的狀態，照人數多的排前面
// main 以外的狀態各開一頁。order 指定了順序的照它排，其餘照筆數多的在前面。
function asideStatuses(values, main, groups, order) {
  const count = {};
  values.forEach((v) => {
    if ((main || []).indexOf(v) !== -1) return;
    const tab = statusTabOf(v, groups);
    count[tab] = (count[tab] || 0) + 1;
  });
  const want = (order || []).slice(); // 指定過順序的一定顯示，0 筆也看得到
  const rest = Object.keys(count).filter((v) => want.indexOf(v) === -1).sort((a, b) => count[b] - count[a]);
  return want.concat(rest).map((v) => ({ value: v, count: count[v] || 0 }));
}

// ── 一格裡好幾個標籤（例如來源「交流日；購書」）────────────
// 拆成一個個，前後空白去掉，空的不算
// 雲端硬碟的圖檔連結 → 縮圖網址（看不出來就回 null）
function driveThumb(url) {
  const m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w400' : null;
}

function tagsIn(value) {
  return String(value == null ? '' : value)
    .split('；').map((x) => x.trim()).filter(Boolean);
}

// 選了好幾個標籤時，符合其中任何一個就算（聯集，不是交集）
function matchTags(tags, wanted) {
  if (!wanted || !wanted.length) return true;
  return tags.some((t) => wanted.indexOf(t) !== -1);
}

// ── 複製聯絡方式 ────────────────────────────────────────
// 產生用逗號隔開的一串，直接貼進 Gmail 的收件者欄就會自動變成一個個收件人。
// 已取消訂閱的人會自動排除，重複的只留一個。
// 挑出要貼出去的聯絡方式：排除取消訂閱、空白與重複
function contactList(obj, picked, field) {
  const optOut = obj.fields.some((f) => f.key === 'opt_out');
  const seen = {};
  const values = [];
  let skippedOptOut = 0;
  let skippedEmpty = 0;
  let dup = 0;
  picked.forEach((r) => {
    if (optOut) {
      const no = String(r.data.opt_out == null ? '' : r.data.opt_out).trim();
      if (no && no !== '否' && no !== 'false' && no !== '0') { skippedOptOut++; return; }
    }
    const v = String(r.data[field.key] == null ? '' : r.data[field.key]).trim();
    if (!v) { skippedEmpty++; return; }
    const key = v.toLowerCase();
    if (seen[key]) { dup++; return; }
    seen[key] = true;
    values.push(v);
  });
  return { values: values, skippedOptOut: skippedOptOut, skippedEmpty: skippedEmpty, dup: dup };
}

function copyContacts(obj, picked, field) {
  const picked0 = contactList(obj, picked, field);
  const values = picked0.values;
  const skippedOptOut = picked0.skippedOptOut;
  const skippedEmpty = picked0.skippedEmpty;

  const d = ensureDrawer();
  d.title.replaceChildren(el('span', '', '複製' + field.label + '（' + values.length + ' 位）'));
  d.body.replaceChildren();

  const note = el('p', 'hint');
  note.append(icon('info'), el('span', '', field.type === 'email'
    ? '貼到 Gmail 的收件者欄會自動變成一個個收件人。一次寄很多人請放在「密件副本」，收件人之間才看不到彼此。Gmail 一天最多 500 位，建議一次 50 位以內分批寄。'
    : '用逗號隔開的電話清單，可以貼到試算表或簡訊群發工具。'));
  d.body.append(note);

  const area = el('textarea');
  area.value = values.join(', ');
  area.rows = 10;
  area.style.cssText = 'font:inherit;font-size:13px;line-height:1.8;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);width:100%;resize:vertical';
  d.body.append(area);

  const lines = [];
  if (skippedOptOut) lines.push('已排除取消訂閱的 ' + skippedOptOut + ' 位');
  if (skippedEmpty) lines.push('沒有填' + field.label + '的 ' + skippedEmpty + ' 位沒有列入');
  const dup = picked0.dup;
  if (dup > 0) lines.push('重複的 ' + dup + ' 筆只留一個');
  if (lines.length) {
    const small = el('p', '', lines.join('；'));
    small.style.cssText = 'font-size:12.5px;color:var(--muted);margin-top:8px';
    d.body.append(small);
  }

  // 信末要附的退訂說明：直接給一段可以貼的字
  const tail = el('div');
  tail.style.cssText = 'margin-top:16px;padding-top:14px;border-top:1px solid var(--line)';
  tail.append(el('label', '', '信末建議附上這一段（法規與禮貌）'));
  const tailText = el('textarea');
  tailText.rows = 3;
  tailText.value = '如果不想再收到我們的活動與課程通知，請到 ' + location.origin + '/unsubscribe.html 取消訂閱。';
  tailText.style.cssText = 'font:inherit;font-size:13px;line-height:1.8;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);width:100%;margin-top:6px';
  tail.append(tailText);
  d.body.append(tail);

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:14px';
  const copy = el('button', 'btn pri');
  copy.type = 'button';
  copy.append(icon('check'), el('span', '', '複製'));
  const said = el('span', '', '');
  said.style.cssText = 'font-size:12.5px;color:var(--muted);align-self:center';
  copy.addEventListener('click', async () => {
    area.select();
    try {
      await navigator.clipboard.writeText(area.value);
      said.textContent = '複製好了，去 Gmail 貼上就可以。';
    } catch (err) {
      said.textContent = '瀏覽器不讓我直接複製，請按 Ctrl+C。';
    }
  });
  bar.append(copy, said);
  d.body.append(bar);

  d.scrim.classList.add('on');
  d.drawer.classList.add('on');
  d.body.scrollTop = 0;
}

// ── 新增與修改 ──────────────────────────────────────────
// 表單是照設定庫的欄位長出來的，所以加一個欄位不用改這裡的程式。
// 照設定庫的編號規則想一個新編號，例如 B{yyMMdd}{seq:3} → B261122003
// 只看現有資料中同前綴的最大號碼，所以不會跟既有的撞號。
function nextIdFrom(rule, rows, key) {
  if (!rule) return '';
  const now = new Date();
  const p = (n) => ('0' + n).slice(-2);
  const prefix = String(rule).replace(/\{seq:\d+\}/, '')
    .replace('{yyMMdd}', String(now.getFullYear()).slice(2) + p(now.getMonth() + 1) + p(now.getDate()))
    .replace('{yyyyMMdd}', String(now.getFullYear()) + p(now.getMonth() + 1) + p(now.getDate()))
    .replace('{roc}', String(now.getFullYear() - 1911));
  if (/\{[a-z]+\}/i.test(prefix)) return ''; // 還有看不懂的變數（例如 {city}）就不猜
  const m = /\{seq:(\d+)\}/.exec(String(rule));
  const width = m ? Number(m[1]) : 3;
  let max = 0;
  (rows || []).forEach((r) => {
    const v = String((r.data && r.data[key]) || '').trim();
    if (v.indexOf(prefix) !== 0) return;
    const n = Number(v.slice(prefix.length));
    if (n > max) max = n;
  });
  return prefix + ('000000' + (max + 1)).slice(-width);
}

function openForm(obj, row, allRows) {
  const d = ensureDrawer();
  d.title.replaceChildren(el('span', '', (row ? '編輯' : '新增') + obj.label));
  d.body.replaceChildren();
  const data = (row && row.data) || {};
  const inputs = {};

  const note = el('p', 'hint');
  note.append(icon('info'), el('span', '', '星號是必填。灰掉的欄位是系統算的或規定不能改的。存檔會留痕，改前改後都看得到。'));
  d.body.append(note);

  obj.fields.forEach((f) => {
    if (f.type === 'sequence') return; // 系統自己編的號碼
    const fld = el('div', 'fld');
    const label = el('label');
    label.append(el('span', '', f.label + (f.required ? ' ✱' : '')));
    const p = PRIVACY[f.privacy];
    if (p) label.append(el('span', 'chip ' + p[1], p[0]));
    const mode = f.lockAfter && f.lockAfter.mode;
    const had = data[f.key] != null && String(data[f.key]).trim() !== '';
    const frozen = Boolean(row) && had && (mode === 'locked' || mode === 'reverse_only');
    if (frozen) label.append(el('span', 'chip', mode === 'locked' ? '不能改' : '只能沖銷'));
    if (mode === 'append' && had) label.append(el('span', 'chip', '只能往後接'));
    fld.append(label);

    let input;
    if (f.type === 'select' && f.options && Array.isArray(f.options.items)) {
      input = el('select');
      const blank = el('option', '', '（不填）');
      blank.value = '';
      input.append(blank);
      f.options.items.forEach((item) => { const o = el('option', '', item); o.value = item; input.append(o); });
    } else if (f.type === 'textarea' || f.type === 'json') {
      input = el('textarea');
      input.rows = 4;
    } else {
      input = el('input');
      input.type = { number: 'number', money: 'number', date: 'date', datetime: 'datetime-local', email: 'email', url: 'url', phone: 'tel' }[f.type] || 'text';
    }
    const raw = data[f.key];
    let shown = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    // 新增一筆時，編號那一欄先帶出下一號（可以自己改）
    if (!row && !shown && obj.idRule && f.key === 'id') shown = nextIdFrom(obj.idRule, allRows || [], f.key);
    if (shown && (input.type === 'date' || input.type === 'datetime-local')) {
      const fitted = forDateInput(shown, input.type);
      if (fitted) shown = fitted;
      else input.type = 'text'; // 看不懂的日期就當文字，至少不會把原本的值弄丟
    }
    input.value = shown;
    input.disabled = frozen;
    input.style.cssText = 'font:inherit;font-size:13.5px;line-height:1.7;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:' + (frozen ? 'var(--line-soft)' : 'var(--sub)') + ';color:' + (frozen ? 'var(--muted)' : 'var(--ink)') + ';width:100%;resize:vertical';
    fld.append(input);
    if (/^https?:\/\//.test(shown)) {
      const open = el('a', '', '開啟這個檔案');
      open.href = shown;
      open.target = '_blank';
      open.rel = 'noopener';
      open.style.cssText = 'color:var(--accent);font-size:12px';
      fld.append(open);
    }
    if (f.help) {
      const tip = el('small', '', f.help);
      tip.style.cssText = 'color:var(--muted);font-size:12px;line-height:1.6';
      fld.append(tip);
    }
    inputs[f.key] = { input: input, field: f, frozen: frozen };
    d.body.append(fld);
  });

  const msg = el('p', 'err');
  msg.hidden = true;
  d.body.append(msg);

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)';
  const save = el('button', 'btn pri');
  save.type = 'button';
  save.append(icon('check'), el('span', '', '儲存'));
  const cancel = el('button', 'btn quiet');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => { if (row) openDrawer(obj, row); else d.hide(); });
  bar.append(save, cancel);
  d.body.append(bar);

  save.addEventListener('click', async () => {
    const payload = {};
    Object.keys(inputs).forEach((key) => {
      const it = inputs[key];
      if (it.frozen) return;
      payload[key] = it.input.value;
    });
    save.disabled = true;
    msg.hidden = true;
    const result = await db('save', { object: obj.id, id: row ? row.id : '', data: payload });
    dropRowsCache(obj.id);
    save.disabled = false;
    if (!result.ok) {
      msg.textContent = '沒有存成功：' + (result.message || result.error);
      msg.hidden = false;
      return;
    }
    const fresh = await db('get', { object: obj.id, id: result.id });
    if (fresh.ok && fresh.row) openDrawer(obj, fresh.row);
    else d.hide();
    if (current === 'approvals') viewApprovals(); else go(current);
  });

  d.scrim.classList.add('on');
  d.drawer.classList.add('on');
  d.body.scrollTop = 0;
}

async function removeRecord(obj, row) {
  if (!confirm('要刪掉「' + (row.title || row.id) + '」嗎？\n\n資料不會真的消失，會標記成已刪除，需要的話救得回來。')) return;
  const result = await db('remove', { object: obj.id, id: row.id });
  dropRowsCache(obj.id);
  if (!result.ok) { alert('刪不掉：' + (result.message || result.error)); return; }
  if (drawerEls) drawerEls.hide();
  go(current);
}

// ── 權限 ────────────────────────────────────────────────
// 三種身分：秘書長什麼都能改、理監事只看財務、志工看個別授權。
// 前兩種在「設定與文案」填會員編號，這一頁管的是第三種。

// ── 收支表 ──────────────────────────────────────────────
// 數字全部從日記帳算出來，和試算表那張收支表同一套規則：
//   4 字頭＝收入、5 字頭＝支出、9 字頭（暫收、暫付、內部轉帳）不進收支，只列待沖轉餘額。
const nt = (n) => (Math.round(Number(n) || 0)).toLocaleString('zh-TW');
const rocOf = (year) => year - 1911;

// 一筆日記帳算哪一類
function ledgerKind(code) {
  const c = String(code == null ? '' : code).trim();
  if (c.indexOf('9') === 0) return 'suspense';
  if (c.indexOf('4') === 0) return 'income';
  if (c.indexOf('5') === 0) return 'expense';
  return 'other';
}

// 日記帳 → 收支表。rows 是 /api/list 回來的那種 { data: {...} }，names 是科目代號對科目名稱
function statementOf(rows, year, names) {
  const want = String(year);
  const group = { income: {}, expense: {}, suspense: {}, other: {} };
  const months = [];
  for (let i = 0; i < 12; i++) months.push({ month: i + 1, income: 0, expense: 0 });
  let n = 0;
  (rows || []).forEach((r) => {
    const d = r.data || r;
    const date = String(d.date == null ? '' : d.date);
    if (date.slice(0, 4) !== want) return;
    n++;
    const code = String(d.code == null ? '' : d.code).trim() || '（沒填科目）';
    const income = Number(d.income) || 0;
    const expense = Number(d.expense) || 0;
    const kind = ledgerKind(code);
    const box = group[kind];
    const name = (names && names[code]) || String(d.code_name == null ? '' : d.code_name).trim();
    const hit = box[code] || (box[code] = { code: code, name: name, income: 0, expense: 0, n: 0 });
    if (!hit.name && name) hit.name = name;
    hit.income += income;
    hit.expense += expense;
    hit.n++;
    const m = Number(date.slice(5, 7));
    if (m >= 1 && m <= 12 && kind !== 'suspense') {
      months[m - 1].income += income;
      months[m - 1].expense += expense;
    }
  });
  const list = (box, by) => Object.keys(box).map((k) => box[k])
    .sort((a, b) => (b[by] - a[by]) || a.code.localeCompare(b.code));
  const income = list(group.income, 'income');
  const expense = list(group.expense, 'expense');
  const other = list(group.other, 'income');
  const suspense = list(group.suspense, 'income');
  const sum = (arr, key) => arr.reduce((t, x) => t + x[key], 0);
  const totalIncome = sum(income, 'income') + sum(other, 'income');
  const totalExpense = sum(expense, 'expense') + sum(other, 'expense');
  return {
    year: Number(year), rows: n,
    income: income, expense: expense, other: other, suspense: suspense,
    totalIncome: totalIncome, totalExpense: totalExpense, balance: totalIncome - totalExpense,
    suspenseLeft: sum(suspense, 'income') - sum(suspense, 'expense'),
    months: months,
  };
}

async function viewStatement() {
  $('crumb').textContent = '財務 › 收支表';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '收支表'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);

  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('數字是從日記帳算出來的：4 字頭進收入、5 字頭進支出，9 字頭（暫收、暫付、內部轉帳）不算收支，只在最後列出待沖轉餘額。決算時一個科目一列抄進財報就好。'));

  // 日記帳與科目名稱
  const got = await db('list', { object: 'journal', limit: 1000 });
  if (!got.ok) { sheet.append(el('p', 'err', '讀不到日記帳：' + (got.message || got.error))); return; }
  const rows = got.rows || [];
  let cursor = got.nextCursor;
  while (cursor && rows.length < 20000) {
    const more = await db('list', { object: 'journal', limit: 1000, cursor: cursor });
    if (!more.ok || !(more.rows || []).length) break;
    rows.push.apply(rows, more.rows);
    cursor = more.nextCursor;
  }
  const names = {};
  const acc = await db('list', { object: 'account', limit: 1000 });
  if (acc.ok) (acc.rows || []).forEach((r) => { if (r.data && r.data.code) names[String(r.data.code).trim()] = r.data.name; });

  const years = {};
  rows.forEach((r) => { const y = String((r.data || {}).date || '').slice(0, 4); if (/^\d{4}$/.test(y)) years[y] = (years[y] || 0) + 1; });
  const yearList = Object.keys(years).sort().reverse();
  sheet.append(hint('資料庫裡的日記帳目前 ' + rows.length + ' 筆（' + yearList.length + ' 個年度）。數字和試算表對不起來時，先到試算表按「同步 → 推上去」再看一次；還是不同就把兩邊的科目金額給我比對。'));
  if (!yearList.length) { info.textContent = '日記帳還沒有資料'; return; }
  let year = yearList[0];

  // 年度與列印
  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px';
  const pickLabel = el('span', '', '年度：');
  pickLabel.style.cssText = 'font-size:12.5px;color:var(--muted)';
  const pick = el('select');
  pick.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink)';
  yearList.forEach((y) => {
    const o = el('option', '', '民國 ' + rocOf(Number(y)) + ' 年（' + y + '）　' + years[y] + ' 筆');
    o.value = y;
    pick.append(o);
  });
  const printBtn = el('button', 'btn quiet');
  printBtn.type = 'button';
  printBtn.append(icon('doc'), el('span', '', '列印這一頁'));
  printBtn.addEventListener('click', () => window.print());
  const docBtn = el('button', 'btn quiet');
  docBtn.type = 'button';
  docBtn.append(icon('doc'), el('span', '', '產生 Google 文件'));
  docBtn.title = '照這一頁的數字產生年度收支表的 Google 文件（會議手冊用）';
  bar.append(pickLabel, pick, printBtn, docBtn);
  sheet.append(bar);

  const note = el('p', 'hint');
  note.hidden = true;
  sheet.append(note);
  docBtn.addEventListener('click', async () => {
    docBtn.disabled = true;
    note.hidden = false;
    note.className = 'hint';
    note.textContent = '產生中…';
    const r = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: 'statement_doc', year: pick.value });
    docBtn.disabled = false;
    if (!r || !r.ok) {
      note.className = 'err';
      note.textContent = '沒有成功：' + ((r && (r.message || r.error)) || '未知原因');
      return;
    }
    note.textContent = r.text + '（檔案開在新視窗，可以直接「檔案 → 下載 → PDF」或複製到會議手冊）';
    window.open(r.url, '_blank');
  });

  const out = el('div');
  sheet.append(out);

  const table = (title, items, key, total) => {
    const wrap = el('div');
    wrap.style.cssText = 'margin:0 0 22px';
    const h = el('h2', '', title);
    h.style.cssText = 'font-size:14px;margin:0 0 8px;color:var(--ink)';
    wrap.append(h);
    const tw = el('div', 'tw');
    const t = el('table');
    const thead = el('thead');
    const hr = el('tr');
    ['科目代號', '科目名稱', '筆數', '金額', '佔比'].forEach((x) => {
      const th = el('th', '', x);
      if (x === '金額' || x === '佔比' || x === '筆數') th.style.textAlign = 'right';
      hr.append(th);
    });
    thead.append(hr);
    const tb = el('tbody');
    items.forEach((x) => {
      const tr = el('tr');
      tr.append(el('td', '', x.code), el('td', '', x.name || ''));
      const nCell = el('td', '', String(x.n));
      nCell.style.textAlign = 'right';
      const money = el('td', '', nt(x[key]) + ' 元');
      money.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums';
      const share = el('td', '', total ? (Math.round((x[key] / total) * 1000) / 10) + '%' : '');
      share.style.cssText = 'text-align:right;color:var(--muted)';
      tr.append(nCell, money, share);
      tb.append(tr);
    });
    const foot = el('tr');
    const fl = el('td', '', '合計');
    fl.colSpan = 3;
    fl.style.fontWeight = '600';
    const fm = el('td', '', nt(total) + ' 元');
    fm.style.cssText = 'text-align:right;font-weight:600;font-variant-numeric:tabular-nums';
    foot.append(fl, fm, el('td'));
    tb.append(foot);
    t.append(thead, tb);
    makeResizable(t, 'statement.' + title);
    tw.append(t);
    wrap.append(tw);
    return wrap;
  };

  const paint = () => {
    const s = statementOf(rows, year, names);
    info.textContent = '民國 ' + rocOf(s.year) + ' 年度　日記帳 ' + s.rows + ' 筆　收入 ' + nt(s.totalIncome) + ' 元　支出 ' + nt(s.totalExpense) + ' 元　結餘 ' + nt(s.balance) + ' 元';
    out.replaceChildren();

    const cards = el('div', 'tiles');
    [['收入合計', s.totalIncome], ['支出合計', s.totalExpense], ['本年度結餘', s.balance], ['待沖轉（9 字頭）', s.suspenseLeft]].forEach((pair) => {
      const c = el('div', 'tile');
      c.append(el('div', 'k', pair[0]), el('div', 'n', nt(pair[1]) + ' 元'));
      cards.append(c);
    });
    out.append(cards);

    out.append(table('收入（4 字頭）', s.income, 'income', s.income.reduce((t, x) => t + x.income, 0)));
    out.append(table('支出（5 字頭）', s.expense, 'expense', s.expense.reduce((t, x) => t + x.expense, 0)));
    if (s.other.length) {
      const note = el('p', 'err', '有 ' + s.other.length + ' 個科目代號看不出是收入還是支出（不是 4、5、9 開頭），請到日記帳修正：' + s.other.map((x) => x.code).join('、'));
      out.append(note);
    }
    if (s.suspense.length) {
      out.append(table('暫收、暫付與內部轉帳（9 字頭，不計入收支）', s.suspense, 'income', s.suspense.reduce((t, x) => t + x.income, 0)));
      out.append(hint('這一區年底要沖轉成 0。目前餘額（收入減支出）：' + nt(s.suspenseLeft) + ' 元。'));
    }

    // 每個月
    const mw = el('div');
    const mh = el('h2', '', '每個月');
    mh.style.cssText = 'font-size:14px;margin:0 0 8px;color:var(--ink)';
    mw.append(mh);
    const mtw = el('div', 'tw');
    const mt = el('table');
    const mhead = el('thead');
    const mhr = el('tr');
    ['月份', '收入', '支出', '當月結餘', '累計結餘'].forEach((x, i) => {
      const th = el('th', '', x);
      if (i) th.style.textAlign = 'right';
      mhr.append(th);
    });
    mhead.append(mhr);
    const mtb = el('tbody');
    let acc2 = 0;
    s.months.forEach((m) => {
      acc2 += m.income - m.expense;
      if (!m.income && !m.expense) return;
      const tr = el('tr');
      tr.append(el('td', '', m.month + ' 月'));
      [m.income, m.expense, m.income - m.expense, acc2].forEach((v) => {
        const td = el('td', '', nt(v) + ' 元');
        td.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums';
        tr.append(td);
      });
      mtb.append(tr);
    });
    mt.append(mhead, mtb);
    mtw.append(mt);
    mw.append(mtw);
    out.append(mw);
  };

  pick.addEventListener('change', () => { year = pick.value; paint(); });
  paint();
}


// ── 對帳 ────────────────────────────────────────────────
// 銀行明細（網銀下載的）對日記帳。規則和試算表那張一樣：同方向、同金額、日期相差 3 天內；
// 填了「銀行列號」就當作已指定；同一個「付款批號」的幾筆合併成一筆去對。
// LINE Pay：本會沒有 LINE Pay 帳戶，是秘書長從銀行領現金、再用自己的 LINE Pay 轉給請款人，
// 所以這種付款方式不跟銀行一筆一筆對，改成整個月「現金取款合計」對「代付支出合計」。
const CASH_METHODS = ['LINE Pay', '現金', 'linepay', 'LINEPAY'];
const RECON_DAYS = 3;

function reconDir(income, expense) {
  return (Number(income) || 0) > 0 ? 'in' : 'out';
}
function reconAmount(income, expense) {
  const i = Number(income) || 0;
  return i > 0 ? i : (Number(expense) || 0);
}
function daysApart(a, b) {
  const x = new Date(String(a || '').slice(0, 10));
  const y = new Date(String(b || '').slice(0, 10));
  if (isNaN(x) || isNaN(y)) return 9999;
  return Math.abs((x - y) / 86400000);
}
const isCashRow = (r) => /現金|取款|提款|ATM/.test(String(r.kind || '') + String(r.memo || '') + String(r.note || ''));

// journal、bank 都是 { data: {...} } 那種列；ym 是 "2026-11"
function reconcile(journal, bank, ym) {
  const month = (v) => String(v == null ? '' : v).slice(0, 7);
  // 留著原本那一筆（含資料庫編號），畫面上才點得開來改
  const srcOf = new Map();
  const take = (list) => (list || []).map((r) => { const d = r.data || r; srcOf.set(d, r); return d; });
  const J = take(journal);
  const B = take(bank);

  // 日記帳：付款方式「銀行」的才一筆一筆對；LINE Pay／現金 另外一區；其他不對帳
  const bankJ = J.filter((d) => String(d.method || '').trim() === '銀行');
  const cashJ = J.filter((d) => CASH_METHODS.indexOf(String(d.method || '').trim()) !== -1);

  // 同一個付款批號合併成一筆
  const batchTotal = {};
  bankJ.forEach((d) => {
    const b = String(d.batch || '').trim();
    if (!b) return;
    batchTotal[b] = (batchTotal[b] || 0) + (Number(d.expense) || 0);
  });

  const bankMatches = (d) => {
    const batch = String(d.batch || '').trim();
    const dir = batch ? 'out' : reconDir(d.income, d.expense);
    const amount = batch ? batchTotal[batch] : reconAmount(d.income, d.expense);
    if (!amount) return [];
    return B.filter((b) => {
      const bDir = (Number(b['in']) || 0) > 0 ? 'in' : 'out';
      if (bDir !== dir) return false;
      const bAmount = bDir === 'in' ? Number(b['in']) || 0 : Number(b.out) || 0;
      if (bAmount !== amount) return false;
      return daysApart(d.date, b.date) <= RECON_DAYS;
    });
  };

  const journalUnmatched = [];
  const seenBatch = {};
  bankJ.forEach((d) => {
    if (month(d.date) !== ym) return;
    if (String(d.bank_row || '').trim()) return; // 已指定
    const batch = String(d.batch || '').trim();
    if (batch) {
      if (seenBatch[batch]) return;
      seenBatch[batch] = 1;
    }
    const hits = bankMatches(d);
    if (hits.length === 1) return;
    journalUnmatched.push({ data: d, row: srcOf.get(d), why: hits.length ? '多筆同額，要手動指定' : '銀行明細上找不到', batch: batch, hits: hits.length });
  });

  // 銀行明細那邊：找不到對應日記帳的（利息、手續費、或忘了記的）
  const bankUnmatched = [];
  B.forEach((b) => {
    if (month(b.date) !== ym) return;
    const bDir = (Number(b['in']) || 0) > 0 ? 'in' : 'out';
    const bAmount = bDir === 'in' ? Number(b['in']) || 0 : Number(b.out) || 0;
    if (!bAmount) return;
    if (isCashRow(b) && bDir === 'out') return; // 現金取款另外一區處理
    const hit = bankJ.some((d) => {
      const batch = String(d.batch || '').trim();
      const dir = batch ? 'out' : reconDir(d.income, d.expense);
      if (dir !== bDir) return false;
      const amount = batch ? batchTotal[batch] : reconAmount(d.income, d.expense);
      return amount === bAmount && daysApart(d.date, b.date) <= RECON_DAYS;
    });
    if (!hit) bankUnmatched.push({ data: b, row: srcOf.get(b) });
  });

  // 這個月的合計
  const sum = (arr, pick) => arr.reduce((t, x) => t + (Number(pick(x)) || 0), 0);
  const bankMonth = B.filter((b) => month(b.date) === ym);
  const cashOutRows = bankMonth.filter((b) => isCashRow(b) && (Number(b.out) || 0) > 0);
  const bankIn = sum(bankMonth, (b) => b['in']);
  const bankOut = sum(bankMonth, (b) => b.out);
  const cashWithdraw = sum(cashOutRows, (b) => b.out);
  const jMonth = bankJ.filter((d) => month(d.date) === ym);
  const cashMonth = cashJ.filter((d) => month(d.date) === ym);

  return {
    ym: ym,
    bank: { in: bankIn, out: bankOut, rows: bankMonth.length },
    journal: { in: sum(jMonth, (d) => d.income), out: sum(jMonth, (d) => d.expense), rows: jMonth.length },
    cash: {
      withdraw: cashWithdraw, withdrawRows: cashOutRows,
      paid: sum(cashMonth, (d) => d.expense), paidRows: cashMonth,
    },
    diff: {
      in: bankIn - sum(jMonth, (d) => d.income),
      out: (bankOut - cashWithdraw) - sum(jMonth, (d) => d.expense),
    },
    journalUnmatched: journalUnmatched,
    bankUnmatched: bankUnmatched,
  };
}

async function viewRecon() {
  $('crumb').textContent = '財務 › 對帳';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '對帳'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('銀行明細對日記帳：同方向、同金額、日期相差 3 天以內就算對上；同一個付款批號的幾筆會合併起來對。LINE Pay 不是另一個帳戶（從銀行領現金、再用 LINE Pay 轉給請款人），所以另外一區用「現金取款合計」對「代付支出合計」。'));
  sheet.append(hint('下面兩張表的每一列都可以點開來改：日期打錯、金額少一個 0、付款方式選錯邊，改完按上面的「改完重算」就會重對。真的有兩筆同額分不出來時，在日記帳那一筆填「銀行列號」就當作已指定。'));

  const loadAll = async (object) => {
    const first = await db('list', { object: object, limit: 1000 });
    if (!first.ok) return null;
    const rows = first.rows || [];
    let cursor = first.nextCursor;
    while (cursor && rows.length < 20000) {
      const more = await db('list', { object: object, limit: 1000, cursor: cursor });
      if (!more.ok || !(more.rows || []).length) break;
      rows.push.apply(rows, more.rows);
      cursor = more.nextCursor;
    }
    return rows;
  };

  const journal = await loadAll('journal');
  if (!journal) { sheet.append(el('p', 'err', '讀不到日記帳')); return; }
  const bank = await loadAll('bank');
  if (!bank) {
    sheet.append(el('p', 'err', '讀不到銀行明細。請先到試算表按「同步 → 更新設定庫」再按「推上去」，把「銀行明細」這張表也同步過來。'));
    return;
  }

  const months = {};
  journal.concat(bank).forEach((r) => { const m = String((r.data || {}).date || '').slice(0, 7); if (/^\d{4}-\d{2}$/.test(m)) months[m] = 1; });
  const list = Object.keys(months).sort().reverse();
  if (!list.length) { info.textContent = '還沒有可以對帳的資料'; return; }
  let ym = list[0];

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin:0 0 14px';
  const pickLabel = el('span', '', '月份：');
  pickLabel.style.cssText = 'font-size:12.5px;color:var(--muted)';
  const pick = el('select');
  pick.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink)';
  list.forEach((m) => { const o = el('option', '', m); o.value = m; pick.append(o); });
  bar.append(pickLabel, pick);
  const printBtn = el('button', 'btn quiet');
  printBtn.type = 'button';
  printBtn.append(icon('doc'), el('span', '', '列印'));
  printBtn.addEventListener('click', () => window.print());
  const againBtn = el('button', 'btn quiet');
  againBtn.type = 'button';
  againBtn.append(icon('check'), el('span', '', '改完重算'));
  againBtn.addEventListener('click', () => { dropRowsCache('journal'); dropRowsCache('bank'); viewRecon(); });
  bar.append(printBtn, againBtn);
  sheet.append(bar);
  const out = el('div');
  sheet.append(out);

  const rowTable = (title, items, columns, empty, objectId) => {
    const wrap = el('div');
    wrap.style.cssText = 'margin:0 0 22px';
    const h = el('h2', '', title + '（' + items.length + '）');
    h.style.cssText = 'font-size:14px;margin:0 0 8px;color:var(--ink)';
    wrap.append(h);
    if (!items.length) { wrap.append(el('p', 'hint', empty)); return wrap; }
    const tw = el('div', 'tw');
    const t = el('table');
    const thead = el('thead');
    const hr = el('tr');
    columns.forEach((c) => { const th = el('th', '', c.label); if (c.right) th.style.textAlign = 'right'; hr.append(th); });
    thead.append(hr);
    const tb = el('tbody');
    const obj = objectId ? (META.objects || []).find((o) => o.id === objectId) : null;
    items.forEach((x) => {
      const tr = el('tr');
      columns.forEach((c) => {
        const td = el('td', '', c.get(x));
        if (c.right) td.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums';
        tr.append(td);
      });
      // 點一下就開那一筆，可以直接改日期、金額、付款方式，或填銀行列號指定對到哪一列
      if (obj && x.row && x.row.id) {
        tr.style.cursor = 'pointer';
        tr.title = '點一下可以修改這一筆';
        tr.addEventListener('click', () => openDrawer(obj, x.row));
      }
      tb.append(tr);
    });
    t.append(thead, tb);
    makeResizable(t, 'recon.' + title);
    tw.append(t);
    wrap.append(tw);
    return wrap;
  };

  const paint = () => {
    const r = reconcile(journal, bank, ym);
    const ok = r.diff.in === 0 && r.diff.out === 0 && !r.journalUnmatched.length && !r.bankUnmatched.length;
    info.textContent = ym + '　銀行 ' + r.bank.rows + ' 筆、日記帳 ' + r.journal.rows + ' 筆　' + (ok ? '✔ 這個月對平了' : '還有要處理的');
    out.replaceChildren();

    const cards = el('div', 'tiles');
    [
      ['銀行存入', r.bank.in], ['日記帳收入', r.journal.in], ['收入差額', r.diff.in],
      ['銀行支出（不含取款）', r.bank.out - r.cash.withdraw], ['日記帳支出', r.journal.out], ['支出差額', r.diff.out],
    ].forEach((pair) => {
      const c = el('div', 'tile');
      c.append(el('div', 'k', pair[0]), el('div', 'n', nt(pair[1]) + ' 元'));
      if (/差額/.test(pair[0]) && pair[1] !== 0) c.style.cssText = 'border-color:var(--bad,#a3271a)';
      cards.append(c);
    });
    out.append(cards);

    out.append(rowTable('日記帳上對不到銀行明細的', r.journalUnmatched, [
      { label: '日期', get: (x) => String(x.data.date || '').slice(0, 10) },
      { label: '摘要', get: (x) => String(x.data.summary || '') },
      { label: '科目', get: (x) => String(x.data.code || '') },
      { label: '收入', right: 1, get: (x) => (Number(x.data.income) ? nt(x.data.income) : '') },
      { label: '支出', right: 1, get: (x) => (Number(x.data.expense) ? nt(x.data.expense) : '') },
      { label: '批號', get: (x) => x.batch || '' },
      { label: '為什麼', get: (x) => x.why },
    ], '都對到了。', 'journal'));

    out.append(rowTable('銀行明細上對不到日記帳的', r.bankUnmatched, [
      { label: '日期', get: (x) => String(x.data.date || '').slice(0, 10) },
      { label: '摘要', get: (x) => String(x.data.memo || x.data.kind || '') },
      { label: '存入', right: 1, get: (x) => (Number(x.data['in']) ? nt(x.data['in']) : '') },
      { label: '支出', right: 1, get: (x) => (Number(x.data.out) ? nt(x.data.out) : '') },
      { label: '備註', get: (x) => String(x.data.note || '') },
    ], '都對到了。', 'bank'));

    // 現金（LINE Pay 代付）
    const cashWrap = el('div');
    const ch = el('h2', '', '現金代付（LINE Pay）');
    ch.style.cssText = 'font-size:14px;margin:0 0 8px;color:var(--ink)';
    cashWrap.append(ch);
    const gap = r.cash.withdraw - r.cash.paid;
    cashWrap.append(el('p', 'hint', '這個月從銀行領出現金 ' + nt(r.cash.withdraw) + ' 元（' + r.cash.withdrawRows.length + ' 筆），日記帳上用 LINE Pay／現金付掉 ' + nt(r.cash.paid) + ' 元（' + r.cash.paidRows.length + ' 筆）。' + (gap === 0 ? '剛好用完。' : gap > 0 ? '還有 ' + nt(gap) + ' 元在手上（或還沒記帳）。' : '多付了 ' + nt(-gap) + ' 元，是用先前領的錢或您先墊的。')));
    out.append(cashWrap);
    out.append(rowTable('　從銀行領出的現金', r.cash.withdrawRows.map((d) => ({ data: d })), [
      { label: '日期', get: (x) => String(x.data.date || '').slice(0, 10) },
      { label: '摘要', get: (x) => String(x.data.memo || x.data.kind || '') },
      { label: '金額', right: 1, get: (x) => nt(x.data.out) },
    ], '這個月沒有現金取款。'));
    out.append(rowTable('　用 LINE Pay／現金付掉的', r.cash.paidRows.map((d) => ({ data: d })), [
      { label: '日期', get: (x) => String(x.data.date || '').slice(0, 10) },
      { label: '摘要', get: (x) => String(x.data.summary || '') },
      { label: '科目', get: (x) => String(x.data.code || '') },
      { label: '對象', get: (x) => String(x.data.target || '') },
      { label: '金額', right: 1, get: (x) => nt(x.data.expense) },
    ], '這個月沒有這種付款。'));
  };

  pick.addEventListener('change', () => { ym = pick.value; paint(); });
  paint();
}


// ── 年度結餘表與現金收支餘額表 ──────────────────────────
// 本會是現金收支制：不做損益表與資產負債表，改做「各年度收支結餘」與「各帳戶期初期末」。

// 一年一列：收入、支出、本年度結餘、累計結餘（9 字頭不計入收支）
function yearlyOf(rows) {
  const byYear = {};
  (rows || []).forEach((r) => {
    const d = r.data || r;
    const y = String(d.date == null ? '' : d.date).slice(0, 4);
    if (!/^\d{4}$/.test(y)) return;
    const code = String(d.code == null ? '' : d.code).trim();
    if (code.indexOf('9') === 0) return; // 暫收、暫付、內部轉帳不算收支
    const box = byYear[y] || (byYear[y] = { year: Number(y), income: 0, expense: 0, rows: 0 });
    box.income += Number(d.income) || 0;
    box.expense += Number(d.expense) || 0;
    box.rows++;
  });
  const list = Object.keys(byYear).sort().map((y) => byYear[y]);
  let acc = 0;
  list.forEach((x) => {
    x.balance = x.income - x.expense;
    acc += x.balance;
    x.accumulated = acc;
  });
  return list;
}

// 某一年的各帳戶期初、收入、支出、期末。
// 銀行：以銀行明細的「餘額」為準（期初＝去年最後一筆餘額，期末＝今年最後一筆餘額）。
// 現金：秘書長從銀行領出來、還沒付掉的錢（領出 − 用現金／LINE Pay 付掉的）。
function cashOf(journal, bank, year) {
  const y = String(year);
  const num = (v) => Number(v) || 0;
  const B = (bank || []).map((r) => r.data || r)
    .filter((b) => /^\d{4}-\d{2}-\d{2}/.test(String(b.date || '')))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const J = (journal || []).map((r) => r.data || r);

  const before = B.filter((b) => String(b.date).slice(0, 4) < y);
  const thisYear = B.filter((b) => String(b.date).slice(0, 4) === y);
  const lastBalance = (list) => {
    for (let i = list.length - 1; i >= 0; i--) if (String(list[i].balance || '') !== '') return num(list[i].balance);
    return null;
  };
  const bankOpen = lastBalance(before);
  const bankIn = thisYear.reduce((t, b) => t + num(b['in']), 0);
  const bankOut = thisYear.reduce((t, b) => t + num(b.out), 0);
  const bankEndSeen = lastBalance(thisYear);
  const bankOpenGuess = bankOpen == null && bankEndSeen != null ? bankEndSeen - bankIn + bankOut : bankOpen;
  const bankEnd = bankEndSeen != null ? bankEndSeen : (bankOpenGuess || 0) + bankIn - bankOut;

  // 現金：歷年累計（領出 − 付掉），期初＝去年底為止的累計
  const isCash = (b) => /現金|取款|提款|ATM/.test(String(b.kind || '') + String(b.memo || '') + String(b.note || ''));
  const drawnBefore = before.filter(isCash).reduce((t, b) => t + num(b.out), 0);
  const drawn = thisYear.filter(isCash).reduce((t, b) => t + num(b.out), 0);
  const paidOf = (list) => list.filter((d) => CASH_METHODS.indexOf(String(d.method || '').trim()) !== -1).reduce((t, d) => t + num(d.expense), 0);
  const paidBefore = paidOf(J.filter((d) => String(d.date || '').slice(0, 4) < y));
  const paid = paidOf(J.filter((d) => String(d.date || '').slice(0, 4) === y));

  return {
    year: Number(year),
    bank: { open: bankOpenGuess == null ? 0 : bankOpenGuess, in: bankIn, out: bankOut, end: bankEnd, known: bankEndSeen != null },
    cash: { open: drawnBefore - paidBefore, in: drawn, out: paid, end: (drawnBefore - paidBefore) + drawn - paid },
  };
}

// 讀過就留著，90 秒內再進同一頁不用重抓（寫入之後會自己失效）
const ROWS_CACHE = {};
const ROWS_CACHE_MS = 90000;
function dropRowsCache(object) {
  if (object) delete ROWS_CACHE[object];
  else Object.keys(ROWS_CACHE).forEach((k) => delete ROWS_CACHE[k]);
}

async function loadFinance(objects, fresh) {
  const out = {};
  for (const object of objects) {
    const hit = ROWS_CACHE[object];
    if (!fresh && hit && Date.now() - hit.at < ROWS_CACHE_MS) { out[object] = hit.rows; continue; }
    const first = await db('list', { object: object, limit: 1000 });
    if (!first.ok) { out[object] = null; continue; }
    const rows = first.rows || [];
    let cursor = first.nextCursor;
    while (cursor && rows.length < 20000) {
      const more = await db('list', { object: object, limit: 1000, cursor: cursor });
      if (!more.ok || !(more.rows || []).length) break;
      rows.push.apply(rows, more.rows);
      cursor = more.nextCursor;
    }
    ROWS_CACHE[object] = { at: Date.now(), rows: rows };
    out[object] = rows;
  }
  return out;
}

// 讓一張表格可以拖欄寬（寬度記在這台電腦，key 是這張表的名字）
function makeResizable(table, key) {
  if (!key) return table;
  const pref = colPrefGet(key);
  const ths = Array.from(table.querySelectorAll('thead th'));
  const lock = () => {
    ths.forEach((x) => {
      if (x.style.width) return;
      const w = Math.round(x.getBoundingClientRect().width);
      if (w) x.style.width = w + 'px';
    });
    table.style.tableLayout = 'fixed';
    table.style.width = Math.round(table.getBoundingClientRect().width) + 'px';
    table.classList.add('fixed-cols');
  };
  ths.forEach((th, i) => {
    const saved = pref.width && pref.width[i];
    if (saved) th.style.width = saved + 'px';
    th.style.position = 'relative';
    const grip = el('span');
    grip.title = '按住往左右拉可以調整欄寬（雙擊回到自動）';
    grip.style.cssText = 'position:absolute;top:0;right:-4px;width:9px;height:100%;cursor:col-resize;user-select:none;border-right:2px solid transparent';
    grip.addEventListener('mouseenter', () => { grip.style.borderRightColor = 'var(--accent)'; });
    grip.addEventListener('mouseleave', () => { grip.style.borderRightColor = 'transparent'; });
    grip.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      lock();
      const startX = ev.clientX;
      const startW = th.getBoundingClientRect().width;
      const startTable = table.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      const move = (e) => {
        const next = Math.max(48, Math.round(startW + e.clientX - startX));
        th.style.width = next + 'px';
        table.style.width = Math.max(240, Math.round(startTable + (next - startW))) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        const now = colPrefGet(key);
        now.width = now.width || {};
        now.width[i] = Math.round(th.getBoundingClientRect().width);
        colPrefSet(key, now);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    grip.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const now = colPrefGet(key);
      if (now.width) delete now.width[i];
      colPrefSet(key, now);
      th.style.width = '';
    });
    th.append(grip);
  });
  if (pref.width && Object.keys(pref.width).length) setTimeout(lock, 0);
  return table;
}

// 表格小工具：欄位定義 + 資料列（給 key 就可以調欄寬）
function finTable(columns, items, key) {
  const tw = el('div', 'tw');
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  columns.forEach((c) => { const th = el('th', '', c.label); if (c.right) th.style.textAlign = 'right'; hr.append(th); });
  thead.append(hr);
  const tb = el('tbody');
  items.forEach((x) => {
    const tr = el('tr');
    columns.forEach((c) => {
      const td = el('td', '', c.get(x));
      if (c.right) td.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums';
      if (c.strong) td.style.fontWeight = '600';
      tr.append(td);
    });
    tb.append(tr);
  });
  t.append(thead, tb);
  makeResizable(t, key);
  tw.append(t);
  return tw;
}

async function viewYearly() {
  $('crumb').textContent = '財務 › 年度結餘表';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '年度結餘表'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('本會是現金收支制，不做損益表，改看各年度的收入、支出與結餘。9 字頭（暫收、暫付、內部轉帳）不計入。'));

  const got = await loadFinance(['journal']);
  if (!got.journal) { sheet.append(el('p', 'err', '讀不到日記帳')); return; }
  const years = yearlyOf(got.journal);
  if (!years.length) { info.textContent = '日記帳還沒有資料'; return; }
  const last = years[years.length - 1];
  info.textContent = '共 ' + years.length + ' 個年度　累計結餘 ' + nt(last.accumulated) + ' 元';

  const printBtn = el('button', 'btn quiet');
  printBtn.type = 'button';
  printBtn.append(icon('doc'), el('span', '', '列印這一頁'));
  printBtn.addEventListener('click', () => window.print());
  sheet.append(printBtn);

  sheet.append(finTable([
    { label: '年度', get: (x) => '民國 ' + rocOf(x.year) + ' 年（' + x.year + '）' },
    { label: '筆數', right: 1, get: (x) => String(x.rows) },
    { label: '收入', right: 1, get: (x) => nt(x.income) + ' 元' },
    { label: '支出', right: 1, get: (x) => nt(x.expense) + ' 元' },
    { label: '本年度結餘', right: 1, strong: 1, get: (x) => nt(x.balance) + ' 元' },
    { label: '累計結餘', right: 1, get: (x) => nt(x.accumulated) + ' 元' },
  ], years.slice().reverse(), 'yearly'));
}

async function viewCash() {
  $('crumb').textContent = '財務 › 現金收支餘額表';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '現金收支餘額表'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('現金收支制用這張取代資產負債表：各帳戶的期初、本年度收入與支出、期末。銀行以對帳單的餘額為準；「現金在手」是從銀行領出來、還沒用 LINE Pay／現金付掉的錢。'));

  const got = await loadFinance(['journal', 'bank']);
  if (!got.journal) { sheet.append(el('p', 'err', '讀不到日記帳')); return; }
  if (!got.bank) {
    sheet.append(el('p', 'err', '讀不到銀行明細。請先到試算表按「同步 → 更新設定庫」再按「推上去」。'));
    return;
  }
  const years = {};
  got.journal.concat(got.bank).forEach((r) => { const y = String((r.data || {}).date || '').slice(0, 4); if (/^\d{4}$/.test(y)) years[y] = 1; });
  const list = Object.keys(years).sort().reverse();
  if (!list.length) { info.textContent = '還沒有資料'; return; }
  let year = list[0];

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin:0 0 14px';
  const pickLabel = el('span', '', '年度：');
  pickLabel.style.cssText = 'font-size:12.5px;color:var(--muted)';
  const pick = el('select');
  pick.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink)';
  list.forEach((y) => { const o = el('option', '', '民國 ' + rocOf(Number(y)) + ' 年（' + y + '）'); o.value = y; pick.append(o); });
  const printBtn = el('button', 'btn quiet');
  printBtn.type = 'button';
  printBtn.append(icon('doc'), el('span', '', '列印'));
  printBtn.addEventListener('click', () => window.print());
  bar.append(pickLabel, pick, printBtn);
  sheet.append(bar);
  const out = el('div');
  sheet.append(out);

  const paint = () => {
    const c = cashOf(got.journal, got.bank, year);
    info.textContent = '民國 ' + rocOf(c.year) + ' 年度　期末合計 ' + nt(c.bank.end + c.cash.end) + ' 元（銀行 ' + nt(c.bank.end) + '＋現金在手 ' + nt(c.cash.end) + '）';
    out.replaceChildren();
    out.append(finTable([
      { label: '帳戶', get: (x) => x.name },
      { label: '期初', right: 1, get: (x) => nt(x.open) + ' 元' },
      { label: '本年度收入', right: 1, get: (x) => nt(x.in) + ' 元' },
      { label: '本年度支出', right: 1, get: (x) => nt(x.out) + ' 元' },
      { label: '期末', right: 1, strong: 1, get: (x) => nt(x.end) + ' 元' },
    ], [
      { name: '第一銀行', open: c.bank.open, in: c.bank.in, out: c.bank.out, end: c.bank.end },
      { name: '現金在手（秘書長代墊用）', open: c.cash.open, in: c.cash.in, out: c.cash.out, end: c.cash.end },
      { name: '合計', open: c.bank.open + c.cash.open, in: c.bank.in + c.cash.in, out: c.bank.out + c.cash.out, end: c.bank.end + c.cash.end },
    ], 'cash'));
    if (!c.bank.known) out.append(hint('銀行明細上沒有填餘額，期末是用期初加減本年度收支推出來的。'));
    out.append(hint('現金那一列：「本年度收入」＝從銀行領出的現金，「本年度支出」＝日記帳上付款方式是現金／LINE Pay 的支出。期末不是 0 就表示還有錢在手上（或有單還沒記帳）。'));
  };
  pick.addEventListener('change', () => { year = pick.value; paint(); });
  paint();
}


// ── 匯入銀行對帳單 ──────────────────────────────────────
// 網銀下載的檔案直接丟進來：CSV 自己解析，XLS／XLSX 用 SheetJS（第一銀行的 .xls 其實是 HTML 表格，也讀得動）。
// 每一列算一個「核對碼」＝日期｜摘要｜支出｜存入｜餘額，同一份檔案匯第二次不會變兩筆。

// CSV → 二維陣列（支援引號內的逗號與換行）
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const t = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 二維陣列 → 銀行明細的列。找含「交易日期」的那一列當標題。
function bankRowsFrom(grid) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, '');
  const at = (grid || []).findIndex((r) => (r || []).some((v) => clean(v).indexOf('交易日期') !== -1));
  if (at < 0) return { error: '這個檔案裡找不到「交易日期」那一列，可能不是對帳單，或格式不一樣。' };
  const head = (grid[at] || []).map(clean);
  const col = (name) => head.findIndex((x) => x.indexOf(name) !== -1);
  const idx = { date: col('交易日期'), kind: col('交易類別'), out: col('支出'), in: col('存入'), balance: col('餘額'), state: col('狀態'), note: col('備註'), memo: col('摘要') };
  const num = (v) => {
    const n = Number(String(v == null ? '' : v).replace(/[,\s元$]/g, ''));
    return isNaN(n) || !n ? 0 : n;
  };
  const date = (v) => {
    const t = String(v == null ? '' : v).trim();
    if (!t) return '';
    const m = /^(\d{4})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})/.exec(t);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    const d = new Date(t);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  };
  const text = (r, i) => (i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim());
  const rows = [];
  const bad = [];
  grid.slice(at + 1).forEach((r) => {
    if (!r || !r.length) return;
    const d = date(r[idx.date]);
    if (!d) { if ((r || []).some((v) => String(v || '').trim())) bad.push(r.join(' ').slice(0, 40)); return; }
    const row = {
      date: d, kind: text(r, idx.kind), out: num(r[idx.out]), in: num(r[idx.in]),
      balance: num(r[idx.balance]), state: text(r, idx.state), note: text(r, idx.note), memo: text(r, idx.memo),
    };
    row.fp = [row.date, row.memo, row.out, row.in, row.balance].join('|');
    if (!row.out && !row.in) return; // 沒有金額的列（小計、說明）不要
    rows.push(row);
  });
  return { rows: rows, bad: bad };
}

// 需要 SheetJS 時才載入（CSV 不用）
let sheetJsReady = null;
function loadSheetJs() {
  if (sheetJsReady) return sheetJsReady;
  sheetJsReady = new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    tag.onload = () => resolve(window.XLSX);
    tag.onerror = () => reject(new Error('載不到試算表解析程式，請改用 CSV 檔'));
    document.head.append(tag);
  });
  return sheetJsReady;
}

async function viewBankImport() {
  $('crumb').textContent = '財務 › 匯入對帳單';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '把網銀下載的對帳單丟進來');
  box.append(el('h1', 'page', '匯入對帳單'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('第一銀行網銀下載的檔案（.csv／.xls／.xlsx）都可以。系統會自己找「交易日期」那一列當標題，同一份檔案匯第二次不會重複——每一列都比對日期、摘要、支出、存入、餘額。'));

  // 丟檔案的地方
  const drop = el('div');
  drop.style.cssText = 'border:1.5px dashed var(--line);border-radius:12px;padding:28px 18px;text-align:center;margin:4px 0 16px;cursor:pointer;background:var(--sub)';
  const dropText = el('p', '', '把檔案拖進來，或點一下選檔案');
  dropText.style.cssText = 'margin:0;color:var(--muted);font-size:13px';
  drop.append(dropText);
  const picker = el('input');
  picker.type = 'file';
  picker.accept = '.csv,.xls,.xlsx,text/csv';
  picker.style.display = 'none';
  sheet.append(drop, picker);
  const out = el('div');
  sheet.append(out);

  const read = async (file) => {
    out.replaceChildren(el('p', 'hint', '讀取中…'));
    let grid = null;
    try {
      if (/\.csv$/i.test(file.name)) {
        grid = parseCsv(await file.text());
      } else {
        const XLSX = await loadSheetJs();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const first = wb.Sheets[wb.SheetNames[0]];
        grid = XLSX.utils.sheet_to_json(first, { header: 1, raw: false, defval: '' });
      }
    } catch (err) {
      out.replaceChildren(el('p', 'err', '讀不了這個檔案：' + (err.message || err)));
      return;
    }
    const got = bankRowsFrom(grid);
    if (got.error) { out.replaceChildren(el('p', 'err', got.error)); return; }
    if (!got.rows.length) { out.replaceChildren(el('p', 'err', '這個檔案裡沒有看得懂的交易列。')); return; }
    preview(file.name, got);
  };

  const preview = (name, got) => {
    out.replaceChildren();
    const rows = got.rows;
    const first = rows[0], last = rows[rows.length - 1];
    out.append(el('p', '', name + '：讀到 ' + rows.length + ' 筆，' + first.date + ' ～ ' + last.date));
    out.append(finTable([
      { label: '交易日期', get: (x) => x.date },
      { label: '摘要', get: (x) => x.memo || x.kind },
      { label: '支出', right: 1, get: (x) => (x.out ? nt(x.out) : '') },
      { label: '存入', right: 1, get: (x) => (x.in ? nt(x.in) : '') },
      { label: '餘額', right: 1, get: (x) => (x.balance ? nt(x.balance) : '') },
    ], rows.slice(0, 12)));
    if (rows.length > 12) out.append(el('p', 'hint', '…還有 ' + (rows.length - 12) + ' 筆'));
    if (got.bad.length) out.append(el('p', 'hint', '有 ' + got.bad.length + ' 列看不懂日期，會跳過（通常是表頭或小計）。'));

    const bar = el('div');
    bar.style.cssText = 'display:flex;gap:8px;margin:16px 0 0';
    const go = el('button', 'btn pri');
    go.type = 'button';
    go.append(icon('check'), el('span', '', '匯入這 ' + rows.length + ' 筆'));
    const cancel = el('button', 'btn quiet');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => out.replaceChildren());
    bar.append(go, cancel);
    const msg = el('p', 'hint');
    out.append(bar, msg);

    go.addEventListener('click', async () => {
      go.disabled = true;
      msg.textContent = '匯入中…';
      let created = 0;
      let merged = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const r = await db('bulk', { object: 'bank', rows: rows.slice(i, i + 200), dedupe: ['fp'], who: '上傳對帳單' });
        dropRowsCache('bank');
        if (!r.ok) {
          msg.className = 'err';
          msg.textContent = '沒有成功：' + (r.message || r.error);
          go.disabled = false;
          return;
        }
        created += r.created || 0;
        merged += r.merged || 0;
      }
      msg.className = 'hint';
      msg.textContent = '完成：新增 ' + created + ' 筆' + (merged ? '、已經有了 ' + merged + ' 筆（跳過）' : '') + '。可以到「對帳」看這個月對得平不平。';
    });
  };

  drop.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => { if (picker.files[0]) read(picker.files[0]); });
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.style.borderColor = 'var(--accent)'; }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.style.borderColor = 'var(--line)'; }));
  drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (f) read(f); });
}


// ── 書籍庫存（進銷存）────────────────────────────────────
// 一本一列。沒填來源也沒填用途＝還在庫；填了就是賣掉或送出去了。
function stockOf(rows) {
  const byEdition = {};
  (rows || []).forEach((r) => {
    const d = r.data || r;
    const edition = String(d.edition || '（沒填版次）').trim();
    const box = byEdition[edition] || (byEdition[edition] = {
      edition: edition, printed: 0, used: 0, held: 0, left: 0, income: 0, cost: 0, lastSeq: 0, bySource: {},
    });
    box.printed++;
    const seq = Number(d.seq) || 0;
    if (seq > box.lastSeq) box.lastSeq = seq;
    // 舊資料沒有「狀態」欄：有來源或用途就當已出，否則在庫
    const state = String(d.state || '').trim() || ((String(d.source || '').trim() || String(d.use || '').trim()) ? '已出' : '在庫');
    if (state === '在庫') { box.left++; return; }
    if (state === '預留') { box.held++; box.income += Number(d.income) || 0; const k0 = String(d.source || '（預留）').trim(); box.bySource[k0] = (box.bySource[k0] || 0) + 1; return; }
    box.used++;
    box.income += Number(d.income) || 0;
    box.cost += Number(d.cost) || 0;
    const key = String(d.source || '（沒填來源）').trim();
    box.bySource[key] = (box.bySource[key] || 0) + 1;
  });
  return Object.keys(byEdition).sort().map((k) => byEdition[k]);
}

// 進貨：某個版次再加 n 本（流水號接在最後一本後面）
async function stockAdd(edition, count, source, note) {
  const got = await loadFinance(['book_copy']);
  const rows = (got.book_copy || []).filter((r) => String((r.data || {}).edition || '').trim() === edition);
  let last = 0;
  rows.forEach((r) => { const n = Number((r.data || {}).seq) || 0; if (n > last) last = n; });
  const list = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      edition: edition, seq: last + i,
      state: '在庫', source: source || '', note: note || '',
      fp: edition + '｜' + (last + i),
    });
  }
  const done = await db('bulk', { object: 'book_copy', rows: list, dedupe: ['fp'], who: '新增庫存' });
  dropRowsCache('book_copy');
  return done;
}

// 出庫：從還在庫的裡面照流水號拿 n 本，填上來源、用途
async function stockTake(edition, count, data) {
  const got = await loadFinance(['book_copy']);
  const free = (got.book_copy || [])
    .filter((r) => String((r.data || {}).edition || '').trim() === edition)
    .filter((r) => { const d = r.data || {}; const st = String(d.state || '').trim() || ((String(d.source || '').trim() || String(d.use || '').trim()) ? '已出' : '在庫'); return st === '在庫'; })
    .sort((a, b) => (Number((a.data || {}).seq) || 0) - (Number((b.data || {}).seq) || 0));
  if (free.length < count) return { ok: false, message: '庫存只剩 ' + free.length + ' 本，不夠出 ' + count + ' 本。' };
  const take = free.slice(0, count);
  const from = Number(take[0].data.seq) || 0;
  const to = Number(take[take.length - 1].data.seq) || 0;
  for (let i = 0; i < take.length; i++) {
    const r = take[i];
    const patch = Object.assign({}, r.data, {
      state: '已出',
      out_at: new Date().toISOString().slice(0, 10),
      source: data.source,
      use: i === 0 ? data.use : '↑ 同上',
      income: i === 0 ? data.income : '',
      note: i === 0 ? (data.note || '') + (count > 1 ? '（共 ' + count + ' 本，第 ' + from + '～' + to + ' 本）' : '') : '↑ 同上',
    });
    const saved = await db('save', { object: 'book_copy', id: r.id, data: patch });
    dropRowsCache('book_copy');
    if (!saved.ok) return { ok: false, message: '第 ' + r.data.seq + ' 本沒有成功：' + (saved.message || saved.error) };
  }
  return { ok: true, from: from, to: to, count: count };
}

async function viewStock() {
  $('crumb').textContent = '資料 › 書籍庫存';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '書籍庫存'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('一本一列，流水號就是第幾本。每一本有三種狀態：在庫（可以賣）、預留（訂單已收款、書先鎖起來還沒寄出）、已出（真的離開了）。訂單確認收款時自動從流水號最小的在庫本預留；按「標記已出貨／已面交」時才轉成已出。要調整某一本（送人、損毀、記錯），到下面的清單點那一列改。'));

  const got = await loadFinance(['book_copy']);
  if (!got.book_copy) { sheet.append(el('p', 'err', '讀不到書籍庫存。請先到試算表按「同步 → 更新設定庫」，再按「搬家：匯入書籍庫存（只做一次）」。')); return; }
  const rows = got.book_copy;
  if (!rows.length) { info.textContent = '還沒有資料'; sheet.append(el('p', 'hint', '請到試算表選單「同步 → 搬家：匯入書籍庫存（只做一次）」把現在那份銷售紀錄搬進來。')); return; }
  const list = stockOf(rows);
  const editions = list.map((x) => x.edition);

  // 進貨與出庫
  const tools = el('div');
  tools.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 16px';
  if (canEdit((META.objects || []).find((o) => o.id === 'book_copy') || {})) {
    const addBtn = el('button', 'btn pri');
    addBtn.type = 'button';
    addBtn.append(icon('check'), el('span', '', '新增庫存（進貨）'));
    addBtn.addEventListener('click', () => stockForm('add', editions));
    const outBtn = el('button', 'btn');
    outBtn.type = 'button';
    outBtn.append(icon('out'), el('span', '', '出庫登記（贈送、現場販售…）'));
    outBtn.addEventListener('click', () => stockForm('take', editions));
    const syncBtn = el('button', 'btn quiet');
    syncBtn.type = 'button';
    syncBtn.append(icon('check'), el('span', '', '跟訂單對一下'));
    syncBtn.addEventListener('click', async () => {
      const old = syncBtn.textContent;
      syncBtn.disabled = true;
      syncBtn.replaceChildren(el('span', '', '對帳中…'));
      const r = await appsScript({ action: 'orderBulk', token: sessionStorageToken(), what: 'stocksync', ids: [] });
      syncBtn.disabled = false;
      syncBtn.replaceChildren(icon('check'), el('span', '', old));
      if (!r || !r.ok) return alert('沒有成功：' + ((r && (r.message || r.error)) || '未知原因'));
      alert('對完了：' + String.fromCharCode(10) +
        '・鎖起來（預留）' + r.reserved + ' 本' + String.fromCharCode(10) +
        '・標成已出 ' + r.shipped + ' 本' + String.fromCharCode(10) +
        '・放回在庫 ' + r.released + ' 本' +
        ((r.notes || []).length ? String.fromCharCode(10) + String.fromCharCode(10) + r.notes.join(String.fromCharCode(10)) : '') +
        ((r.missing || []).length ? String.fromCharCode(10) + String.fromCharCode(10) + '庫存不夠的：' + String.fromCharCode(10) + r.missing.join(String.fromCharCode(10)) : ''));
      dropRowsCache('book_copy');
      viewStock();
    });
    tools.append(addBtn, outBtn, syncBtn);
    sheet.append(tools);
  }
  const total = list.reduce((t, x) => ({ printed: t.printed + x.printed, used: t.used + x.used, held: t.held + x.held, left: t.left + x.left, income: t.income + x.income }), { printed: 0, used: 0, held: 0, left: 0, income: 0 });
  info.textContent = '印了 ' + total.printed + ' 本　在庫 ' + total.left + ' 本　預留 ' + total.held + ' 本　已出 ' + total.used + ' 本　累計收入 ' + nt(total.income) + ' 元';

  const cards = el('div', 'tiles');
  [['印量（進）', total.printed + ' 本'], ['在庫（可賣）', total.left + ' 本'], ['預留（已收款待出貨）', total.held + ' 本'], ['已出（銷）', total.used + ' 本'], ['累計收入', nt(total.income) + ' 元']].forEach((pair) => {
    const c = el('div', 'tile');
    c.append(el('div', 'k', pair[0]), el('div', 'n', pair[1]));
    cards.append(c);
  });
  sheet.append(cards);

  // 一個版次一列
  const h2 = el('h2', '', '各版次');
  h2.style.cssText = 'font-size:14px;margin:18px 0 8px;color:var(--ink)';
  sheet.append(h2);
  sheet.append(finTable([
    { label: '版次', get: (x) => x.edition },
    { label: '印量', right: 1, get: (x) => x.printed + ' 本' },
    { label: '已出', right: 1, get: (x) => x.used + ' 本' },
    { label: '預留', right: 1, get: (x) => (x.held ? x.held + ' 本' : '') },
    { label: '在庫', right: 1, strong: 1, get: (x) => x.left + ' 本' },
    { label: '累計收入', right: 1, get: (x) => nt(x.income) + ' 元' },
    { label: '出去的用途', get: (x) => Object.keys(x.bySource).sort((a, b) => x.bySource[b] - x.bySource[a]).map((k) => k + ' ' + x.bySource[k]).join('、') },
  ], list, 'stock.editions'));

  // 下面：版次分頁，內容就是那一刷的每一本
  const editionTabs = el('div', 'tabs');
  editionTabs.style.cssText = 'margin:18px 0 10px';
  const stateBar = el('div');
  stateBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px';
  const bulkBar = el('div');
  bulkBar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px';
  bulkBar.hidden = true;
  const listBox = el('div');
  sheet.append(editionTabs, stateBar, bulkBar, listBox);
  const picked = {}; // 勾起來的那幾本

  const stateOf = (d) => String(d.state || '').trim() || ((String(d.source || '').trim() || String(d.use || '').trim()) ? '已出' : '在庫');
  // 預設打開最新那一刷：還有在庫的優先，其餘取排在最後面的
  const withStock = list.filter((x) => x.left > 0);
  let edition = (withStock.length ? withStock[withStock.length - 1] : list[list.length - 1]).edition;
  let stateFilter = '已登記'; // 空白的（還在庫、沒登記過）預設不顯示

  const paintList = () => {
    // 這一刷的每一本，照流水號由小到大
    // 最新登記的排最上面（第 1 本在最下面）
    const mine = rows
      .filter((r) => String((r.data || {}).edition || '').trim() === edition)
      .sort((a, b) => (Number((b.data || {}).seq) || 0) - (Number((a.data || {}).seq) || 0));
    // 「已登記」＝有寫過東西的（預留、已出，或在庫但有備註）；空白的本數不列
    const logged = (d) => stateOf(d) !== '在庫' || String(d.source || '').trim() || String(d.use || '').trim() || String(d.note || '').trim();
    const count = { 在庫: 0, 預留: 0, 已出: 0, 已登記: 0 };
    mine.forEach((r) => {
      const d = r.data || {};
      count[stateOf(d)] = (count[stateOf(d)] || 0) + 1;
      if (logged(d)) count.已登記++;
    });

    // 狀態篩選
    stateBar.replaceChildren();
    [['已登記', count['已登記'] || 0], ['預留', count['預留'] || 0], ['已出', count['已出'] || 0], ['在庫', count['在庫'] || 0], ['全部', mine.length]].forEach((pair) => {
      const b = el('button', 'btn quiet');
      b.type = 'button';
      b.style.cssText = 'padding:4px 11px;font-size:12.5px;border-radius:20px' +
        (stateFilter === pair[0] ? ';background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft)' : '');
      b.append(el('span', '', pair[0] + '（' + pair[1] + '）'));
      b.addEventListener('click', () => { stateFilter = pair[0]; paintList(); });
      stateBar.append(b);
    });

    const shown = stateFilter === '全部' ? mine
      : stateFilter === '已登記' ? mine.filter((r) => logged(r.data || {}))
      : mine.filter((r) => stateOf(r.data || {}) === stateFilter);
    listBox.replaceChildren();
    if (!shown.length) {
      listBox.append(el('p', 'hint', '這一刷沒有' + (stateFilter === '全部' ? '任何紀錄' : stateFilter === '已登記' ? '登記過的書（都還在庫）' : stateFilter + '的書') + '。'));
      return;
    }
    const newest = Number(shown[0].data.seq) || 0;
    const oldest = Number(shown[shown.length - 1].data.seq) || 0;
    listBox.append(el('p', 'hint', edition + '：第 ' + oldest + '～' + newest + ' 本，共 ' + shown.length + ' 筆，最新登記的在最上面。' +
      (stateFilter === '已登記' && count['在庫'] ? '還有 ' + count['在庫'] + ' 本在庫還沒登記（按上面的「在庫」看）。' : '') +
      '點任何一列可以改那一本（例如送人、損毀、記錯）。'));
    const obj = (META.objects || []).find((o) => o.id === 'book_copy');
    const table = finTable([
      {
        label: '', get: () => '',
      },
      { label: '第幾本', right: 1, get: (x) => String(x.data.seq || '') },
      { label: '狀態', get: (x) => stateOf(x.data) },
      { label: '來源', get: (x) => String(x.data.source || '') },
      { label: '用途', get: (x) => String(x.data.use || '') },
      { label: '寄出方式', get: (x) => String(x.data.ship || '') },
      { label: '收入', right: 1, get: (x) => (Number(x.data.income) ? nt(x.data.income) + ' 元' : '') },
      { label: '訂單', get: (x) => String(x.data.order_no || '') },
      { label: '出庫日期', get: (x) => String(x.data.out_at || '') },
      { label: '備註', get: (x) => String(x.data.note || '') },
    ], shown, 'stock.list');
    Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
      const row = shown[i];
      if (!row) return;
      // 第一格放勾選框
      const cell = tr.querySelector('td');
      if (cell) {
        cell.style.width = '34px';
        const box = el('input');
        box.type = 'checkbox';
        box.checked = Boolean(picked[row.id]);
        box.style.cssText = 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer';
        box.addEventListener('click', (e) => e.stopPropagation());
        box.addEventListener('change', () => { if (box.checked) picked[row.id] = row; else delete picked[row.id]; paintBulk(shown); });
        cell.append(box);
      }
      if (obj) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => openDrawer(obj, row));
      }
    });
    listBox.append(table);
    paintBulk(shown);
  };

  // 勾選之後可以一起改狀態
  const paintBulk = (shown) => {
    const ids = Object.keys(picked);
    bulkBar.replaceChildren();
    bulkBar.hidden = false;
    const all = el('button', 'btn quiet');
    all.type = 'button';
    const everyShown = shown.length > 0 && shown.every((r) => picked[r.id]);
    all.append(el('span', '', everyShown ? '取消全選' : '全選這一頁（' + shown.length + '）'));
    all.addEventListener('click', () => {
      if (everyShown) shown.forEach((r) => delete picked[r.id]);
      else shown.forEach((r) => (picked[r.id] = r));
      paintList();
    });
    bulkBar.append(all);
    const count = el('span', '', ids.length ? '已勾選 ' + ids.length + ' 本' : '勾選後可以一次改狀態');
    count.style.cssText = 'font-size:12.5px;color:var(--muted)';
    bulkBar.append(count);

    const act = (label, run) => {
      const b = el('button', 'btn' + (ids.length ? ' pri' : ''));
      b.type = 'button';
      b.disabled = !ids.length;
      b.append(el('span', '', label));
      b.addEventListener('click', async () => {
        b.disabled = true;
        await run(ids.map((id) => picked[id]));
        b.disabled = false;
      });
      bulkBar.append(b);
    };

    const save = async (list, patchOf) => {
      for (const row of list) {
        const data = Object.assign({}, row.data, patchOf(row));
        const r = await db('save', { object: 'book_copy', id: row.id, data: data });
        if (!r.ok) { alert('第 ' + row.data.seq + ' 本沒有成功：' + (r.message || r.error)); break; }
      }
      Object.keys(picked).forEach((k) => delete picked[k]);
      dropRowsCache('book_copy');
      viewStock();
    };

    act('標為已出…', async (list) => {
      const source = window.prompt('這幾本的去向（來源欄）：贈送／現場販售／樣書／損毀／其他', '贈送');
      if (source === null || !source.trim()) return;
      const use = window.prompt('給誰／做什麼（用途欄）', '');
      if (use === null) return;
      await save(list, (row, i) => ({ state: '已出', source: source.trim(), use: use.trim() || row.data.use || '', out_at: new Date().toISOString().slice(0, 10) }));
    });
    act('標為預留', async (list) => {
      if (!window.confirm('把勾選的 ' + list.length + ' 本標成「預留」？')) return;
      await save(list, () => ({ state: '預留' }));
    });
    act('放回在庫', async (list) => {
      if (!window.confirm('把勾選的 ' + list.length + ' 本放回「在庫」？來源、用途、訂單編號會清掉。')) return;
      await save(list, () => ({ state: '在庫', source: '', use: '', ship: '', income: '', order_no: '', out_at: '', note: '' }));
    });
    if (ids.length) {
      const clear = el('button', 'btn quiet');
      clear.type = 'button';
      clear.append(el('span', '', '清除勾選'));
      clear.addEventListener('click', () => { Object.keys(picked).forEach((k) => delete picked[k]); paintList(); });
      bulkBar.append(clear);
    }
  };

  const paintTabs = () => {
    editionTabs.replaceChildren();
    list.forEach((x) => {
      const b = el('button', 'tab' + (edition === x.edition ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', '', x.edition + '（在庫 ' + x.left + '）'));
      b.addEventListener('click', () => { edition = x.edition; paintTabs(); paintList(); });
      editionTabs.append(b);
    });
  };
  paintTabs();
  paintList();
}
// 進貨／出庫的小表單，從右邊滑出來
function stockForm(mode, editions) {
  const d = ensureDrawer();
  const add = mode === 'add';
  d.title.replaceChildren(el('span', '', add ? '新增庫存（進貨）' : '出庫登記'));
  d.body.replaceChildren();
  d.body.append(hint(add
    ? '印了一刷、或收到一批書的時候用。會照這個版次現有的最後一本往下編號。'
    : '公關贈送、現場販售、樣書這些不是從官網訂單出去的，在這裡登記。會從還在庫的裡面照流水號拿。'));

  const field = (label, node, help) => {
    const wrap = el('div', 'fld');
    wrap.append(el('label', '', label), node);
    if (help) { const t = el('small', '', help); t.style.cssText = 'color:var(--muted);font-size:12px'; wrap.append(t); }
    d.body.append(wrap);
    return node;
  };
  const style = 'font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);width:100%';

  const editionInput = el('input');
  editionInput.setAttribute('list', 'stock-editions');
  editionInput.style.cssText = style;
  editionInput.value = editions[editions.length - 1] || '';
  const datalist = el('datalist');
  datalist.id = 'stock-editions';
  editions.forEach((x) => { const o = el('option'); o.value = x; datalist.append(o); });
  d.body.append(datalist);
  field('版次', editionInput, add ? '新的一刷直接打新名字，例如「二版二刷」' : '');

  const countInput = el('input');
  countInput.type = 'number';
  countInput.min = '1';
  countInput.value = add ? '100' : '1';
  countInput.style.cssText = style;
  field(add ? '這一批幾本' : '出幾本', countInput);

  let sourceInput = null;
  let useInput = null;
  let incomeInput = null;
  if (!add) {
    sourceInput = el('select');
    sourceInput.style.cssText = style;
    ['贈送', '現場販售', '樣書', '損毀', '其他'].forEach((x) => { const o = el('option', '', x); o.value = x; sourceInput.append(o); });
    field('來源（出去的原因）', sourceInput);
    useInput = el('input');
    useInput.style.cssText = style;
    field('用途（給誰／做什麼）', useInput, '例：臺中市政府王科長、11/30 會員大會');
    incomeInput = el('input');
    incomeInput.type = 'number';
    incomeInput.style.cssText = style;
    field('收入（沒收錢就留白）', incomeInput);
  }
  const noteInput = el('input');
  noteInput.style.cssText = style;
  field('備註', noteInput, add ? '例：2026/11 二刷 100 本，印刷費 18,000' : '');

  const msg = el('p', 'err');
  msg.hidden = true;
  d.body.append(msg);
  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)';
  const go = el('button', 'btn pri');
  go.type = 'button';
  go.append(icon('check'), el('span', '', add ? '加入庫存' : '登記出庫'));
  const cancel = el('button', 'btn quiet');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => d.hide());
  bar.append(go, cancel);
  d.body.append(bar);

  go.addEventListener('click', async () => {
    const edition = editionInput.value.trim();
    const count = Math.floor(Number(countInput.value) || 0);
    const fail = (text) => { msg.textContent = text; msg.hidden = false; go.disabled = false; };
    go.disabled = true;
    msg.hidden = true;
    if (!edition) return fail('要填版次。');
    if (!(count > 0)) return fail('本數要大於 0。');
    if (add) {
      const r = await stockAdd(edition, count, '', noteInput.value.trim());
      if (!r.ok) return fail('沒有成功：' + (r.message || r.error));
      d.hide();
      alert(edition + ' 加了 ' + (r.created || count) + ' 本。');
      return viewStock();
    }
    if (!useInput.value.trim()) return fail('要填用途（給誰／做什麼）。');
    const r = await stockTake(edition, count, {
      source: sourceInput.value, use: useInput.value.trim(),
      income: incomeInput.value.trim() ? Number(incomeInput.value) : '',
      note: noteInput.value.trim(),
    });
    if (!r.ok) return fail(r.message || '沒有成功');
    d.hide();
    alert('已登記出庫：' + edition + ' 第 ' + r.from + (r.count > 1 ? '～' + r.to : '') + ' 本。');
    viewStock();
  });

  d.scrim.classList.add('on');
  d.drawer.classList.add('on');
  d.body.scrollTop = 0;
}


// ── 挑要顯示哪些欄位 ────────────────────────────────────
// 勾選、上下移動排順序，存在這台電腦的瀏覽器裡（不影響別人）。
function colChooser(obj, objectId, defaultCols) {
  const d = ensureDrawer();
  const pref = colPrefGet(objectId);
  const all = obj.fields.slice();
  let order = (pref.show && pref.show.length ? pref.show : defaultCols).filter((k) => all.some((f) => f.key === k));
  all.forEach((f) => { if (order.indexOf(f.key) === -1) order.push(f.key); });
  const shown = {};
  (pref.show && pref.show.length ? pref.show : defaultCols).forEach((k) => (shown[k] = true));

  d.title.replaceChildren(el('span', '', obj.label + '：顯示欄位'));
  d.body.replaceChildren();
  d.body.append(hint('勾起來的會出現在清單上，由上到下就是欄位的順序。欄寬在清單上拖欄位的右邊界就能調（雙擊邊界回到自動）。這些設定只記在這台電腦。'));

  const listBox = el('div');
  listBox.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin:6px 0 0';
  d.body.append(listBox);

  const paint = () => {
    listBox.replaceChildren();
    order.forEach((key, i) => {
      const f = all.filter((x) => x.key === key)[0];
      if (!f) return;
      const row = el('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:' + (shown[key] ? 'var(--sub)' : 'transparent');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = Boolean(shown[key]);
      box.addEventListener('change', () => { shown[key] = box.checked; paint(); });
      const name = el('span', '', f.label);
      name.style.cssText = 'flex:1;font-size:13.5px' + (shown[key] ? '' : ';color:var(--muted)');
      const p = PRIVACY[f.privacy];
      const tag = p ? el('span', 'chip ' + p[1], p[0]) : el('span');
      const move = (step) => {
        const at = order.indexOf(key);
        const to = at + step;
        if (to < 0 || to >= order.length) return;
        order.splice(at, 1);
        order.splice(to, 0, key);
        paint();
      };
      const up = el('button', 'btn quiet');
      up.type = 'button';
      up.style.cssText = 'padding:2px 8px';
      up.textContent = '↑';
      up.disabled = i === 0;
      up.addEventListener('click', () => move(-1));
      const down = el('button', 'btn quiet');
      down.type = 'button';
      down.style.cssText = 'padding:2px 8px';
      down.textContent = '↓';
      down.disabled = i === order.length - 1;
      down.addEventListener('click', () => move(1));
      row.append(box, name, tag, up, down);
      listBox.append(row);
    });
  };
  paint();

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)';
  const save = el('button', 'btn pri');
  save.type = 'button';
  save.append(icon('check'), el('span', '', '套用'));
  save.addEventListener('click', () => {
    const show = order.filter((k) => shown[k]);
    if (!show.length) { alert('至少要留一個欄位。'); return; }
    const next = colPrefGet(objectId);
    next.show = show;
    colPrefSet(objectId, next);
    d.hide();
    viewObject(objectId);
  });
  const reset = el('button', 'btn quiet');
  reset.type = 'button';
  reset.append(el('span', '', '回到預設'));
  reset.addEventListener('click', () => {
    colPrefClear(objectId);
    d.hide();
    viewObject(objectId);
  });
  const cancel = el('button', 'btn quiet');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => d.hide());
  bar.append(save, reset, cancel);
  d.body.append(bar);

  d.scrim.classList.add('on');
  d.drawer.classList.add('on');
  d.body.scrollTop = 0;
}


// ── 收入登錄／支出登錄 ──────────────────────────────────
// 官網來的訂單、報名、會費、請款撥款都會自動進日記帳；
// 這一頁是給「沒有經過官網」的那些：贊助、補助、捐款、網銀直接轉給廠商、自動扣繳…
async function viewLedgerEntry(kind) {
  const income = kind === 'in';
  const title = income ? '收入登錄' : '支出登錄';
  $('crumb').textContent = '財務 › ' + title;
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', income ? '贊助、補助、捐款這些沒有經過官網的收入，在這裡記一筆' : '本會帳戶直接付出去的錢（轉帳給廠商、自動扣繳、秘書薪資）');
  box.append(el('h1', 'page', title), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint(income
    ? '官網的書籍訂單、課程報名、會費繳納都會自動寫進日記帳，不用在這裡重複登記。'
    : '志工或您先墊的錢走「志工請款」，撥款時會自動寫帳；這一頁是本會帳戶直接付出去的。'));

  const got = await loadFinance(['account', 'journal']);
  const accounts = (got.account || [])
    .map((r) => r.data || {})
    .filter((d) => String(d.code || '').trim())
    .filter((d) => (income ? /^4/ : /^[59]/).test(String(d.code).trim()))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const field = (label, node, help) => {
    const wrap = el('div', 'fld');
    wrap.style.cssText = 'margin:0 0 12px';
    wrap.append(el('label', '', label), node);
    if (help) { const t = el('small', '', help); t.style.cssText = 'color:var(--muted);font-size:12px'; wrap.append(t); }
    return wrap;
  };
  const style = 'font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);width:100%';
  const form = el('div');
  form.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px;max-width:760px';

  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.style.cssText = style;
  dateInput.value = new Date().toISOString().slice(0, 10);
  const amountInput = el('input');
  amountInput.type = 'number';
  amountInput.min = '0';
  amountInput.style.cssText = style;
  const summaryInput = el('input');
  summaryInput.style.cssText = style;
  summaryInput.placeholder = income ? '例：臺中市政府社區營造補助款' : '例：11 月官網主機費';
  const targetInput = el('input');
  targetInput.style.cssText = style;
  targetInput.placeholder = income ? '誰給的' : '付給誰';
  const codeInput = el('select');
  codeInput.style.cssText = style;
  accounts.forEach((a) => {
    const o = el('option', '', a.code + '　' + (a.name || ''));
    o.value = a.code;
    codeInput.append(o);
  });
  if (!accounts.length) { const o = el('option', '', '（讀不到科目表）'); o.value = ''; codeInput.append(o); }
  const methodInput = el('select');
  methodInput.style.cssText = style;
  ['銀行', '現金', '其他'].forEach((m) => { const o = el('option', '', m); o.value = m; methodInput.append(o); });
  const noInput = el('input');
  noInput.style.cssText = style;
  noInput.placeholder = income ? '例：收據 1024' : '例：發票 AB12345678';
  const taskInput = el('input');
  taskInput.style.cssText = style;
  taskInput.placeholder = '例：中秋音樂會（沒有就留白）';
  const noteInput = el('input');
  noteInput.style.cssText = style;

  form.append(field('日期', dateInput), field('金額', amountInput));
  form.append(field('摘要', summaryInput, '帳上會看到的那一句'));
  form.append(field(income ? '對象（誰給的）' : '對象（付給誰）', targetInput));
  form.append(field('會計科目', codeInput, income ? '4 開頭是收入科目' : '5 開頭是支出科目；9 開頭是暫收暫付'));
  form.append(field('付款方式', methodInput, '銀行＝經本會帳戶，對帳時會去比對銀行明細'));
  form.append(field(income ? '單號／收據編號' : '單號／發票號碼', noInput));
  form.append(field('任務／活動', taskInput));
  form.append(field('備註', noteInput));
  sheet.append(form);

  const msg = el('p', 'err');
  msg.hidden = true;
  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;margin:6px 0 0';
  const save = el('button', 'btn pri');
  save.type = 'button';
  save.append(icon('check'), el('span', '', '記一筆'));
  bar.append(save);
  sheet.append(msg, bar);

  // 最近登記的（同一種進出）
  const recent = el('div');
  recent.style.cssText = 'margin:22px 0 0';
  sheet.append(recent);
  const paintRecent = (rows) => {
    const mine = (rows || [])
      .map((r) => r.data || {})
      .filter((d) => (income ? Number(d.income) > 0 : Number(d.expense) > 0))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 10);
    recent.replaceChildren();
    if (!mine.length) return;
    const h = el('h2', '', '最近 10 筆' + (income ? '收入' : '支出'));
    h.style.cssText = 'font-size:14px;margin:0 0 8px;color:var(--ink)';
    recent.append(h);
    recent.append(finTable([
      { label: '日期', get: (x) => String(x.date || '').slice(0, 10) },
      { label: '摘要', get: (x) => String(x.summary || '') },
      { label: '科目', get: (x) => String(x.code || '') },
      { label: '對象', get: (x) => String(x.target || '') },
      { label: '金額', right: 1, get: (x) => nt(income ? x.income : x.expense) + ' 元' },
      { label: '來源', get: (x) => String(x.source || '') },
    ], mine, 'ledger.' + kind));
  };
  paintRecent(got.journal);

  save.addEventListener('click', async () => {
    const amount = Math.round(Number(amountInput.value) || 0);
    const fail = (text) => { msg.textContent = text; msg.hidden = false; save.disabled = false; };
    save.disabled = true;
    msg.hidden = true;
    if (!dateInput.value) return fail('要填日期。');
    if (!(amount > 0)) return fail('金額要大於 0。');
    if (!summaryInput.value.trim()) return fail('要填摘要。');
    if (!codeInput.value) return fail('要挑一個會計科目。');
    const data = {
      date: dateInput.value,
      source: income ? '收入登錄' : '支出登錄',
      no: noInput.value.trim(),
      summary: summaryInput.value.trim(),
      code: codeInput.value,
      income: income ? amount : '',
      expense: income ? '' : amount,
      target: targetInput.value.trim(),
      task: taskInput.value.trim(),
      method: methodInput.value,
      note: noteInput.value.trim(),
    };
    const r = await db('save', { object: 'journal', id: '', data: data });
    save.disabled = false;
    if (!r.ok) return fail('沒有記成功：' + (r.message || r.error));
    dropRowsCache('journal');
    alert('記好了：' + data.summary + '　' + nt(amount) + ' 元');
    amountInput.value = '';
    summaryInput.value = '';
    targetInput.value = '';
    noInput.value = '';
    noteInput.value = '';
    const fresh = await loadFinance(['journal'], true);
    paintRecent(fresh.journal);
  });
}


// ── 會費催繳 ────────────────────────────────────────────
// 還沒繳的有效會員（永久會員、已繳的、已回報待對帳的都不算）
async function viewDuesRemind() {
  $('crumb').textContent = '財務 › 會費催繳';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '會費催繳'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('名單是即時算的：會籍到期前 ' + 60 + ' 天內或已過期、而且今年度還沒入帳的有效會員。永久會員與已回報待對帳的不會出現。'));

  const r = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: 'dues_unpaid' });
  if (!r || !r.ok) { sheet.append(el('p', 'err', '讀不到名單：' + ((r && (r.message || r.error)) || '未知原因'))); return; }
  const rows = r.rows || [];
  if (!rows.length) { info.textContent = '目前沒有需要催繳的會員'; sheet.append(el('p', 'hint', '大家都繳了，或還沒到開放繳費的時間。')); return; }
  const withEmail = rows.filter((x) => x.email);
  info.textContent = rows.length + ' 位還沒繳　有 Email 的 ' + withEmail.length + ' 位　合計 ' + nt(rows.reduce((t, x) => t + (Number(x.amount) || 0), 0)) + ' 元';

  // 勾選
  const picked = {};
  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0 14px';
  sheet.append(bar);
  const out = el('p', 'hint');
  out.hidden = true;

  const paintBar = () => {
    const ids = Object.keys(picked);
    bar.replaceChildren();
    const all = el('button', 'btn quiet');
    all.type = 'button';
    const every = rows.length > 0 && rows.every((x) => picked[x.memberId]);
    all.append(el('span', '', every ? '取消全選' : '全選（' + rows.length + '）'));
    all.addEventListener('click', () => {
      if (every) rows.forEach((x) => delete picked[x.memberId]);
      else rows.forEach((x) => (picked[x.memberId] = x));
      paint();
    });
    bar.append(all);
    const count = el('span', '', ids.length ? '已勾選 ' + ids.length + ' 位' : '勾選後可以寄信或複製 Email');
    count.style.cssText = 'font-size:12.5px;color:var(--muted)';
    bar.append(count);

    const mailBtn = (label, last) => {
      const b = el('button', 'btn' + (ids.length ? ' pri' : ''));
      b.type = 'button';
      b.disabled = !ids.length;
      b.append(icon('doc'), el('span', '', label));
      b.addEventListener('click', async () => {
        const list = ids.map((id) => picked[id]).filter((x) => x.email);
        if (!list.length) return alert('勾選的這幾位都沒有 Email，請用下面的 LINE 訊息。');
        if (!window.confirm('要寄給 ' + list.length + ' 位嗎？' + (ids.length - list.length ? '（另外 ' + (ids.length - list.length) + ' 位沒有 Email，會略過）' : ''))) return;
        b.disabled = true;
        const done = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: 'dues_remind', ids: ids, last: last });
        b.disabled = false;
        out.hidden = false;
        out.className = done && done.ok ? 'hint' : 'err';
        out.textContent = done && done.ok ? done.text : '沒有成功：' + ((done && (done.message || done.error)) || '未知原因');
      });
      bar.append(b);
    };
    mailBtn('寄催繳 Email', false);
    mailBtn('寄最後提醒', true);

    const copyBtn = el('button', 'btn quiet');
    copyBtn.type = 'button';
    copyBtn.disabled = !ids.length;
    copyBtn.append(icon('doc'), el('span', '', '複製 Email'));
    copyBtn.addEventListener('click', () => {
      const list = ids.map((id) => picked[id]).map((x) => x.email).filter(Boolean);
      navigator.clipboard.writeText(list.join(', '));
      out.hidden = false;
      out.className = 'hint';
      out.textContent = '已複製 ' + list.length + ' 個 Email，貼到 Gmail 的密件副本就可以寄。';
    });
    bar.append(copyBtn);
    if (ids.length) {
      const clear = el('button', 'btn quiet');
      clear.type = 'button';
      clear.append(el('span', '', '清除勾選'));
      clear.addEventListener('click', () => { Object.keys(picked).forEach((k) => delete picked[k]); paint(); });
      bar.append(clear);
    }
  };

  const listBox = el('div');
  sheet.append(listBox, out);
  const paint = () => {
    paintBar();
    listBox.replaceChildren();
    const table = finTable([
      { label: '', get: () => '' },
      { label: '會員編號', get: (x) => x.memberId },
      { label: '姓名', get: (x) => x.name },
      { label: '類別', get: (x) => x.type },
      { label: '會籍到期', get: (x) => x.until || '' },
      { label: '應繳年度', get: (x) => String(x.year) },
      { label: '金額', right: 1, get: (x) => nt(x.amount) + ' 元' },
      { label: 'Email', get: (x) => x.email || '（沒有）' },
      { label: 'LINE 名稱', get: (x) => x.lineName || '' },
      { label: '訊息', get: () => '複製' },
    ], rows, 'dues.remind');
    Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
      const x = rows[i];
      if (!x) return;
      const cells = tr.querySelectorAll('td');
      const first = cells[0];
      if (first) {
        first.style.width = '34px';
        const boxEl = el('input');
        boxEl.type = 'checkbox';
        boxEl.checked = Boolean(picked[x.memberId]);
        boxEl.style.cssText = 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer';
        boxEl.addEventListener('change', () => { if (boxEl.checked) picked[x.memberId] = x; else delete picked[x.memberId]; paintBar(); });
        first.append(boxEl);
      }
      const copyCell = cells[cells.length - 1];
      if (copyCell) {
        copyCell.style.cursor = 'pointer';
        copyCell.style.color = 'var(--accent)';
        copyCell.title = '複製這一位的催繳訊息（可貼到 LINE）';
        copyCell.addEventListener('click', () => {
          navigator.clipboard.writeText(x.message);
          out.hidden = false;
          out.className = 'hint';
          out.textContent = '已複製 ' + x.name + ' 的催繳訊息，貼到 LINE 就可以。';
        });
      }
    });
    listBox.append(table);
  };
  paint();
}


// ── 課程簽到表 ──────────────────────────────────────────
// 一場活動一張簽到表，分環節列出報名的人（含待繳費的，現場收款也要簽到）
async function viewEventSheet() {
  $('crumb').textContent = '課程活動 › 簽到表';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '簽到表'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('選一場活動就會列出簽到表，按「列印」直接印出來帶去現場。取消的不列；待繳費的會列出來並標「未繳」，現場收款後請到「報名名單」按確認收款。'));

  const got = await loadFinance(['registration', 'event']);
  if (!got.registration) { sheet.append(el('p', 'err', '讀不到報名名單')); return; }
  const regs = got.registration.map((r) => r.data || {});
  const events = (got.event || []).map((r) => r.data || {});

  // 活動清單：以課程活動表為主，報名資料裡有但活動表沒有的也補進來
  const byId = {};
  const touch = (id, title) => {
    if (!id) return null;
    if (!byId[id]) byId[id] = { id: id, title: title || id, date: '', sessions: [] };
    if (title && (!byId[id].title || byId[id].title === id)) byId[id].title = title;
    return byId[id];
  };
  events.forEach((e) => {
    const b = touch(String(e.id || '').trim(), String(e.title || '').trim());
    if (!b) return;
    const d = String(e.date || '').slice(0, 10);
    if (d && (!b.date || d < b.date)) b.date = d;
    b.sessions.push({ name: String(e.session || '').trim() || b.title, time: String(e.time || '').trim(), place: String(e.place || '').trim(), date: d, seats: Number(e.seats) || 0 });
  });
  regs.forEach((r) => touch(String(r.event_id || '').trim(), String(r.event_title || '').trim()));
  const list = Object.keys(byId).map((k) => byId[k]).sort((a, b) => String(b.date || b.id).localeCompare(String(a.date || a.id)));
  if (!list.length) { info.textContent = '還沒有活動'; return; }
  let eventId = list[0].id;

  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px';
  const pickLabel = el('span', '', '活動：');
  pickLabel.style.cssText = 'font-size:12.5px;color:var(--muted)';
  const pick = el('select');
  pick.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);max-width:420px';
  list.forEach((e) => { const o = el('option', '', (e.date ? e.date + '　' : '') + e.title + '（' + e.id + '）'); o.value = e.id; pick.append(o); });
  bar.append(pickLabel, pick);
  const printBtn = el('button', 'btn quiet');
  printBtn.type = 'button';
  printBtn.append(icon('doc'), el('span', '', '列印'));
  printBtn.addEventListener('click', () => window.print());
  const remindBtn = el('button', 'btn');
  remindBtn.type = 'button';
  remindBtn.append(icon('doc'), el('span', '', '寄行前提醒'));
  bar.append(printBtn, remindBtn);
  sheet.append(bar);
  const out = el('p', 'hint');
  out.hidden = true;
  sheet.append(out);
  const body = el('div');
  sheet.append(body);

  remindBtn.addEventListener('click', async () => {
    const e = byId[eventId];
    const ok = (byId[eventId].people || []).filter((p) => p.ok && p.email).length;
    if (!ok) return alert('這場沒有報名成功又有 Email 的人，請用 LINE 通知。');
    if (!window.confirm('要寄行前提醒給「' + e.title + '」報名成功的 ' + ok + ' 位嗎？（同一個人只會收到一封）')) return;
    remindBtn.disabled = true;
    const r = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: 'event_remind', id: eventId });
    remindBtn.disabled = false;
    out.hidden = false;
    out.className = r && r.ok ? 'hint' : 'err';
    out.textContent = r && r.ok ? r.text : '沒有成功：' + ((r && (r.message || r.error)) || '未知原因');
  });

  const paint = () => {
    const e = byId[eventId];
    body.replaceChildren();
    const people = regs.filter((r) => String(r.event_id || '').trim() === eventId && String(r.status || '').trim() !== '取消')
      .map((r) => ({
        name: String(r.name || '').trim(), kind: String(r.kind || '').trim(), memberId: String(r.member_id || '').trim(),
        session: String(r.session || '').trim() || e.title, seats: Number(r.seats) || 1, fee: Number(r.fee) || 0,
        status: String(r.status || '').trim(), email: String(r.email || '').trim(), id: String(r.id || '').trim(),
        ok: String(r.status || '').trim() === '報名成功',
      }));
    e.people = people;
    const seats = people.reduce((t, p) => t + p.seats, 0);
    const unpaid = people.filter((p) => !p.ok && p.fee);
    info.textContent = e.title + '　' + (e.date || '日期未定') + '　報名 ' + people.length + ' 筆、合計 ' + seats + ' 人' +
      (unpaid.length ? '　待繳費 ' + unpaid.length + ' 筆（' + nt(unpaid.reduce((t, p) => t + p.fee, 0)) + ' 元）' : '');
    if (!people.length) {
      body.append(el('p', 'hint', '這場活動還沒有人報名。'));
      return;
    }
    const title = el('h2', '', e.title + '　簽到表');
    title.style.cssText = 'font-size:17px;margin:6px 0 2px';
    const sub = el('p', 'hint', (e.date || '') + '　' + e.sessions.map((x) => x.name + (x.time ? '　' + x.time : '') + (x.place ? '　' + x.place : '')).join('｜'));
    body.append(title, sub);

    const groups = {};
    const order = [];
    people.forEach((p) => { if (!groups[p.session]) { groups[p.session] = []; order.push(p.session); } groups[p.session].push(p); });
    order.forEach((name) => {
      const rows = groups[name];
      const h = el('h3', '', name + '（' + rows.length + ' 筆、' + rows.reduce((t, p) => t + p.seats, 0) + ' 人）');
      h.style.cssText = 'font-size:14.5px;margin:18px 0 6px';
      body.append(h);
      const table = finTable([
        { label: '序', right: 1, get: (p) => String(rows.indexOf(p) + 1) },
        { label: '姓名', get: (p) => p.name },
        { label: '身分', get: (p) => p.kind },
        { label: '會員編號', get: (p) => p.memberId },
        { label: '人數', right: 1, get: (p) => String(p.seats) },
        { label: '繳費', get: (p) => (p.fee ? (p.ok ? '已繳 ' + nt(p.fee) : '未繳 ' + nt(p.fee)) : '免費') },
        { label: '報名編號', get: (p) => p.id },
        { label: '簽到', get: () => '' },
      ], rows, 'event.sheet');
      const last = table.querySelector('thead th:last-child');
      if (last && !last.style.width) last.style.width = '150px';
      body.append(table);
    });
  };
  pick.addEventListener('change', () => { eventId = pick.value; out.hidden = true; paint(); });
  paint();
}

// ── 請款審核與撥款 ──────────────────────────────────────
// 資料直接問 Apps Script（請款紀錄的正本在資料庫，但建議科目、合併撥款的規則都在那邊）
const CLAIM_TABS = ['待審核', '已審核', '已付款', '不通過', '全部'];

async function viewClaimReview() {
  $('crumb').textContent = '財務 › 請款審核與撥款';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '請款審核與撥款'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('一張單一次轉帳。審核時逐項挑科目（挑「退回這一項」就不撥款）；撥款時日記帳會照科目分列、掛同一個付款批號，對帳時整批去對。'));

  const r = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: 'claim_list' });
  if (!r || !r.ok) { sheet.append(el('p', 'err', '讀不到請款單：' + ((r && (r.message || r.error)) || '未知原因'))); return; }
  const claims = r.claims || [];
  const accounts = r.accounts || [];
  if (!claims.length) { info.textContent = '還沒有請款單'; return; }

  let tab = claims.some((c) => c.status === '待審核') ? '待審核' : '已審核';
  const picked = {};
  const out = el('p', 'hint');
  out.hidden = true;
  const tabBar = el('div');
  tabBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px';
  const payBar = el('div');
  payBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--sub)';
  const body = el('div');
  sheet.append(tabBar, payBar, out, body);

  const count = (name) => (name === '全部' ? claims.length : claims.filter((c) => c.status === name).length);
  const money = (n) => nt(Number(n) || 0) + ' 元';
  const nameOf = {};
  accounts.forEach((a) => (nameOf[a.code] = a.name));

  const say = (ok, text) => {
    out.hidden = false;
    out.className = ok ? 'hint' : 'err';
    out.textContent = text;
    out.scrollIntoView({ block: 'nearest' });
  };

  // 跟 Apps Script 要一次事情做完，然後整頁重讀（金額、狀態都會變）
  const run = async (payload, btn) => {
    if (btn) btn.disabled = true;
    const res = await appsScript(Object.assign({ action: 'adminTool', token: sessionStorageToken() }, payload));
    if (btn) btn.disabled = false;
    if (!res || !res.ok) { say(false, '沒有成功：' + ((res && (res.message || res.error)) || '未知原因')); return null; }
    dropRowsCache();
    return res;
  };

  // 付款方式／付款日：合併撥款與單張撥款共用上面這一排
  const methodPick = el('select');
  methodPick.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)';
  [['銀行', '銀行轉帳'], ['現金', '現金（我先用 LINE Pay 或現金代付）'], ['其他', '其他（例如由預支款抵付）']].forEach((p) => {
    const o = el('option', '', p[1]);
    o.value = p[0];
    methodPick.append(o);
  });
  const noteInput = el('input');
  noteInput.type = 'text';
  noteInput.placeholder = '「其他」要說明怎麼付的';
  noteInput.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:200px';
  noteInput.hidden = true;
  methodPick.addEventListener('change', () => { noteInput.hidden = methodPick.value !== '其他'; });
  const datePick = el('input');
  datePick.type = 'date';
  datePick.value = new Date().toISOString().slice(0, 10);
  datePick.style.cssText = 'font:inherit;font-size:13px;padding:3px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)';
  const payBtn = el('button', 'btn pri');
  payBtn.type = 'button';
  payBtn.append(icon('coin'), el('span', '', '確認撥款'));

  const payNow = async (ids) => {
    const list = ids.map((id) => claims.filter((c) => c.id === id)[0]).filter(Boolean);
    if (!list.length) return say(false, '請先勾選要撥款的單。');
    const people = list.map((c) => c.who).filter((v, i, a) => a.indexOf(v) === i);
    if (people.length > 1) return say(false, '合併撥款一次只能處理同一個人，你勾到了：' + people.join('、'));
    const sum = list.reduce((t, c) => t + (Number(c.total) || 0), 0);
    if (methodPick.value === '其他' && !noteInput.value.trim()) return say(false, '付款方式選「其他」要填說明。');
    if (!window.confirm('要撥款給 ' + people[0] + ' 嗎？' + '\n' + list.map((c) => '・' + c.id + '　' + money(c.total)).join('\n') +
      '\n合計 ' + money(sum) + '（' + methodPick.value + '、' + datePick.value + '）\n按下去會改請款紀錄、寫日記帳、寄 Email 通知。')) return;
    const res = await run({ tool: 'claim_pay', ids: list.map((c) => c.id), method: methodPick.value, note: noteInput.value.trim(), date: datePick.value }, payBtn);
    if (!res) return;
    say(true, res.text);
    setTimeout(viewClaimReview, 1200);
  };
  payBtn.addEventListener('click', () => payNow(Object.keys(picked)));

  const paintPayBar = () => {
    const ids = Object.keys(picked);
    payBar.replaceChildren();
    const label = el('span', '', ids.length ? '要撥款的 ' + ids.length + ' 張：' : '勾選「已審核」的單就可以撥款（同一個人可以合併成一次轉帳）：');
    label.style.cssText = 'font-size:12.5px;color:var(--muted)';
    payBar.append(label, methodPick, noteInput, el('span', '', '付款日'), datePick, payBtn);
    payBtn.disabled = !ids.length;
    if (ids.length) {
      const clear = el('button', 'btn quiet');
      clear.type = 'button';
      clear.append(el('span', '', '清除勾選'));
      clear.addEventListener('click', () => { Object.keys(picked).forEach((k) => delete picked[k]); paint(); });
      payBar.append(clear);
    }
  };

  const card = (c) => {
    const wrap = el('div');
    wrap.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 12px';
    const top = el('div');
    top.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:center';
    const canPay = c.status === '已審核' || c.status === '待審核';
    if (canPay) {
      const boxEl = el('input');
      boxEl.type = 'checkbox';
      boxEl.checked = Boolean(picked[c.id]);
      boxEl.title = '勾起來一起撥款';
      boxEl.style.cssText = 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer';
      boxEl.addEventListener('change', () => { if (boxEl.checked) picked[c.id] = 1; else delete picked[c.id]; paintPayBar(); });
      top.append(boxEl);
    }
    const title = el('strong', '', c.id);
    title.style.cssText = 'font-size:14px';
    const badge = el('span', '', c.status);
    badge.style.cssText = 'font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)';
    const who = el('span', '', c.who + (c.kind === '秘書處' ? '（秘書處）' : ''));
    who.style.cssText = 'font-size:13px';
    const meta = el('span', '', [c.submitted ? '送出 ' + c.submitted : '', money(c.total), c.items.length + ' 項',
      c.requested ? '請款人填：' + c.requested : '', c.paidOn ? '付款日 ' + c.paidOn : '', c.batch ? '批號 ' + c.batch : ''].filter(Boolean).join('　'));
    meta.style.cssText = 'font-size:12.5px;color:var(--muted)';
    top.append(title, badge, who, el('span', 'sp'), meta);
    wrap.append(top);
    if (c.note) wrap.append(hint('請款人說明：' + c.note));

    // 品項
    const picks = {};
    const table = el('table');
    table.style.cssText = 'width:100%;margin:10px 0 4px';
    const thead = el('thead');
    const hr = el('tr');
    ['序', '消費日', '品名／事由', '任務', '單據', '金額', '會計科目', '狀態'].forEach((h) => hr.append(el('th', '', h)));
    thead.append(hr);
    const tb = el('tbody');
    c.items.forEach((it, i) => {
      const tr = el('tr');
      tr.append(el('td', '', String(i + 1)), el('td', '', it.spent || ''), el('td', '', it.name), el('td', '', it.task || ''), el('td', '', it.receiptType || ''));
      const amount = el('td', '', money(it.amount));
      amount.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums';
      tr.append(amount);
      const codeCell = el('td');
      if (it.status === '待審核') {
        const pick = el('select');
        pick.style.cssText = 'font:inherit;font-size:12.5px;padding:3px 6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);max-width:230px';
        accounts.forEach((a) => {
          const o = el('option', '', a.code + '　' + a.name);
          o.value = a.code;
          if (a.code === it.suggest) o.selected = true;
          pick.append(o);
        });
        const x = el('option', '', '✗ 退回這一項');
        x.value = 'X';
        pick.append(x);
        picks[it.id] = pick;
        codeCell.append(pick);
      } else {
        codeCell.textContent = it.code ? it.code + (nameOf[it.code] ? '　' + nameOf[it.code] : '') : '';
      }
      tr.append(codeCell);
      tr.append(el('td', '', it.status + (it.note ? '（' + it.note + '）' : '')));
      tb.append(tr);
    });
    table.append(thead, tb);
    const tw = el('div', 'tw');
    makeResizable(table, 'claim.items');
    tw.append(table);
    wrap.append(tw);

    const bar = el('div');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px';
    wrap.append(bar);

    if (c.status === '待審核') {
      let reviewer = null;
      if (c.kind === '秘書處') {
        reviewer = el('input');
        reviewer.type = 'text';
        reviewer.placeholder = '審核人姓名（填自己＝自審）';
        reviewer.style.cssText = 'font:inherit;font-size:12.5px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:200px';
        bar.append(reviewer);
      }
      const okBtn = el('button', 'btn pri');
      okBtn.type = 'button';
      okBtn.append(icon('check'), el('span', '', '審核通過'));
      okBtn.addEventListener('click', async () => {
        const decisions = Object.keys(picks).map((id) => ({ id: id, code: picks[id].value }));
        const drop = decisions.filter((d) => d.code === 'X').length;
        if (!window.confirm('收據核對無誤了嗎？' + (drop ? '（其中 ' + drop + ' 項會退回）' : '') + '\n按下去會寄審核結果給請款人。')) return;
        const res = await run({ tool: 'claim_approve', id: c.id, decisions: decisions, reviewer: reviewer ? reviewer.value.trim() : '' }, okBtn);
        if (!res) return;
        say(true, res.text);
        setTimeout(viewClaimReview, 1200);
      });
      bar.append(okBtn);
    }

    if (c.status !== '已付款' && c.status !== '不通過') {
      const noBtn = el('button', 'btn quiet');
      noBtn.type = 'button';
      noBtn.append(icon('out'), el('span', '', '整張不通過'));
      noBtn.addEventListener('click', async () => {
        const reason = window.prompt('整張不通過的原因（會寄給請款人）：', '');
        if (reason === null) return;
        const res = await run({ tool: 'claim_reject', id: c.id, reason: reason }, noBtn);
        if (!res) return;
        say(true, res.text);
        setTimeout(viewClaimReview, 1200);
      });
      bar.append(noBtn);
    }

    if (canPay) {
      const oneBtn = el('button', 'btn');
      oneBtn.type = 'button';
      oneBtn.append(icon('coin'), el('span', '', '只撥這一張'));
      oneBtn.addEventListener('click', () => payNow([c.id]));
      bar.append(oneBtn);
    }

    const docBtn = el('button', 'btn quiet');
    docBtn.type = 'button';
    docBtn.append(icon('doc'), el('span', '', '請款單暨憑證黏存單'));
    docBtn.addEventListener('click', async () => {
      const res = await run({ tool: 'claim_voucher', id: c.id }, docBtn);
      if (!res) return;
      say(true, res.text + '（檔案開在新視窗）');
      window.open(res.url, '_blank');
    });
    bar.append(docBtn);
    return wrap;
  };

  const paint = () => {
    const shown = tab === '全部' ? claims : claims.filter((c) => c.status === tab);
    info.textContent = '共 ' + claims.length + ' 張　待審核 ' + count('待審核') + '　已審核 ' + count('已審核') +
      '（' + money(claims.filter((c) => c.status === '已審核').reduce((t, c) => t + (Number(c.total) || 0), 0)) + ' 待撥款）';
    tabBar.replaceChildren();
    CLAIM_TABS.forEach((name) => {
      const b = el('button', 'btn' + (tab === name ? ' pri' : ' quiet'));
      b.type = 'button';
      b.append(el('span', '', name + '（' + count(name) + '）'));
      b.addEventListener('click', () => { tab = name; paint(); });
      tabBar.append(b);
    });
    paintPayBar();
    body.replaceChildren();
    if (!shown.length) body.append(el('p', 'hint', '這一類目前沒有單。'));
    shown.forEach((c) => body.append(card(c)));

    // 月結憑證單
    const month = el('div');
    month.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line)';
    const label = el('span', '', '會計：月結憑證單');
    label.style.cssText = 'font-size:13px;font-weight:600';
    const ym = el('input');
    ym.type = 'month';
    const last = new Date();
    last.setMonth(last.getMonth() - 1);
    ym.value = last.toISOString().slice(0, 7);
    ym.style.cssText = 'font:inherit;font-size:13px;padding:3px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)';
    const mBtn = el('button', 'btn quiet');
    mBtn.type = 'button';
    mBtn.append(icon('doc'), el('span', '', '產生這個月的憑證單'));
    mBtn.addEventListener('click', async () => {
      const res = await run({ tool: 'claim_monthly', ym: ym.value }, mBtn);
      if (!res) return;
      say(true, res.text + '　合計 ' + money(res.total) + '（檔案開在新視窗）');
      window.open(res.url, '_blank');
    });
    month.append(label, ym, mBtn, hint('整月一份：該月所有支出一列一項，印出來把單據依序號貼在後頁。'));
    body.append(month);
  };
  paint();
}

// ── 對帳報告 ────────────────────────────────────────────
// 文字報告由 Apps Script 算（跟每月 5 日自動寄出的那一封同一套），可以在這裡直接寄出
async function viewReconReport() {
  $('crumb').textContent = '財務 › 對帳報告';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  const info = el('p', '', '讀取中…');
  box.append(el('h1', 'page', '對帳報告'), info);
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('年度報告會把有差額或有對不到的月份全部列出來；都對平就只有一行。每月 5 日系統也會自己寄一封上個月的報告給〈提醒收件人〉。'));

  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px';
  const pickLabel = el('span', '', '範圍：');
  pickLabel.style.cssText = 'font-size:12.5px;color:var(--muted)';
  const pick = el('select');
  pick.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink)';
  const yearOpt = el('option', '', '本年度（到這個月為止）');
  yearOpt.value = '';
  pick.append(yearOpt);
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const o = el('option', '', ym);
    o.value = ym;
    pick.append(o);
  }
  const goBtn = el('button', 'btn pri');
  goBtn.type = 'button';
  goBtn.append(icon('check'), el('span', '', '算一次'));
  const mailBtn = el('button', 'btn');
  mailBtn.type = 'button';
  mailBtn.append(icon('doc'), el('span', '', '寄給提醒收件人'));
  const copyBtn = el('button', 'btn quiet');
  copyBtn.type = 'button';
  copyBtn.append(icon('doc'), el('span', '', '複製報告'));
  const printBtn = el('button', 'btn quiet');
  printBtn.type = 'button';
  printBtn.append(icon('doc'), el('span', '', '列印'));
  printBtn.addEventListener('click', () => window.print());
  bar.append(pickLabel, pick, goBtn, mailBtn, copyBtn, printBtn);
  sheet.append(bar);
  const out = el('p', 'hint');
  out.hidden = true;
  const pre = el('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13px;line-height:1.7;margin:0;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--sub)';
  sheet.append(out, pre);
  let text = '';

  const ask = async (mail) => {
    goBtn.disabled = true;
    mailBtn.disabled = true;
    pre.textContent = '算帳中…（一個月一個月對，可能要十幾秒）';
    const r = await appsScript({ action: 'adminTool', token: sessionStorageToken(), tool: 'recon_report', ym: pick.value, mail: mail });
    goBtn.disabled = false;
    mailBtn.disabled = false;
    if (!r || !r.ok) {
      pre.textContent = '';
      out.hidden = false;
      out.className = 'err';
      out.textContent = '算不出來：' + ((r && (r.message || r.error)) || '未知原因');
      return;
    }
    text = r.text || '';
    pre.textContent = text;
    info.textContent = (pick.value || '本年度') + '　' + (r.clean ? '✔ 對平了' : '✘ 有差額或有對不到的筆數');
    out.hidden = false;
    out.className = r.clean ? 'hint' : 'err';
    out.textContent = (r.message || (r.to ? '收件人：' + r.to : '〈設定〉還沒填「提醒收件人」，寄不出去，只能看畫面。'));
  };
  goBtn.addEventListener('click', () => ask(false));
  mailBtn.addEventListener('click', async () => {
    if (!window.confirm('要把這份報告寄出去嗎？（寄給〈設定〉裡的「提醒收件人」）')) return;
    await ask(true);
  });
  copyBtn.addEventListener('click', () => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    out.hidden = false;
    out.className = 'hint';
    out.textContent = '報告已複製，可以貼到 LINE 或會議記錄。';
  });
  pick.addEventListener('change', () => ask(false));
  await ask(false);
}

// ── 系統工具 ────────────────────────────────────────────
// 原本要開試算表按的那幾件事：備份、解除登入鎖定、重新整理官網名單
async function viewTools() {
  $('crumb').textContent = '系統 › 系統工具';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  box.append(el('h1', 'page', '系統工具'), el('p', '', '備份、解鎖、重新整理官網名單'));
  head.append(box, el('span', 'sp'));
  main.append(head);
  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);

  const out = el('p', 'hint');
  out.hidden = true;
  const say = (ok, text) => {
    out.hidden = false;
    out.className = ok ? 'hint' : 'err';
    out.textContent = text;
  };
  const run = async (payload, btn) => {
    btn.disabled = true;
    say(true, '處理中…');
    const r = await appsScript(Object.assign({ action: 'adminTool', token: sessionStorageToken() }, payload));
    btn.disabled = false;
    if (!r || !r.ok) { say(false, '沒有成功：' + ((r && (r.message || r.error)) || '未知原因')); return null; }
    return r;
  };

  const card = (title, note) => {
    const wrap = el('div');
    wrap.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 12px';
    const h = el('strong', '', title);
    h.style.cssText = 'font-size:14px';
    wrap.append(h);
    if (note) wrap.append(hint(note));
    const bar = el('div');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px';
    wrap.append(bar);
    sheet.append(wrap);
    return bar;
  };

  // 備份
  const backupBar = card('立刻備份官網資料庫',
    '把資料庫整份倒成 JSON 存到雲端硬碟，只保留最近幾份。這份檔案含個資（身分證號、簽名、銀行資料），資料夾不要分享給任何人。');
  const backupBtn = el('button', 'btn pri');
  backupBtn.type = 'button';
  backupBtn.append(icon('db'), el('span', '', '備份一份'));
  const backupOut = el('p', 'hint');
  backupOut.hidden = true;
  backupBtn.addEventListener('click', async () => {
    if (!window.confirm('要現在備份整個資料庫嗎？（檔案含個資，只存在我們的雲端硬碟）')) return;
    const r = await run({ tool: 'backup' }, backupBtn);
    if (!r) return;
    say(true, '備份完成：' + r.name + '　共 ' + r.rows + ' 筆');
    backupOut.hidden = false;
    backupOut.textContent = Object.keys(r.counts || {}).map((k) => k + ' ' + r.counts[k]).join('　');
  });
  backupBar.append(backupBtn, backupOut);

  // 解除登入鎖定
  const lockBar = card('解除登入鎖定',
    '會員或志工連續輸錯被鎖住時用（本來 6 小時會自動解開）。輸入會員編號，或志工的綽號／本名。');
  const who = el('input');
  who.type = 'text';
  who.placeholder = '例：B00001 或 小草';
  who.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:200px';
  const lockBtn = el('button', 'btn');
  lockBtn.type = 'button';
  lockBtn.append(icon('check'), el('span', '', '解除鎖定'));
  lockBtn.addEventListener('click', async () => {
    if (!who.value.trim()) return say(false, '請先輸入會員編號或志工名字。');
    const r = await run({ tool: 'unlock', who: who.value.trim() }, lockBtn);
    if (!r) return;
    say(true, r.text);
  });
  lockBar.append(who, lockBtn);

  // 重新整理官網名單
  const freshBar = card('重新整理官網名單',
    '官網的公開會員名單與榮譽志工是每小時更新一次的快取。剛改完資料想馬上在官網看到，就按這個。');
  const freshBtn = el('button', 'btn quiet');
  freshBtn.type = 'button';
  freshBtn.append(icon('rows'), el('span', '', '清快取'));
  freshBtn.addEventListener('click', async () => {
    const r = await run({ tool: 'refresh_public' }, freshBtn);
    if (!r) return;
    say(true, r.text);
  });
  freshBar.append(freshBtn);

  sheet.append(out);
  sheet.append(hint('其他的事：設定庫與同步在「系統 → 同步狀態」；一次性的搬家匯入工具還留在試算表的「同步」選單裡，因為那些資料本來就在試算表上（匯完就不用再按）。'));
}

async function viewPermits() {
  $('crumb').textContent = '系統 › 權限';
  const main = $('main');
  main.replaceChildren();
  const head = el('div', 'head');
  const box = el('div');
  box.append(el('h1', 'page', '權限'), el('p', '', '誰可以看、誰可以改哪一種資料'));
  head.append(box);
  main.append(head);

  const sheet = el('div', 'sheet');
  sheet.style.borderRadius = 'var(--r)';
  main.append(sheet);
  sheet.append(hint('三種身分：秘書長什麼都能改；理監事只看得到財務那幾頁，什麼都不能改；志工預設只有志工專區，要多給什麼就在這一頁加。前兩種是在「設定與文案」裡填會員編號（〈管理員會員編號〉與〈理監事會員編號〉）。'));

  const result = await db('permits');
  if (!result.ok) { sheet.append(el('p', 'err', '讀不到：' + (result.message || result.error) + (result.error === 'forbidden' ? '（只有秘書長看得到這一頁）' : ''))); return; }

  // 新增一筆授權
  const form = el('div');
  form.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:4px 0 18px';
  const field = (label, node, width) => {
    const wrap = el('div', 'fld');
    wrap.style.cssText = 'margin:0;width:' + width;
    wrap.append(el('label', '', label), node);
    return wrap;
  };
  const whoInput = el('input');
  whoInput.placeholder = '志工綽號，或 * 代表全體志工';
  whoInput.style.cssText = 'font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sub);color:var(--ink);width:100%';
  const objSelect = el('select');
  objSelect.style.cssText = whoInput.style.cssText;
  (result.objects || []).forEach((o) => { const opt = el('option', '', o.label); opt.value = o.id; objSelect.append(opt); });
  const levelSelect = el('select');
  levelSelect.style.cssText = whoInput.style.cssText;
  [['read', '只能看'], ['write', '可以看也可以改']].forEach(([v, t]) => { const opt = el('option', '', t); opt.value = v; levelSelect.append(opt); });
  const noteInput = el('input');
  noteInput.placeholder = '備註（例：廠商組）';
  noteInput.style.cssText = whoInput.style.cssText;
  const addBtn = el('button', 'btn pri');
  addBtn.type = 'button';
  addBtn.append(icon('check'), el('span', '', '給他'));
  form.append(field('給誰', whoInput, '200px'), field('哪一種資料', objSelect, '180px'), field('給到什麼', levelSelect, '180px'), field('備註', noteInput, '180px'), addBtn);
  sheet.append(form);

  addBtn.addEventListener('click', async () => {
    const target = whoInput.value.trim();
    if (!target) { alert('要填給誰。志工填綽號，全體志工填 *。'); return; }
    addBtn.disabled = true;
    const r = await db('permit-set', { who: target, object: objSelect.value, level: levelSelect.value, note: noteInput.value.trim() });
    addBtn.disabled = false;
    if (!r.ok) { alert('沒有成功：' + (r.message || r.error)); return; }
    viewPermits();
  });

  if (!result.rows.length) {
    sheet.append(el('div', 'empty', '目前沒有個別授權。志工只有志工專區看得到的東西。'));
    return;
  }
  const table = tableOf(['給誰', '哪一種資料', '給到什麼', '備註', ''], result.rows.map((r) => [
    r.who === '*' ? '全體志工' : r.who, r.objectLabel,
    tagOf(r.level === 'write' ? 'ok' : 'plain', r.level === 'write' ? '可以改' : '只能看'),
    r.note || '', '',
  ]));
  Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
    const cell = tr.lastElementChild;
    cell.style.textAlign = 'right';
    const del = el('button', 'btn quiet');
    del.type = 'button';
    del.append(el('span', '', '收回'));
    del.addEventListener('click', async () => {
      if (!confirm('要收回「' + (result.rows[i].who === '*' ? '全體志工' : result.rows[i].who) + '」對「' + result.rows[i].objectLabel + '」的權限嗎？')) return;
      const r = await db('permit-remove', { id: result.rows[i].id });
      if (!r.ok) { alert('沒有成功：' + (r.message || r.error)); return; }
      viewPermits();
    });
    cell.replaceChildren(del);
  });
  sheet.append(table);
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
  if (r.help) {
    const tip = el('small', '', r.help);
    tip.style.cssText = 'color:var(--muted);font-size:12px;line-height:1.6';
    box.append(tip);
  }
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
