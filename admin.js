// 行政中心（admin.html）。沿用 script.js 的 api、登入憑證與錯誤訊息。
ERROR_MESSAGES.forbidden = '這個會員編號沒有行政中心的權限。請到試算表「設定」的「管理員會員編號」加入後再試。';

// 示範模式用的假資料（人名皆為虛構），接上後端後不會用到。
const DEMO_ADMIN = {
  ok: true,
  volunteers: [
    { nickname: '小米', name: '王示範', email: 'demo1@example.com', phone: '0911000111', line: 'demo_mi', status: '在職', joined: '2024-03-02', skills: '主持、美編', memberId: 'B00000', note: '',
      stats: { tasks: 3, attended: 4, leave: 1, absent: 0, hours: 17.5, last: '2026-09-06', roles: ['主持', '報到', '場佈'] },
      history: [
        { date: '2026-09-06', task: '社區坐一坐 9 月場', role: '主持', hours: 3, presence: '出席' },
        { date: '2026-07-04', task: '社區坐一坐 7 月場', role: '', hours: 0, presence: '請假' },
        { date: '2026-04-04', task: '寓動會', role: '報到', hours: 8, presence: '出席' },
        { date: '2026-04-03', task: '寓動會', role: '場佈', hours: 3.5, presence: '出席' },
        { date: '2026-02-27', task: '會員大會', role: '報到', hours: 3, presence: '出席' },
      ] },
    { nickname: '阿樹', name: '林示範', email: 'demo2@example.com', phone: '0922000222', line: '', status: '在職', joined: '2025-01-15', skills: '攝影', memberId: '', note: '平日晚上較有空',
      stats: { tasks: 2, attended: 2, leave: 0, absent: 1, hours: 11, last: '2026-04-04', roles: ['攝影'] },
      history: [
        { date: '2026-05-02', task: '社區坐一坐 5 月場', role: '攝影', hours: 0, presence: '缺席' },
        { date: '2026-04-04', task: '寓動會', role: '攝影', hours: 8, presence: '出席' },
        { date: '2026-02-27', task: '會員大會', role: '攝影', hours: 3, presence: '出席' },
      ] },
    { nickname: 'Kiki', name: '陳示範', email: '', phone: '', line: '', status: '退出', joined: '2024-06-01', skills: '', memberId: '', note: '',
      stats: { tasks: 0, attended: 0, leave: 0, absent: 0, hours: 0, last: '', roles: [] }, history: [] },
  ],
  unmatched: ['小明'],
  work: [
    { task: '萬聖節', title: '聯辦社區發函', owner: '小米', status: '進行中', due: '2026-09-12', days: -7 },
    { task: '萬聖節', title: '場地確認', owner: '阿樹', status: '未開始', due: '2026-09-26', days: 7 },
    { task: 'Podcast', title: '第 11 集腳本', owner: '小米', status: '未開始', due: '', days: null },
  ],
  meetings: [
    { name: '萬聖節籌備會', date: '2026-09-26', time: '19:30', place: '線上', days: 7, hints: ['⚠ 已到章程規定的通知期限（7 日前），開會通知還沒寄'] },
  ],
  plan: ['會員大會：上次 2026/2/27，依章程每 12 個月至少一次，最晚 2027/2/27 前要召開，目前還沒排定。'],
  tasks: [{ name: '萬聖節', type: '活動', status: '進行中', start: '2026-10-01', end: '2026-10-31', lead: '小米' }],
};

const adminDashboard = document.getElementById('adminDashboard');

if (adminDashboard) {
  const loginSectionEl = document.getElementById('adminLoginSection');
  const loginFormEl = document.getElementById('adminLoginForm');
  const loginErrorEl = document.getElementById('adminLoginError');
  const tableBody = document.getElementById('volunteerTableBody');
  const searchInput = document.getElementById('volunteerSearch');
  const dialog = document.getElementById('volunteerDialog');
  const detail = document.getElementById('volunteerDetail');
  let volunteers = [];

  // 一律用 textContent 放資料，試算表裡的內容不會被當成 HTML 執行
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const shortDate = (iso) => (iso ? iso.slice(5).replace('-', '/') : '—');
  const daysLabel = (days) => (days == null ? '未設截止日' : days === 0 ? '今天' : days > 0 ? `${days} 天後` : `逾期 ${-days} 天`);
  const daysClass = (days) => (days == null ? 'badge-yellow' : days < 0 ? 'badge-red' : days <= 3 ? 'badge-yellow' : 'badge-teal');
  const isActiveVolunteer = (v) => ['', '在職', '服務中'].includes(v.status);

  const fillList = (id, items, emptyText, build) => {
    const list = document.getElementById(id);
    list.replaceChildren(...(items.length ? items.map(build) : [el('li', emptyText, 'admin-empty')]));
  };

  const renderStats = (data) => {
    const active = data.volunteers.filter(isActiveVolunteer);
    const hours = Math.round(data.volunteers.reduce((sum, v) => sum + v.stats.hours, 0) * 10) / 10;
    const overdue = data.work.filter((w) => w.days != null && w.days < 0).length;
    const next = data.meetings[0];
    const stats = [
      [active.length, '在職志工'],
      [hours, '累計服務時數'],
      [data.work.length, overdue ? `待辦工作（${overdue} 件逾期）` : '待辦工作'],
      [next ? daysLabel(next.days) : '—', next ? `下次會議：${next.name}` : '45 天內沒有會議'],
    ];
    document.getElementById('adminStats').replaceChildren(
      ...stats.map(([value, label]) => {
        const item = el('div', null, 'stat-item');
        item.append(el('strong', String(value)), el('span', label));
        return item;
      })
    );
  };

  const renderLists = (data) => {
    fillList('adminWork', data.work, '目前沒有快到期的工作。', (w) => {
      const item = el('li');
      item.append(
        el('span', daysLabel(w.days), `badge ${daysClass(w.days)}`),
        el('strong', [w.task, w.title].filter(Boolean).join('－')),
        el('small', [w.owner, w.status, w.due && `截止 ${shortDate(w.due)}`].filter(Boolean).join('・'))
      );
      return item;
    });

    const meetingItems = data.meetings.map((m) => ({ badge: daysLabel(m.days), cls: daysClass(m.days), title: m.name,
      lines: [[shortDate(m.date), m.time, m.place].filter(Boolean).join(' '), ...m.hints] }));
    const planItems = data.plan.map((text) => ({ badge: '該排日期了', cls: 'badge-red', title: text.split('：')[0], lines: [text.split('：').slice(1).join('：')] }));
    fillList('adminMeetings', [...meetingItems, ...planItems], '近期沒有會議，定期會議也都還在期限內。', (m) => {
      const item = el('li');
      item.append(el('span', m.badge, `badge ${m.cls}`), el('strong', m.title), ...m.lines.map((line) => el('small', line)));
      return item;
    });

    fillList('adminTasks', data.tasks, '目前沒有進行中的任務。', (t) => {
      const item = el('li');
      item.append(
        el('span', t.status || '進行中', 'badge badge-teal'),
        el('strong', t.name),
        el('small', [t.type, t.lead && `召集人 ${t.lead}`, t.start && `${shortDate(t.start)}～${shortDate(t.end)}`].filter(Boolean).join('・'))
      );
      return item;
    });
  };

  const showVolunteer = (v) => {
    const heading = el('h3', v.nickname && v.name ? `${v.nickname}（${v.name}）` : v.nickname || v.name);
    const info = el('dl', null, 'admin-info');
    [
      ['狀態', v.status], ['Email', v.email], ['手機', v.phone], ['LINE ID', v.line], ['加入日期', v.joined.replaceAll('-', '/')],
      ['會員編號', v.memberId], ['專長', v.skills], ['備註', v.note],
    ].filter(([, value]) => value).forEach(([label, value]) => info.append(el('dt', label), el('dd', value)));

    const summary = el('p', `參與 ${v.stats.tasks} 個任務・出席 ${v.stats.attended} 次・請假 ${v.stats.leave} 次・缺席 ${v.stats.absent} 次・共 ${v.stats.hours} 小時`, 'admin-summary');

    const wrap = el('div', null, 'member-table-wrap');
    const table = el('table', null, 'member-table');
    const head = el('tr');
    ['日期', '任務', '角色', '時數', '出席'].forEach((text) => head.append(el('th', text)));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    if (!v.history.length) {
      const row = el('tr');
      const cell = el('td', '還沒有參與紀錄。', 'empty');
      cell.colSpan = 5;
      row.append(cell);
      tbody.append(row);
    }
    v.history.forEach((h) => {
      const row = el('tr');
      [h.date.replaceAll('-', '/') || '—', h.task, h.role || '—', h.presence === '出席' ? String(h.hours) : '—', h.presence].forEach((text) => row.append(el('td', text)));
      tbody.append(row);
    });
    table.append(thead, tbody);
    wrap.append(table);

    detail.replaceChildren(heading, info, summary, wrap);
    dialog.showModal();
  };

  const renderVolunteers = () => {
    const tab = document.querySelector('[data-volunteer-tab].active').dataset.volunteerTab;
    const keywords = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = volunteers
      .filter((v) => tab === 'all' || isActiveVolunteer(v))
      .filter((v) => {
        const text = [v.nickname, v.name, v.skills, v.status, v.stats.roles.join(' '), v.history.map((h) => h.task).join(' ')].join(' ').toLowerCase();
        return keywords.every((keyword) => text.includes(keyword));
      })
      .map((v) => {
        const row = el('tr', null, 'admin-row');
        row.tabIndex = 0;
        [v.nickname || '—', v.name || '—', v.status, v.stats.tasks, v.stats.attended, `${v.stats.leave}／${v.stats.absent}`, v.stats.hours,
          v.stats.last ? v.stats.last.replaceAll('-', '/') : '—', v.stats.roles.join('、') || '—'].forEach((text) => row.append(el('td', String(text))));
        row.addEventListener('click', () => showVolunteer(v));
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') showVolunteer(v);
        });
        return row;
      });
    if (!rows.length) {
      const row = el('tr');
      const cell = el('td', volunteers.length ? '沒有符合條件的志工。' : '「志工資料」表還沒有資料。', 'empty');
      cell.colSpan = 9;
      row.append(cell);
      rows.push(row);
    }
    tableBody.replaceChildren(...rows);
  };

  const showError = (code) => {
    loginErrorEl.textContent = errorMessage(code);
    loginErrorEl.hidden = false;
  };

  const load = async (session) => {
    const data = API_URL ? await api({ action: 'adminOverview', token: session.token }) : DEMO_ADMIN;
    if (!data.ok) {
      if (data.error === 'unauthorized') localStorage.removeItem(SESSION_KEY);
      adminDashboard.hidden = true;
      loginSectionEl.hidden = false;
      return showError(data.error);
    }
    volunteers = data.volunteers.slice().sort((a, b) => b.stats.hours - a.stats.hours || b.stats.attended - a.stats.attended);
    document.getElementById('adminGreeting').textContent = `${session.member.name}（${session.member.id}）您好。` + (API_URL ? '' : '目前是示範資料。');
    const unmatched = document.getElementById('adminUnmatched');
    unmatched.hidden = !data.unmatched.length;
    unmatched.textContent = `「參與紀錄」裡有名字對不到志工資料，這些紀錄沒有算進統計：${data.unmatched.join('、')}`;
    renderStats(data);
    renderLists(data);
    renderVolunteers();
    loginSectionEl.hidden = true;
    loginErrorEl.hidden = true;
    adminDashboard.hidden = false;
  };

  loginFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = loginFormEl.querySelector('[type="submit"]');
    button.disabled = true;
    const result = await api({
      action: 'login',
      memberId: document.getElementById('adminMemberId').value,
      phone: document.getElementById('adminPhone').value,
    });
    button.disabled = false;
    if (!result.ok) return showError(result.error);
    const session = { token: result.token, member: result.member };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    loginFormEl.reset();
    load(session);
  });

  document.getElementById('adminLogoutBtn').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    adminDashboard.hidden = true;
    loginSectionEl.hidden = false;
  });

  document.querySelectorAll('[data-volunteer-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-volunteer-tab]').forEach((item) => item.classList.toggle('active', item === button));
      renderVolunteers();
    });
  });
  searchInput.addEventListener('input', renderVolunteers);
  dialog.querySelector('.admin-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  const existing = getSession();
  if (existing) load(existing);
}
