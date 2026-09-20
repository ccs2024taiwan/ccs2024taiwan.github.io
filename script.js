// 後端（Google Apps Script 網頁應用程式）網址。留空 = 示範模式，不會真的驗證或送出資料。
const API_URL = '';

// 示範模式用的假資料，接上後端後不會用到。
const DEMO_MEMBER = { id: 'B00000', phone: '0912345678', name: '示範會員' };
const DEMO_VENDORS = [
  { name: '示範電梯保養公司', services: '電梯', area: '台中市', contact: '04-0000-0000', paid: '需付費', households: '320', fee: '每台每月 3,500 元', rating: 5, reasons: '服務、技術', note: '叫修 30 分鐘內到場。（示範資料）' },
  { name: '示範清潔公司', services: '清潔、洗水塔', area: '台中市', contact: '', paid: '需付費', households: '150', fee: '每月 4.2 萬（2 人）', rating: 4, reasons: '價格、品質', note: '（示範資料）' },
  { name: '示範機電行', services: '機電、消防', area: '新北市', contact: '', paid: '需付費', households: '500', fee: '年約 36 萬', rating: 2, reasons: '誠信', note: '報價與實際請款落差大，建議合約寫清楚。（示範資料）' },
];
const DEMO_SERVICES = {
  membership: { type: '個人會員', status: '續會', since: '2024-01-01', until: '2026-12-31', daysLeft: 103, nextPayment: '2027-01-01' },
  vendors: DEMO_VENDORS,
  equipment: {
    assets: [
      { name: '萬聖節集章印章', quantity: '1 組 45 顆', place: '秘書處', note: '含印台；示範資料' },
      { name: '關東旗與旗座', quantity: '6 組', place: '秘書處', note: '示範資料' },
    ],
    shared: [{ name: '聖誕樹 180cm', quantity: '2 棵', place: '臺中市北屯區', note: '含燈飾；示範資料', owner: '示範社區' }],
  },
  links: [{ label: '會員共享資料夾（示範連結）', url: 'https://example.org/' }],
};

const DEMO_VOLUNTEER = {
  name: '示範志工',
  phone: '0912345678',
  view: {
    volunteer: { name: '示範志工', joined: '2025-11-30' },
    level: { name: '正式志工', rank: 2, of: 4, months: 9, next: { name: '金牌志工', needMonths: 3, needPoints: 28 } },
    stats: { tasks: 2, attended: 3, hours: 9.5, points: 12, last: '2026-05-17' },
    history: [
      { date: '2026-05-17', task: '管委會交流日', role: '報到', hours: 4, presence: '出席' },
      { date: '2026-03-29', task: '會員講座', role: '場佈', hours: 3, presence: '出席' },
    ],
    tasks: [
      { name: '管委會交流日', type: '活動', start: '2026-11-29', end: '', lead: '示範召集人', description: '年度大型委員交流活動，需要報到、場佈、攝影、主持等人力。', needed: '8', requirement: '當天全程可到', reward: '積分 3 點＋任務津貼', joined: 3, mine: '通過' },
      { name: '北屯鬧起來萬聖節', type: '活動', start: '2026-10-25', end: '', lead: '', description: '跨社區聯辦，需要集章點關主與遊行隨隊。', needed: '12', requirement: '', reward: '積分 2 點', joined: 5, mine: '待審核' },
      { name: '會員講座文宣製作', type: '文書', start: '', end: '', lead: '', description: '每場講座的宣傳圖卡與活動後貼文。', needed: '2', requirement: '會用 Canva 或繪圖軟體', reward: '積分 1 點／件', joined: 0, mine: '' },
    ],
    reminders: [{ task: '管委會交流日', title: '場佈物品清點', owner: '示範召集人', due: '2026-11-22', days: 5, mine: false }],
    equipment: [
      { name: '投影機', quantity: 1, place: '秘書處', note: '含 HDMI 線' },
      { name: '關東旗與旗座', quantity: 6, place: '秘書處', note: '' },
      { name: '延長線', quantity: 4, place: '秘書處', note: '' },
    ],
    receiptAddress: '（示範模式：登入正式系統後會顯示郵寄地址）',
  },
};

const ERROR_MESSAGES = {
  invalid_credentials: '會員編號或手機末三碼不符，請再確認一次。',
  locked: '錯誤次數過多，帳號已暫時鎖定。請稍後再試，或加 LINE「寓委聯小幫手」由專人協助。',
  nothing_selected: '請至少勾選一個任務。',
  unauthorized: '登入已過期，請重新登入。',
  network: '連線失敗，請檢查網路後再試一次。',
  missing_fields: '還有必填欄位沒有填寫，請檢查標示 * 的欄位。',
  invalid_phone: '行動電話格式不正確，請輸入 09 開頭的 10 碼號碼。',
  invalid_email: '電子信箱格式不正確。',
  invalid_city: '請選擇社區所在縣市。',
  missing_consent: '請勾選同意事項。',
  missing_goals: '「你想要獲得的是」請至少選一項，或填寫「其他」。',
  already_volunteer: '你已經在志工名單裡了，請直接到志工專區登入；登入不了請加 LINE「寓委聯小幫手」。',
  missing_purpose: '「加入本會的主要目的」請至少選一項，或填寫「其他」。',
  missing_signature: '請在簽名框內簽名。',
  invalid_upload: '圖檔格式不支援，請使用 JPG 或 PNG。',
  upload_too_large: '圖檔太大，請換一張較小的圖片。',
  invalid_quantity: '數量超過上限：郵局與 7-11 寄送每張訂單最多 20 本。需要更多請分開下單、改選面交，或加 LINE「寓委聯小幫手」洽詢。',
  invalid_payment: '這個付款方式目前無法使用，請改選其他方式。',
  member_not_verified: '會員編號與手機末三碼對不起來，無法套用會員價。請確認後再試，或改選「一般訂購」。',
  invalid_last5: '帳號後五碼請填 5 個數字。',
  order_not_found: '找不到這筆訂單，請確認訂單編號與下單時填的手機。',
};
const errorMessage = (code) => ERROR_MESSAGES[code] || '系統忙碌中，請稍後再試。';

// Apps Script 不支援 CORS 預檢，所以用 text/plain 送 JSON。
const callApi = async (payload) => {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch {
    return { ok: false, error: 'network' };
  }
};

const demoApi = async (payload) => {
  if (payload.action === 'login') {
    const ok =
      payload.memberId.trim().toUpperCase() === DEMO_MEMBER.id &&
      payload.phone.replace(/\D/g, '').slice(-3) === DEMO_MEMBER.phone.slice(-3);
    return ok
      ? { ok: true, token: 'demo', member: { id: DEMO_MEMBER.id, name: DEMO_MEMBER.name }, ...DEMO_SERVICES }
      : { ok: false, error: 'invalid_credentials' };
  }
  if (payload.action === 'volunteerLogin') {
    const ok = payload.name.trim() === DEMO_VOLUNTEER.name && payload.phone.replace(/\D/g, '').slice(-3) === DEMO_VOLUNTEER.phone.slice(-3);
    return ok ? { ok: true, token: 'demo-volunteer', ...DEMO_VOLUNTEER.view } : { ok: false, error: 'invalid_credentials' };
  }
  if (payload.action === 'volunteerHome' || payload.action === 'volunteerSubmit') return { ok: true, ...DEMO_VOLUNTEER.view };
  if (payload.action === 'orderConfig') return { ok: false };
  if (payload.action === 'order') {
    const f = payload.fields;
    if (f.buyer === 'member' && !(f.memberId.trim().toUpperCase() === DEMO_MEMBER.id && f.memberPhone.replace(/\D/g, '').slice(-3) === DEMO_MEMBER.phone.slice(-3))) return { ok: false, error: 'member_not_verified' };
    const unit = f.buyer === 'member' ? 100 : 180;
    const fee = { post: 50, cvs: 60, meet: 0 }[f.shipping] ?? 50;
    return { ok: true, orderId: 'B000000001', total: unit * Number(f.quantity) + fee, bank: { name: '（示範模式）', account: '000-000-000000' } };
  }
  if (payload.action === 'vendors') return { ok: true, ...DEMO_SERVICES };
  if (payload.action === 'members' || payload.action === 'honorRoll') return { ok: false };
  return { ok: true };
};

const api = API_URL ? callApi : demoApi;

// ── 共用：年份與手機版選單 ──
const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.main-nav');
const yearEl = document.getElementById('year');

if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    nav.classList.toggle('open');
  });

  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => nav.classList.remove('open'));
  });
}

// ── 會員登入 ──
const SESSION_KEY = 'memberSession';
const loginForm = document.getElementById('loginForm');
const loginSection = document.getElementById('loginSection');
const loginError = document.getElementById('loginError');
const dashboard = document.getElementById('memberDashboard');
const memberGreeting = document.getElementById('memberGreeting');
const logoutBtn = document.getElementById('logoutBtn');
const vendorResults = document.getElementById('vendorResults');
const vendorSearch = document.getElementById('vendorSearch');

const getSession = () => {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
};

const renderVendors = (vendors) => {
  if (!vendorResults) return;
  const line = (tag, text, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  };
  vendorResults.replaceChildren(
    ...vendors.map((vendor) => {
      const item = document.createElement('div');
      item.className = 'vendor-item';
      const head = document.createElement('div');
      head.className = 'vendor-head';
      head.append(line('h3', vendor.name));
      if (vendor.rating) head.append(line('span', `${'★'.repeat(vendor.rating)}${'☆'.repeat(5 - vendor.rating)} ${vendor.rating} 分`, 'vendor-rating'));
      item.append(head);
      item.append(line('p', [vendor.services, vendor.area].filter(Boolean).join('｜')));
      const money = [vendor.paid, vendor.fee && `費用：${vendor.fee}`, vendor.households && `社區 ${vendor.households} 戶`].filter(Boolean).join('｜');
      if (money) item.append(line('p', money));
      const against = vendor.against || (vendor.rating && vendor.rating <= 2);
      if (vendor.against) head.append(line('span', '會員不推薦', 'vendor-against'));
      if (vendor.reasons) item.append(line('p', `${against ? '不推薦的原因' : '評分原因'}：${vendor.reasons}`, against ? 'warn' : ''));
      if (vendor.note) item.append(line('p', vendor.note));
      if (vendor.referrer) item.append(line('p', `分享人：${vendor.referrer}`));
      if (vendor.contact) item.append(line('span', `聯絡：${vendor.contact}`));
      return item;
    })
  );
  if (vendorSearch) vendorSearch.value = '';
};

const showLoginError = (code) => {
  if (!loginError) return;
  loginError.textContent = errorMessage(code);
  loginError.hidden = false;
};

const renderServices = (data) => {
  const equipment = Array.isArray(data.equipment) ? { assets: [], shared: data.equipment } : data.equipment || {};
  [['assetList', 'assetEmpty', equipment.assets || []], ['equipmentList', 'equipmentEmpty', equipment.shared || []]].forEach(([listId, emptyId, items]) => {
    const list = document.getElementById(listId);
    if (!list) return;
    list.replaceChildren(
      ...items.map((item) => {
        const box = document.createElement('div');
        box.className = 'vendor-item';
        const name = document.createElement('h3');
        name.textContent = item.quantity ? `${item.name}（${item.quantity}）` : item.name;
        const place = document.createElement('p');
        place.textContent = [item.place && `存放地點：${item.place}`, item.owner && `提供：${item.owner}`].filter(Boolean).join('｜');
        const note = document.createElement('span');
        note.textContent = item.note;
        box.append(name, place, note);
        return box;
      })
    );
    document.getElementById(emptyId).hidden = items.length > 0;
  });
  const links = document.getElementById('resourceLinks');
  if (links) {
    const entries = data.links || [];
    links.replaceChildren(
      ...entries.map((link) => {
        const li = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        anchor.textContent = link.label;
        li.append(anchor);
        return li;
      })
    );
    document.getElementById('resourceEmpty').hidden = entries.length > 0;
  }
};

// 服務選單：點一項只顯示那一項，隨時可以回選單
const openService = (key) => {
  const menu = document.getElementById('serviceMenu');
  if (!menu) return;
  menu.hidden = Boolean(key);
  document.querySelectorAll('[data-panel]').forEach((panel) => (panel.hidden = panel.dataset.panel !== key));
  if (key) document.querySelector(`[data-panel="${key}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
};
document.querySelectorAll('[data-service]').forEach((tile) => tile.addEventListener('click', () => openService(tile.dataset.service)));
document.querySelectorAll('[data-service-back]').forEach((button) => button.addEventListener('click', () => openService(null)));

const showDashboard = (member, vendors, data = {}) => {
  if (!dashboard) return;
  dashboard.hidden = false;
  if (loginSection) loginSection.hidden = true;
  if (loginError) loginError.hidden = true;
  if (memberGreeting) memberGreeting.textContent = `${member.name}（${member.id}）您好，歡迎回來。`;
  renderVendors(vendors);
  renderServices(data);
  const ms = data.membership;
  const card = document.getElementById('membershipCard');
  if (card) {
    card.hidden = !ms;
    if (ms) {
      document.getElementById('msType').textContent = ms.type || '—';
      document.getElementById('msStatus').textContent = ms.status ? `有效（${ms.status}）` : '—';
      document.getElementById('msSince').textContent = ms.since || '—';
      document.getElementById('msUntil').textContent = ms.until || '—';
      const hint = document.getElementById('msHint');
      hint.className = 'membership-hint' + (ms.daysLeft != null && ms.daysLeft <= 60 ? ' due-soon' : '');
      hint.textContent = ms.permanent ? '你是永久會員，不需要再繳常年會費。謝謝你的支持！'
        : !ms.until ? '會籍到期日尚未登錄，如有疑問請洽 LINE「寓委聯小幫手」。'
        : ms.daysLeft < 0 ? `會籍已於 ${ms.until} 到期，請儘快繳交常年會費以維持會員資格。`
        : ms.daysLeft <= 60 ? `會籍將在 ${ms.daysLeft} 天後到期。下一期常年會費請於 ${ms.until} 前繳交，繳費通知會另行寄給你。`
        : `下次繳費：下一期常年會費請於 ${ms.until} 前繳交。`;
    }
  }
  openService(null);
};

const logout = (errorCode) => {
  localStorage.removeItem(SESSION_KEY);
  if (!dashboard) return;
  dashboard.hidden = true;
  renderVendors([]);
  if (loginSection) loginSection.hidden = false;
  if (errorCode) showLoginError(errorCode);
};

if (dashboard) {
  const session = getSession();
  if (session) {
    api({ action: 'vendors', token: session.token }).then((result) => {
      if (result.ok) showDashboard(session.member, result.vendors, result);
      else logout(result.error === 'unauthorized' ? 'unauthorized' : null);
    });
  }
}

if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector('[type="submit"]');
    button.disabled = true;
    const result = await api({
      action: 'login',
      memberId: document.getElementById('memberId').value,
      phone: document.getElementById('memberPhone').value,
    });
    button.disabled = false;

    if (result.ok) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token: result.token, member: result.member }));
      loginForm.reset();
      showDashboard(result.member, result.vendors, result);
    } else {
      showLoginError(result.error);
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => logout());
}

if (vendorSearch && vendorResults) {
  vendorSearch.addEventListener('input', () => {
    const keywords = vendorSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    vendorResults.querySelectorAll('.vendor-item').forEach((item) => {
      const text = item.textContent.toLowerCase();
      item.hidden = !keywords.every((keyword) => text.includes(keyword));
    });
  });
}

// ── 會員名單：接上後端後顯示最新名單，否則顯示頁面上的靜態名單 ──
const memberTableBody = document.getElementById('memberTableBody');
const tabButtons = document.querySelectorAll('[data-tab]');

if (memberTableBody) {
  const emptyRow = document.createElement('tr');
  emptyRow.innerHTML = '<td class="empty" colspan="4">目前沒有這個類型的會員。</td>';

  const applyFilter = () => {
    const selected = document.querySelector('[data-tab].active')?.dataset.tab || 'all';
    let visible = 0;
    memberTableBody.querySelectorAll('tr[data-type]').forEach((row) => {
      row.hidden = selected !== 'all' && row.dataset.type !== selected;
      if (!row.hidden) visible++;
    });
    if (visible) emptyRow.remove();
    else memberTableBody.append(emptyRow);
  };

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      tabButtons.forEach((item) => item.classList.toggle('active', item === button));
      applyFilter();
    });
  });

  api({ action: 'members' }).then((result) => {
    if (!result.ok || !result.members?.length) return;
    memberTableBody.replaceChildren(
      ...result.members.map((member) => {
        const row = document.createElement('tr');
        row.dataset.type = member.type;
        [member.type, member.id, member.name, member.community || '—'].forEach((text, i) => {
          const cell = document.createElement('td');
          cell.textContent = text;
          if (i === 2 && text === '匿名') cell.className = 'anonymous';
          row.append(cell);
        });
        return row;
      })
    );
    applyFilter();
  });
}

// ── 表單送出（報名、志工請款、廠商推薦）──
// 以每個欄位的 <label> 文字當作試算表欄名，表單改版時後端不用跟著改。
const collectFields = (form) => {
  const fields = {};
  Array.from(form.elements).forEach((el) => {
    if (el.type === 'radio') {
      const legend = el.closest('fieldset')?.querySelector('legend');
      if (el.checked && legend) fields[legend.dataset.field || legend.textContent.trim()] = el.value;
      return;
    }
    if (el.type === 'checkbox') {
      const legend = el.closest('fieldset')?.querySelector('legend');
      if (el.checked && legend) (fields[legend.dataset.field] = fields[legend.dataset.field] || []).push(el.value);
      return;
    }
    const label = el.id && form.querySelector(`label[for="${el.id}"]`);
    if (label) fields[label.textContent.trim()] = el.value.trim();
  });
  return fields;
};

// 其他頁面以 contact.html?type=會員加入 這類連結帶入報名類型
const presetType = new URLSearchParams(location.search).get('type');
if (presetType) {
  const match = Array.from(document.querySelectorAll('input[name="contactType"]')).find(
    (input) => input.value === presetType
  );
  if (match) match.checked = true;
}

document.querySelectorAll('[data-form-type]').forEach((form) => {
  const successBox = form.parentElement.querySelector('.form-success');
  const errorBox = document.createElement('p');
  errorBox.className = 'form-error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  form.after(errorBox);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const emptyGroup = Array.from(form.querySelectorAll('[data-required-group]')).find((group) => !group.querySelector('input:checked'));
    if (emptyGroup) {
      errorBox.textContent = `「${emptyGroup.querySelector('legend').dataset.field}」請至少選一項。`;
      errorBox.hidden = false;
      emptyGroup.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      return;
    }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    errorBox.hidden = true;
    if (successBox) successBox.classList.remove('visible');

    const result = await api({
      action: 'form',
      formType: form.dataset.formType,
      fields: collectFields(form),
      website: form.querySelector('[name="website"]')?.value || '',
      token: getSession()?.token,
    });
    button.disabled = false;

    if (result.ok) {
      if (successBox) successBox.classList.add('visible');
      form.reset();
    } else if (result.error === 'unauthorized') {
      logout('unauthorized');
    } else {
      errorBox.textContent = errorMessage(result.error);
      errorBox.hidden = false;
    }
  });
});

// ── 活動照片：分類篩選與燈箱 ──
const albumTabs = document.querySelectorAll('[data-album-tab]');
const albums = document.querySelectorAll('[data-album]');

albumTabs.forEach((button) => {
  button.addEventListener('click', () => {
    const selected = button.dataset.albumTab;
    albumTabs.forEach((item) => item.classList.toggle('active', item === button));
    albums.forEach((album) => {
      album.hidden = selected !== 'all' && album.dataset.album !== selected;
    });
  });
});

const lightbox = document.getElementById('lightbox');
if (lightbox) {
  const image = lightbox.querySelector('img');
  const captionEl = lightbox.querySelector('figcaption');
  let current = [];
  let position = 0;

  const show = (index) => {
    position = (index + current.length) % current.length;
    const photo = current[position];
    image.src = photo.href;
    image.alt = photo.dataset.caption;
    captionEl.textContent = `${photo.dataset.caption}（${position + 1}／${current.length}）`;
  };

  document.querySelectorAll('.gallery-group .photo').forEach((photo) => {
    photo.addEventListener('click', (event) => {
      event.preventDefault();
      current = Array.from(photo.closest('.photo-grid').querySelectorAll('.photo'));
      show(current.indexOf(photo));
      lightbox.showModal();
    });
  });

  lightbox.querySelector('.prev').addEventListener('click', () => show(position - 1));
  lightbox.querySelector('.next').addEventListener('click', () => show(position + 1));
  lightbox.querySelector('.lightbox-close').addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(position - 1);
    if (event.key === 'ArrowRight') show(position + 1);
  });
}

// ── 線上入會申請 ──
const joinForm = document.querySelector('[data-join]');
if (joinForm) {
  const joinError = joinForm.querySelector('[data-join-error]');
  const joinDone = document.querySelector('[data-join-done]');
  const currentType = () => joinForm.querySelector('input[name="type"]:checked').value;

  // 依申請類別切換區塊；隱藏區塊的欄位停用，才不會被當成必填
  const syncType = () => {
    joinForm.querySelectorAll('[data-for]').forEach((section) => {
      const active = section.dataset.for === currentType();
      section.hidden = !active;
      section.querySelectorAll('input, select').forEach((el) => (el.disabled = !active));
    });
  };
  joinForm.querySelectorAll('input[name="type"]').forEach((radio) => radio.addEventListener('change', syncType));
  syncType();

  // 簽名板
  const pads = {};
  joinForm.querySelectorAll('[data-signature]').forEach((wrap) => {
    const canvas = wrap.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const pad = { canvas, signed: false };
    pads[wrap.dataset.signature] = pad;
    if (!ctx) return;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#3b2405';
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [((event.clientX - rect.left) * canvas.width) / rect.width, ((event.clientY - rect.top) * canvas.height) / rect.height];
    };
    let drawing = false;
    canvas.addEventListener('pointerdown', (event) => {
      drawing = true;
      canvas.setPointerCapture(event.pointerId);
      ctx.beginPath();
      ctx.moveTo(...point(event));
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drawing) return;
      ctx.lineTo(...point(event));
      ctx.stroke();
      pad.signed = true;
    });
    ['pointerup', 'pointercancel'].forEach((name) => canvas.addEventListener(name, () => (drawing = false)));
    wrap.querySelector('[data-clear]').addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pad.signed = false;
    });
  });


  // 上傳圖檔先縮到 1600px 內的 JPEG，避免手機照片過大
  const readImage = (file) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(img.src);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('invalid_upload'));
      img.src = URL.createObjectURL(file);
    });

  const fail = (code, el) => {
    joinError.textContent = errorMessage(code);
    joinError.hidden = false;
    if (el) {
      el.classList.add('invalid');
      el.focus();
    }
    (el || joinError).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };

  joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    joinError.hidden = true;
    joinForm.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));

    const controls = Array.from(joinForm.elements).filter((el) => el.name && !el.disabled);
    const missing = controls.find((el) => el.required && (el.type === 'checkbox' ? !el.checked : !el.value.trim()));
    if (missing) return fail(missing.type === 'checkbox' ? 'missing_consent' : 'missing_fields', missing);

    const fields = {};
    controls.forEach((el) => {
      if (el.name === 'website') return;
      if (el.type === 'radio') {
        if (el.checked) fields[el.name] = el.value;
      } else if (el.type === 'checkbox' && el.name === 'purpose') {
        if (el.checked) (fields.purpose = fields.purpose || []).push(el.value);
      } else if (el.type === 'checkbox') fields[el.name] = el.checked;
      else fields[el.name] = el.value.trim();
    });
    if (fields.purposeOther) (fields.purpose = fields.purpose || []).push(fields.purposeOther);
    delete fields.purposeOther;
    if (!fields.purpose?.length) return fail('missing_purpose', joinForm.querySelector('[name="purpose"]'));

    const group = fields.type === '團體會員';
    const phoneField = joinForm.querySelector(group ? '[name="groupMobile"]' : '[name="mobile"]');
    if (!/^09\d{8}$/.test(phoneField.value.replace(/\D/g, ''))) return fail('invalid_phone', phoneField);

    // 個人：申請人簽名。團體：負責人＋代表 1 必簽；有填代表 2 的姓名才需要代表 2 簽名
    const needed = group ? ['ownerSignature', 'repSignature'].concat(fields.rep2Name ? ['rep2Signature'] : []) : ['signature'];
    const unsigned = needed.find((name) => !pads[name].signed);
    if (unsigned) return fail('missing_signature', pads[unsigned].canvas);
    needed.forEach((name) => (fields[name] = pads[name].canvas.toDataURL('image/png')));

    const button = joinForm.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      for (const input of joinForm.querySelectorAll('[data-upload]')) {
        if (!input.disabled && input.files[0]) fields[input.dataset.upload] = await readImage(input.files[0]);
      }
    } catch {
      button.disabled = false;
      return fail('invalid_upload');
    }

    const result = await api({ action: 'apply', fields, website: joinForm.querySelector('[name="website"]').value });
    button.disabled = false;
    if (!result.ok) return fail(result.error);

    joinForm.hidden = true;
    joinDone.hidden = false;
    joinDone.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  });
}

// ── 志工專區 ──
const volunteerLoginForm = document.getElementById('volunteerLoginForm');
if (volunteerLoginForm) {
  const V_KEY = 'volunteerSession';
  const loginBox = document.getElementById('volunteerLoginSection');
  const board = document.getElementById('volunteerDashboard');
  const vError = document.getElementById('volunteerLoginError');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const getV = () => {
    try {
      return JSON.parse(localStorage.getItem(V_KEY));
    } catch {
      return null;
    }
  };

  // 任務清單：可報名的打勾；已報名的顯示審核狀態
  const renderTasks = (tasks) => {
    const list = document.getElementById('taskList');
    list.replaceChildren(
      ...tasks.map((task) => {
        const card = el('label', 'task-card' + (task.mine ? ' is-joined' : ''));
        const box = el('input');
        box.type = 'checkbox';
        box.name = 'tasks';
        box.value = task.name;
        box.disabled = Boolean(task.mine);
        const body = el('div', 'task-body');
        const head = el('div', 'task-head');
        head.append(el('strong', '', task.name));
        if (task.mine) head.append(el('span', `task-state state-${task.mine === '通過' ? 'ok' : task.mine === '未通過' ? 'no' : 'wait'}`, task.mine === '通過' ? '已加入' : task.mine === '未通過' ? '未通過' : '審核中'));
        body.append(head);
        const when = [task.start, task.end].filter(Boolean).join(' ～ ');
        const meta = [task.type, when, task.lead && `召集人：${task.lead}`].filter(Boolean).join('｜');
        if (meta) body.append(el('p', 'task-meta', meta));
        if (task.description) body.append(el('p', '', task.description));
        const facts = el('dl', 'task-facts');
        [
          ['需要人數', task.needed ? `${task.needed}${/\D/.test(task.needed) ? '' : ' 人'}（已加入 ${task.joined} 人）` : ''],
          ['人員條件', task.requirement],
          ['參與回饋', task.reward],
        ].forEach(([label, value]) => {
          if (!value) return;
          facts.append(el('dt', '', label), el('dd', '', value));
        });
        if (facts.children.length) body.append(facts);
        card.append(box, body);
        return card;
      })
    );
    document.getElementById('taskEmpty').hidden = tasks.length > 0;
    document.getElementById('signupSubmit').hidden = !tasks.some((task) => !task.mine);
  };

  const renderReminders = (items) => {
    const list = document.getElementById('reminderList');
    list.replaceChildren(
      ...items.map((item) => {
        const li = el('li', item.days != null && item.days < 0 ? 'overdue' : '');
        const due = item.days == null ? '未定期限' : item.days < 0 ? `已逾期 ${-item.days} 天` : item.days === 0 ? '今天到期' : `還有 ${item.days} 天`;
        li.append(el('time', '', item.due ? `${item.due}（${due}）` : due), el('span', '', `${item.task}－${item.title}${item.owner ? `（${item.owner}）` : ''}`));
        return li;
      })
    );
    document.getElementById('reminderEmpty').hidden = items.length > 0;
  };

  // 器材：像購物車一樣勾選、調整數量
  const renderEquipment = (items) => {
    const list = document.getElementById('cartList');
    list.replaceChildren(
      ...items.map((item) => {
        const row = el('div', 'cart-row');
        const info = el('div');
        info.append(el('strong', '', item.name), el('small', '', [item.quantity ? `現有 ${item.quantity}` : '', item.place, item.note].filter(Boolean).join('｜')));
        const stepper = el('div', 'stepper');
        const minus = el('button', '', '−');
        const plus = el('button', '', '＋');
        const qty = el('input');
        [minus, plus].forEach((b) => (b.type = 'button'));
        qty.type = 'number';
        qty.min = 0;
        qty.max = item.quantity || 99;
        qty.value = 0;
        qty.dataset.cartItem = item.name;
        qty.setAttribute('aria-label', `${item.name} 數量`);
        const bump = (n) => {
          qty.value = Math.min(Number(qty.max), Math.max(0, (Number(qty.value) || 0) + n));
          row.classList.toggle('in-cart', Number(qty.value) > 0);
        };
        minus.addEventListener('click', () => bump(-1));
        plus.addEventListener('click', () => bump(1));
        qty.addEventListener('input', () => bump(0));
        stepper.append(minus, qty, plus);
        row.append(info, stepper);
        return row;
      })
    );
    document.getElementById('cartEmpty').hidden = items.length > 0;
  };

  const render = (data) => {
    document.getElementById('volunteerGreeting').textContent = `${data.volunteer.name} 您好，謝謝你的付出。`;
    document.getElementById('vHours').textContent = data.stats.hours;
    document.getElementById('vAttended').textContent = data.stats.attended;
    document.getElementById('vTasks').textContent = data.stats.tasks;
    document.getElementById('vPoints').textContent = data.stats.points ?? 0;
    const lv = data.level;
    if (lv) {
      const years = Math.floor(lv.months / 12);
      document.getElementById('lvRank').textContent = `Lv.${lv.rank}`;
      document.getElementById('lvName').textContent = lv.name;
      document.getElementById('lvJoined').textContent = data.volunteer.joined || '—';
      document.getElementById('lvTenure').textContent = data.volunteer.joined ? (years ? `${years} 年 ${lv.months % 12} 個月` : `${lv.months} 個月`) : '—';
      document.getElementById('lvBar').style.width = `${Math.round((lv.rank / lv.of) * 100)}%`;
      const need = lv.next && [lv.next.needMonths ? `再服務 ${lv.next.needMonths} 個月` : '', lv.next.needPoints ? `再累積 ${lv.next.needPoints} 點積分` : ''].filter(Boolean).join('、');
      document.getElementById('lvNext').textContent = !lv.next ? '你已經是最高等級的志工，謝謝你一路以來的付出！' : need ? `${need}，就能晉升「${lv.next.name}」。` : `已達「${lv.next.name}」的條件，等級將在下次更新時調整。`;
    }
    renderTasks(data.tasks || []);
    renderReminders(data.reminders || []);
    renderEquipment(data.equipment || []);
    document.getElementById('receiptAddress').textContent = data.receiptAddress || '請洽秘書長';

    const body = document.getElementById('volunteerHistory');
    body.replaceChildren(
      ...(data.history.length ? data.history : [null]).map((h) => {
        const row = el('tr');
        if (!h) {
          row.innerHTML = '<td class="empty" colspan="5">還沒有服務紀錄。</td>';
          return row;
        }
        [h.date, h.task, h.role || '—', h.hours, h.presence].forEach((text) => row.append(el('td', '', text)));
        return row;
      })
    );
    loginBox.hidden = true;
    board.hidden = false;
    document.body.classList.add('volunteer-in');
  };

  const signOut = (code) => {
    localStorage.removeItem(V_KEY);
    board.hidden = true;
    loginBox.hidden = false;
    document.body.classList.remove('volunteer-in');
    if (code) {
      vError.textContent = errorMessage(code);
      vError.hidden = false;
    }
  };

  const saved = getV();
  if (saved) {
    api({ action: 'volunteerHome', token: saved.token }).then((result) => (result.ok ? render(result) : signOut(result.error === 'unauthorized' ? 'unauthorized' : null)));
  }

  volunteerLoginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    vError.hidden = true;
    const button = volunteerLoginForm.querySelector('[type="submit"]');
    button.disabled = true;
    const result = await api({ action: 'volunteerLogin', name: document.getElementById('volunteerName').value, phone: document.getElementById('volunteerPhone').value });
    button.disabled = false;
    if (!result.ok) {
      vError.textContent = result.error === 'invalid_credentials' ? '姓名或手機末三碼不符，請再確認一次。' : errorMessage(result.error);
      vError.hidden = false;
      return;
    }
    localStorage.setItem(V_KEY, JSON.stringify({ token: result.token }));
    volunteerLoginForm.reset();
    render(result);
  });

  document.getElementById('volunteerLogout').addEventListener('click', () => signOut());

  const workTabs = document.querySelectorAll('[data-work-tab]');
  workTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      workTabs.forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('[data-work]').forEach((panel) => (panel.hidden = panel.dataset.work !== tab.dataset.workTab));
    });
  });

  // 請款：一張收據的所有品項填在同一張申請
  const itemRows = document.getElementById('expenseItems');
  const money = (n) => `NT$ ${Math.round(n).toLocaleString('en-US')}`;
  const recalc = () => {
    let total = 0;
    itemRows.querySelectorAll('.item-row').forEach((row) => {
      const sub = (Number(row.querySelector('[data-f="price"]').value) || 0) * (Number(row.querySelector('[data-f="qty"]').value) || 0);
      row.querySelector('.item-sub').textContent = money(sub);
      total += Math.round(sub);
    });
    document.getElementById('expenseTotal').textContent = money(total);
  };
  const addItemRow = () => {
    const row = el('div', 'item-row');
    const mk = (f, type, placeholder, label) => {
      const input = el('input');
      input.type = type;
      input.dataset.f = f;
      input.placeholder = placeholder;
      input.setAttribute('aria-label', label);
      if (type === 'number') {
        input.min = 0;
        input.step = f === 'qty' ? 1 : 'any';
        input.inputMode = 'decimal';
      }
      input.addEventListener('input', recalc);
      return input;
    };
    const remove = el('button', 'item-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', '刪除這一項');
    remove.addEventListener('click', () => {
      if (itemRows.querySelectorAll('.item-row').length > 1) row.remove();
      recalc();
    });
    const qty = mk('qty', 'number', '數量', '數量');
    qty.value = 1;
    row.append(mk('name', 'text', '品名，例：A4 影印紙', '品名'), mk('price', 'number', '單價', '單價'), qty, el('span', 'item-sub', money(0)), remove);
    itemRows.append(row);
  };
  document.getElementById('addExpenseItem').addEventListener('click', addItemRow);
  addItemRow();

  const gather = {
    signup: (form) => ({ tasks: Array.from(form.querySelectorAll('[name="tasks"]:checked')).map((box) => box.value), note: form.querySelector('[name="note"]').value }),
    expense: (form) => ({
      task: form.querySelector('[name="task"]').value,
      method: form.querySelector('[name="method"]:checked').value,
      note: form.querySelector('[name="note"]').value,
      items: Array.from(itemRows.querySelectorAll('.item-row')).map((row) => ({ name: row.querySelector('[data-f="name"]').value.trim(), price: row.querySelector('[data-f="price"]').value, qty: row.querySelector('[data-f="qty"]').value })).filter((it) => it.name),
    }),
    equipment: (form) => ({
      task: form.querySelector('[name="task"]').value,
      from: form.querySelector('[name="from"]').value,
      to: form.querySelector('[name="to"]').value,
      other: form.querySelector('[name="other"]').value,
      note: form.querySelector('[name="note"]').value,
      items: Array.from(form.querySelectorAll('[data-cart-item]')).map((q) => ({ name: q.dataset.cartItem, qty: Number(q.value) || 0 })).filter((it) => it.qty > 0),
    }),
  };

  document.querySelectorAll('form[data-volunteer-form]').forEach((form) => {
    const success = form.parentElement.querySelector('.form-success');
    const error = form.parentElement.querySelector('.form-error');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      success.classList.remove('visible');
      error.hidden = true;
      const kind = form.dataset.volunteerForm;
      const fields = gather[kind](form);
      const problem =
        kind === 'signup' && !fields.tasks.length ? 'nothing_selected'
        : kind === 'expense' && (!fields.task.trim() || !fields.items.length) ? 'missing_fields'
        : kind === 'equipment' && (!fields.task.trim() || !fields.from || (!fields.items.length && !fields.other.trim())) ? 'missing_fields'
        : '';
      if (problem) {
        error.textContent = errorMessage(problem);
        error.hidden = false;
        return;
      }
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      const result = await api({ action: 'volunteerSubmit', kind, fields, token: getV()?.token });
      button.disabled = false;
      if (result.ok) {
        form.reset();
        if (kind === 'expense') {
          itemRows.replaceChildren();
          addItemRow();
          recalc();
        }
        if (result.volunteer) render(result);
        success.classList.add('visible');
      } else if (result.error === 'unauthorized') {
        signOut('unauthorized');
      } else {
        error.textContent = errorMessage(result.error);
        error.hidden = false;
      }
    });
  });
}

// ── 書籍訂購 ──
const orderForm = document.querySelector('[data-order]');
if (orderForm) {
  const money = (n) => `NT$ ${Number(n).toLocaleString('en-US')}`;
  let config = { price: 180, memberPrice: 100, maxQuantity: 50, shipping: { post: { label: '郵局寄送', fee: 50, max: 20 }, cvs: { label: '7-11 店到店', fee: 60, max: 20 }, meet: { label: '面交', fee: 0, max: 50 } }, payments: ['transfer'] };
  const maxFor = () => config.shipping[val('shipping')]?.max || config.maxQuantity;
  const orderError = orderForm.querySelector('[data-order-error]');
  const qty = orderForm.querySelector('[name="quantity"]');
  const val = (name) => orderForm.querySelector(`[name="${name}"]:checked`)?.value;

  const refresh = () => {
    const member = val('buyer') === 'member';
    const shipping = val('shipping');
    const n = Math.min(maxFor(), Math.max(1, Math.floor(Number(qty.value)) || 1));
    qty.max = maxFor();
    if (Number(qty.value) > maxFor()) qty.value = maxFor();
    const unit = member ? config.memberPrice : config.price;
    const fee = config.shipping[shipping].fee;
    document.getElementById('sumBooks').textContent = `${money(unit)} × ${n}`;
    document.getElementById('sumShipping').textContent = `${config.shipping[shipping].label} ${money(fee)}`;
    document.getElementById('sumTotal').textContent = money(unit * n + fee);
    // 依選項顯示對應欄位；隱藏的欄位停用，才不會被當成必填
    orderForm.querySelectorAll('[data-show]').forEach((box) => {
      const [field, value] = box.dataset.show.split('=');
      const active = val(field) === value;
      box.hidden = !active;
      box.querySelectorAll('input, select').forEach((el) => (el.disabled = !active));
    });
    orderForm.querySelectorAll('[data-payment]').forEach((el) => (el.hidden = !config.payments.includes(el.dataset.payment)));
  };

  orderForm.addEventListener('input', refresh);
  orderForm.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => {
      qty.value = Math.min(maxFor(), Math.max(1, (Math.floor(Number(qty.value)) || 1) + Number(button.dataset.step)));
      refresh();
    });
  });
  api({ action: 'orderConfig' }).then((result) => {
    if (result.ok) config = result;
    document.querySelectorAll('[data-price]').forEach((el) => (el.textContent = config[el.dataset.price]));
    document.querySelectorAll('[data-fee]').forEach((el) => (el.textContent = config.shipping[el.dataset.fee]?.fee ?? el.textContent));
    document.querySelectorAll('[data-max]').forEach((el) => (el.textContent = config.shipping[el.dataset.max]?.max ?? el.textContent));
    refresh();
  });
  refresh();

  const fail = (code, el) => {
    orderError.textContent = errorMessage(code);
    orderError.hidden = false;
    if (el) {
      el.classList.add('invalid');
      el.focus();
    }
    (el || orderError).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };

  orderForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    orderError.hidden = true;
    orderForm.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    const controls = Array.from(orderForm.elements).filter((el) => el.name && !el.disabled);
    const missing = controls.find((el) => el.required && (el.type === 'checkbox' ? !el.checked : !el.value.trim()));
    if (missing) return fail(missing.type === 'checkbox' ? 'missing_consent' : 'missing_fields', missing);
    const phone = orderForm.querySelector('[name="phone"]');
    if (!/^09\d{8}$/.test(phone.value.replace(/\D/g, ''))) return fail('invalid_phone', phone);

    const fields = {};
    controls.forEach((el) => {
      if (el.name === 'website') return;
      if (el.type === 'radio') {
        if (el.checked) fields[el.name] = el.value;
      } else if (el.type === 'checkbox') fields[el.name] = el.checked;
      else fields[el.name] = el.value.trim();
    });

    const button = orderForm.querySelector('[type="submit"]');
    button.disabled = true;
    const result = await api({ action: 'order', fields, website: orderForm.querySelector('[name="website"]').value });
    button.disabled = false;
    if (!result.ok) return fail(result.error, result.error === 'member_not_verified' ? orderForm.querySelector('[name="memberId"]') : null);

    document.getElementById('doneOrderId').textContent = result.orderId;
    document.getElementById('doneTotal').textContent = money(result.total);
    const bank = result.bank || {};
    document.getElementById('doneBank').textContent = bank.account
      ? `${bank.name}${bank.code ? `（${bank.code}）` : ''}　帳號 ${bank.account}${bank.holder ? `　戶名 ${bank.holder}` : ''}`
      : '匯款帳號請見確認信。';
    document.getElementById('doneMeet').hidden = fields.shipping !== 'meet';
    document.getElementById('reportOrderId').value = result.orderId;
    document.getElementById('reportPhone').value = fields.phone;
    orderForm.closest('[data-order-layout]').hidden = true;
    document.getElementById('orderDone').hidden = false;
    document.getElementById('orderDone').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  });

  // 回報匯款（下單完成後、或從確認信的連結 order.html?report=訂單編號 進來）
  const reportForm = document.getElementById('reportForm');
  const reportId = new URLSearchParams(location.search).get('report');
  if (reportId) {
    document.getElementById('reportOrderId').value = reportId;
    document.getElementById('reportSection').scrollIntoView?.({ block: 'start' });
  }
  reportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const box = reportForm.parentElement;
    const success = box.querySelector('.form-success');
    const error = box.querySelector('.form-error');
    success.classList.remove('visible');
    error.hidden = true;
    const button = reportForm.querySelector('[type="submit"]');
    button.disabled = true;
    const result = await api({
      action: 'orderReport',
      orderId: document.getElementById('reportOrderId').value,
      phone: document.getElementById('reportPhone').value,
      last5: document.getElementById('reportLast5').value,
    });
    button.disabled = false;
    if (result.ok) {
      success.textContent = result.already ? '這筆訂單已經確認收款了，謝謝！' : '已收到回報，我們對帳後就會出貨，出貨時會再寄信通知你。';
      success.classList.add('visible');
      reportForm.reset();
    } else {
      error.textContent = errorMessage(result.error);
      error.hidden = false;
    }
  });
}

// ── 榮譽志工：照片放在 assets/volunteers/綽號.jpg（或 .png），有就顯示，沒有就用綽號第一個字的頭像 ──
const honorList = document.getElementById('honorList');
if (honorList) {
  const loadPhoto = (slot) => {
    const name = slot.dataset.honorPhoto;
    const tryNext = (exts) => {
      if (!exts.length) return;
      const img = new Image();
      img.alt = `${name}的照片`;
      img.onload = () => slot.replaceChildren(img);
      img.onerror = () => tryNext(exts.slice(1));
      img.src = `assets/volunteers/${encodeURIComponent(name)}.${exts[0]}`;
    };
    tryNext(['jpg', 'png', 'jpeg']);
  };
  const renderHonor = (people) => {
    honorList.replaceChildren(
      ...people.map((person) => {
        const li = document.createElement('li');
        li.className = 'honor-card';
        const slot = document.createElement('span');
        slot.className = 'honor-photo';
        slot.dataset.honorPhoto = person.nickname;
        const initial = document.createElement('b');
        initial.textContent = person.nickname.slice(0, 1);
        slot.append(initial);
        const name = document.createElement('strong');
        name.textContent = person.nickname;
        const award = document.createElement('em');
        award.className = 'honor-award';
        award.textContent = person.award || '';
        const note = document.createElement('small');
        note.textContent = person.note || '';
        li.append(slot, name, award, note);
        return li;
      })
    );
    honorList.querySelectorAll('[data-honor-photo]').forEach(loadPhoto);
  };
  honorList.querySelectorAll('[data-honor-photo]').forEach(loadPhoto);
  api({ action: 'honorRoll' }).then((result) => {
    if (!result.ok || !result.people?.length) return;
    document.getElementById('honorYear').textContent = result.year;
    renderHonor(result.people);
  });
}

// ── 加入志工（volunteer-join.html）──
const volunteerJoinForm = document.getElementById('volunteerJoinForm');
if (volunteerJoinForm) {
  const errorBox = document.getElementById('volunteerJoinError');
  const successBox = document.getElementById('volunteerJoinSuccess');
  const fail = (code, el) => {
    errorBox.textContent = errorMessage(code);
    errorBox.hidden = false;
    el?.focus?.();
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };

  volunteerJoinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const missing = Array.from(volunteerJoinForm.querySelectorAll('[required]')).find((el) => (el.type === 'checkbox' ? !el.checked : !el.value.trim()));
    if (missing) return fail(missing.type === 'checkbox' ? 'missing_consent' : 'missing_fields', missing);
    const phone = volunteerJoinForm.querySelector('[name="phone"]');
    if (!/^09\d{8}$/.test(phone.value.replace(/\D/g, ''))) return fail('invalid_phone', phone);

    const data = new FormData(volunteerJoinForm);
    const fields = {};
    ['name', 'nickname', 'phone', 'address', 'email', 'birthday', 'skills', 'hobbies', 'school', 'job'].forEach((key) => { fields[key] = String(data.get(key) || '').trim(); });
    fields.goals = data.getAll('goals');
    const other = String(data.get('goalsOther') || '').trim();
    if (other) fields.goals.push(other);
    if (!fields.goals.length) return fail('missing_goals', volunteerJoinForm.querySelector('[name="goals"]'));
    fields.agreed = '是';

    const button = volunteerJoinForm.querySelector('[type="submit"]');
    button.disabled = true;
    const result = await api({ action: 'volunteerApply', fields, website: String(data.get('website') || '') });
    button.disabled = false;
    if (!result.ok) return fail(result.error);
    volunteerJoinForm.hidden = true;
    successBox.classList.add('visible');
    successBox.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  });
}
