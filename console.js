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
    add.addEventListener('click', () => openForm(obj, null));
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
    const others = asideStatuses(rows.map(statusOf), mainList, statusGroups);
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

  function paintPickBar() {
    if (!contactFields.length) return;
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

    const count = el('span', '', picked.length ? '已勾選 ' + picked.length + ' 位' : '勾選後可以複製聯絡方式');
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
    return el('td', kind, text);
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

  const loadMore = async () => {
    const result = await db('list', { object: objectId, limit: 200, cursor: cursor });
    if (!result.ok) { sheet.replaceChildren(el('p', 'err', '讀不到：' + (result.message || result.error))); return; }
    if (!cols) {
      cols = (result.fields && result.fields.length ? result.fields : obj.fields.slice(0, 6));
      table.append(headerRow((contactFields.length ? [''] : []).concat(cols.map((f) => f.label))));
      table.append(body);
      tw.append(table);
      sheet.replaceChildren(statusBar, tagBar, pickBar, tw, moreBox);
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
    ? '按下去會改試算表那一份正本，再同步回這裡，並留下誰在什麼時候改了什麼。'
    : '這一筆目前沒有可以按的動作。欄位的修改會在下一批加上。'));
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
function asideStatuses(values, main, groups) {
  const count = {};
  values.forEach((v) => {
    if ((main || []).indexOf(v) !== -1) return;
    const tab = statusTabOf(v, groups);
    count[tab] = (count[tab] || 0) + 1;
  });
  return Object.keys(count).sort((a, b) => count[b] - count[a]).map((v) => ({ value: v, count: count[v] }));
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
function openForm(obj, row) {
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
  if (!result.ok) { alert('刪不掉：' + (result.message || result.error)); return; }
  if (drawerEls) drawerEls.hide();
  go(current);
}

// ── 權限 ────────────────────────────────────────────────
// 三種身分：秘書長什麼都能改、理監事只看財務、志工看個別授權。
// 前兩種在「設定與文案」填會員編號，這一頁管的是第三種。
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
