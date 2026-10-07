// 活動建檔（archive.html）。沿用 script.js 的 api、errorMessage、setBusy；用志工專區的登入憑證。
const arBoard = document.getElementById('arBoard');
if (arBoard) {
  const V_KEY = 'volunteerSession';
  const guest = document.getElementById('arGuest');
  const globalError = document.getElementById('arGlobalError');
  const listBox = document.getElementById('arTaskList');
  const editor = document.getElementById('arEditor');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const token = (() => {
    try { const v = JSON.parse(localStorage.getItem(V_KEY)); if (v && v.token) return v.token; } catch { /* 壞掉的 localStorage */ }
    try { const m = JSON.parse(localStorage.getItem('memberSession')); if (m && m.token) return m.token; } catch { /* 同上 */ }
    return '';
  })();
  const fail = (code) => { globalError.textContent = errorMessage(code); globalError.hidden = false; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const signOut = () => { guest.hidden = false; arBoard.hidden = true; };

  let current = null; // { task, view }

  // ── 活動清單 ──
  const renderTasks = (data) => {
    const box = document.getElementById('arTasks');
    document.getElementById('arListStatus').textContent = data.tasks.length ? '點一個活動開始填寫；你參與的排在前面。' : '目前沒有進行中或待建檔的任務。';
    box.replaceChildren(...data.tasks.map((t) => {
      const row = el('div', 'equip-row');
      const head = el('div', 'equip-head');
      head.append(el('strong', '', t.task));
      head.append(el('span', `task-state ${t.status === '已送交' ? 'state-ok' : t.status === '退回' ? 'state-no' : 'state-wait'}`, t.status || '未開始'));
      row.append(head);
      row.append(el('p', 'equip-meta', [t.type, t.lead && `召集人：${t.lead}`, t.start && `${t.start}～${t.end || ''}`, t.mine ? '我有參與' : ''].filter(Boolean).join('｜')));
      const actions = el('div', 'equip-actions');
      const btn = el('button', 'small-btn', t.status ? '繼續填寫／查看' : '開始建檔');
      btn.type = 'button';
      btn.addEventListener('click', () => openTask(t.task));
      actions.append(btn);
      row.append(actions);
      return row;
    }));
  };

  const loadList = async () => {
    const result = await api({ action: 'archiveList', token });
    if (!result.ok) return result.error === 'unauthorized' ? signOut() : fail(result.error);
    renderTasks(result);
  };

  // ── 編輯器 ──
  const setVal = (name, value) => { const input = editor.querySelector(`[data-f="${name}"]`); if (input) input.value = value == null ? '' : value; };
  const fillSelect = (select, options, value) => { select.replaceChildren(...options.map((o) => new Option(o, o))); if (value && options.indexOf(value) === -1) select.append(new Option(value, value)); select.value = value || options[0]; };

  const renderStaff = (staff, view) => {
    const rows = document.getElementById('arStaffRows');
    rows.replaceChildren();
    const names = document.getElementById('arVolunteerNames');
    names.replaceChildren(...view.volunteers.map((n) => new Option(n)));
    const add = (p) => {
      const row = el('div', 'item-row ar-staff-row');
      const name = el('input'); name.type = 'text'; name.value = p.name || ''; name.setAttribute('list', 'arVolunteerNames'); name.placeholder = '志工本名'; name.dataset.s = 'name';
      const role = el('span', 'ar-roles');
      view.roles.forEach((r) => { const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.value = r; cb.checked = (p.role || '').indexOf(r) !== -1; lab.append(cb, document.createTextNode(r)); role.append(lab); });
      const note = el('input'); note.type = 'text'; note.value = p.note || ''; note.placeholder = '備註'; note.dataset.s = 'note';
      const remove = el('button', 'item-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '移除'); remove.addEventListener('click', () => row.remove());
      row.append(name, role, note, remove);
      rows.append(row);
    };
    staff.forEach(add);
    document.getElementById('arAddStaff').onclick = () => add({ name: '', role: '服', note: '' });
  };
  const gatherStaff = () => Array.from(document.querySelectorAll('.ar-staff-row')).map((row) => ({
    name: row.querySelector('[data-s="name"]').value.trim(),
    role: Array.from(row.querySelectorAll('.ar-roles input:checked')).map((c) => c.value).join('') || '服',
    note: row.querySelector('[data-s="note"]').value.trim(),
  })).filter((p) => p.name);

  const fillTable = (tbodyId, rows, cols, emptyText) => {
    const body = document.getElementById(tbodyId);
    body.replaceChildren(...(rows.length ? rows.map((r) => { const tr = el('tr'); cols.forEach((c) => tr.append(el('td', '', String(r[c] == null ? '' : r[c])))); return tr; })
      : [(() => { const tr = el('tr'); const td = el('td', 'empty', emptyText); td.colSpan = cols.length; tr.append(td); return tr; })()]));
  };

  // 照片牆：縮圖分批抓；勾精選即存
  const renderPhotos = (view) => {
    const box = document.getElementById('arPhotos');
    const featured = (view.data['精選照片'] || '').split(',').filter(Boolean);
    document.getElementById('arMaxFeatured').textContent = view.maxFeatured;
    box.replaceChildren(...view.files.photos.map((f) => {
      const card = el('figure', 'ar-photo');
      const img = el('img'); img.alt = f.name; img.dataset.id = f.id; img.loading = 'lazy';
      const cap = el('figcaption');
      const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = featured.indexOf(f.id) !== -1; cb.disabled = !view.editable;
      cb.addEventListener('change', async () => {
        const ids = Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map((c) => c.closest('figure').querySelector('img').dataset.id);
        if (ids.length > view.maxFeatured) { cb.checked = false; return fail('archive_too_many_featured'); }
        const result = await api({ action: 'archiveSave', token, task: current.task, section: 'files', fields: { 精選照片: ids } });
        if (!result.ok) fail(result.error); else current.view = result;
      });
      lab.append(cb, document.createTextNode(' 精選'));
      cap.append(el('small', '', f.name), lab);
      if (view.editable) { const del = el('button', 'item-remove', '×'); del.type = 'button'; del.title = '刪除這張'; del.addEventListener('click', () => deleteFile(f.id)); cap.append(del); }
      card.append(img, cap);
      return card;
    }));
    const ids = view.files.photos.map((f) => f.id);
    const next = async () => {
      const batch = ids.splice(0, 6);
      if (!batch.length) return;
      const result = await api({ action: 'archiveThumbs', token, ids: batch });
      if (result.ok) batch.forEach((id) => { const img = box.querySelector(`img[data-id="${id}"]`); if (img && result.thumbs[id]) img.src = result.thumbs[id]; });
      next();
    };
    next();
  };

  const renderFiles = (view) => {
    const list = document.getElementById('arFiles');
    list.replaceChildren(...(view.files.attachments.length ? view.files.attachments.map((f) => {
      const li = el('li');
      const a = el('a', 'text-link-inline', f.name); a.href = f.url; a.target = '_blank'; a.rel = 'noopener';
      li.append(a, el('small', '', ` ${Math.round(f.size / 1024)} KB・${f.created}`));
      if (view.editable) { const del = el('button', 'item-remove', '×'); del.type = 'button'; del.addEventListener('click', () => deleteFile(f.id)); li.append(del); }
      return li;
    }) : [el('li', 'admin-empty', '還沒有附件。')]));
    const link = document.getElementById('arFolderLink');
    link.href = view.files.folder || '#';
    link.hidden = !view.files.folder;
  };

  const render = (view) => {
    current.view = view;
    const d = view.data;
    document.getElementById('arTitle').textContent = d['活動名稱'] || current.task;
    document.getElementById('arMeta').textContent = [`任務：${d['任務名稱']}`, `建檔編號 ${view.id}`, d['最後編輯者'] && `最後編輯：${d['最後編輯者']} ${d['最後編輯時間'].slice(0, 10)}`].filter(Boolean).join('｜');
    const status = document.getElementById('arStatus');
    status.textContent = view.status;
    status.className = `task-state ${view.status === '已送交' || view.status === '已結案' ? 'state-ok' : view.status === '退回' ? 'state-no' : 'state-wait'}`;
    const returned = document.getElementById('arReturned');
    returned.hidden = view.status !== '退回';
    returned.textContent = `秘書處退回：${d['退回原因'] || '（未填原因）'}。修改後請再送交。`;
    document.getElementById('arLocked').hidden = view.editable;

    Object.keys(d).forEach((k) => setVal(k, d[k]));
    fillSelect(document.querySelector('[data-f="類型"]'), view.types, d['類型']);
    renderStaff(view.staff, view);
    fillTable('arWork', view.work, ['title', 'owner', 'due', 'status'], '「工作進度」表沒有這個任務的工作。');
    fillTable('arExpenses', view.expenses, ['date', 'item', 'amount'], '「日記帳」沒有這個任務的支出。');
    fillTable('arEquipment', view.equipment, ['item', 'provider'], '「器材借用單」沒有這個任務的借用。');
    fillSelect(document.getElementById('arFileKind'), view.attachmentKinds, view.attachmentKinds[0]);
    renderPhotos(view);
    renderFiles(view);
    if (view.files.error) fail(view.files.error);

    editor.querySelectorAll('input, textarea, select, button.btn, #arAddStaff, .item-remove').forEach((n) => { if (!/^ar(Back|Submit)$/.test(n.id)) n.disabled = !view.editable; });
    document.getElementById('arPhotoInput').disabled = !view.editable;
    document.getElementById('arFileInput').disabled = !view.editable;
    const submitBox = document.getElementById('arSubmitBox');
    submitBox.hidden = !view.editable;
    document.getElementById('arSubmit').hidden = !view.canSubmit;
    document.getElementById('arSubmitHint').hidden = view.canSubmit;
  };

  const openTask = async (task) => {
    globalError.hidden = true;
    current = { task, view: null };
    listBox.hidden = true;
    editor.hidden = false;
    document.getElementById('arTitle').textContent = '載入中…';
    const result = await api({ action: 'archiveGet', token, task });
    if (!result.ok) { editor.hidden = true; listBox.hidden = false; return result.error === 'unauthorized' ? signOut() : fail(result.error); }
    render(result);
    window.scrollTo({ top: Math.max(0, editor.getBoundingClientRect().top + window.scrollY - 90), behavior: 'smooth' });
  };

  document.getElementById('arBack').addEventListener('click', () => { editor.hidden = true; listBox.hidden = false; loadList(); });

  document.querySelectorAll('[data-ar-tab]').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('[data-ar-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('[data-ar-section]').forEach((s) => (s.hidden = s.dataset.arSection !== tab.dataset.arTab));
  }));

  // 每段一個儲存鍵
  document.querySelectorAll('form[data-ar-section]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const section = form.dataset.arSection;
    const saved = form.querySelector('.ar-saved');
    saved.textContent = '';
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    let result;
    if (section === 'staff') result = await api({ action: 'archiveStaffSave', token, task: current.task, staff: gatherStaff() });
    else {
      const fields = {};
      form.querySelectorAll('[data-f]').forEach((input) => (fields[input.dataset.f] = input.value));
      if (section === 'files') delete fields['精選照片'];
      result = await api({ action: 'archiveSave', token, task: current.task, section, fields });
    }
    setBusy(button, false);
    if (!result.ok) return result.error === 'unauthorized' ? signOut() : fail(result.error);
    render(result);
    saved.textContent = '已儲存 ✓';
    setTimeout(() => (saved.textContent = ''), 3000);
  }));

  // ── 上傳：照片在瀏覽器端縮到長邊 2000、JPEG 85%；附件原樣 base64 ──
  const shrinkPhoto = (file) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
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
  const readAsDataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('invalid_upload')); r.readAsDataURL(file); });

  const uploadMany = async (files, kind, progressId) => {
    const progress = document.getElementById(progressId);
    let done = 0;
    for (const file of files) {
      progress.textContent = `上傳中 ${done + 1}/${files.length}：${file.name}`;
      try {
        const dataUrl = kind === 'photo' ? await shrinkPhoto(file) : await readAsDataUrl(file);
        if (dataUrl.length > 8 * 1024 * 1024 * 1.37) throw new Error('upload_too_large');
        const result = await api({ action: 'archiveUpload', token, task: current.task, kind, category: document.getElementById('arFileKind').value, name: file.name, dataUrl });
        if (!result.ok) throw new Error(result.error);
        done++;
      } catch (err) {
        progress.textContent = `「${file.name}」失敗：${errorMessage(err.message)}`;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    progress.textContent = done ? `已上傳 ${done} 個檔案。` : '';
    const result = await api({ action: 'archiveGet', token, task: current.task });
    if (result.ok) render(result);
  };
  document.getElementById('arPhotoInput').addEventListener('change', (e) => { const files = Array.from(e.target.files); e.target.value = ''; if (files.length) uploadMany(files, 'photo', 'arPhotoProgress'); });
  document.getElementById('arFileInput').addEventListener('change', (e) => { const files = Array.from(e.target.files); e.target.value = ''; if (files.length) uploadMany(files, 'file', 'arFileProgress'); });

  async function deleteFile(id) {
    const result = await api({ action: 'archiveDeleteFile', token, task: current.task, id });
    if (!result.ok) return fail(result.error);
    const view = await api({ action: 'archiveGet', token, task: current.task });
    if (view.ok) render(view);
  }

  document.getElementById('arSubmit').addEventListener('click', async () => {
    const error = document.getElementById('arSubmitError');
    error.hidden = true;
    const button = document.getElementById('arSubmit');
    setBusy(button, true);
    const result = await api({ action: 'archiveSubmit', token, task: current.task });
    setBusy(button, false);
    if (!result.ok) { error.textContent = errorMessage(result.error); error.hidden = false; return; }
    render(result);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  if (!token) signOut();
  else { guest.hidden = true; arBoard.hidden = false; loadList(); }
}
