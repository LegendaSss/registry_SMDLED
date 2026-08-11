'use strict';

/* ================================================================
   СМДЛЕД — Полный Реестр Проектов v4 (Server-Side Backend)
   HTTP Fetch API + JWT Auth
   ================================================================ */

(function () {
  
  // ─── Константы ───
  const API_URL = '/api'; // Относительный путь для работы через Nginx на VPS
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 МБ
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут

  // ─── Состояние ───
  let currentUser = null;
  let authToken = null;
  let users = [];
  let projects = [];
  let sortState = { col: null, dir: 'asc' };
  let pagination = { page: 1, perPage: 25 };
  let searchDebounceTimer = null;
  let sessionTimer = null;
  let sessionWarningTimer = null;
  let tempContractFile = null;
  let tempSignedContractFile = null;

  // ════════════════════════════════════════════════════════════════
  //  HTTP КЛИЕНТ (API)
  // ════════════════════════════════════════════════════════════════

  async function apiRequest(endpoint, options = {}) {
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    
    // Если это не FormData (файлы), ставим Content-Type JSON
    if (!(options.body instanceof FormData) && options.body) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    try {
      const res = await fetch(`${API_URL}${endpoint}`, { ...options, headers: { ...headers, ...options.headers } });
      const data = await res.json().catch(() => ({}));
      
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          clearSession(); showAuthPage();
          showToast(data.error || 'Сессия истекла. Войдите снова.', 'error');
        }
        throw new Error(data.error || 'Ошибка сервера');
      }
      return data;
    } catch (err) {
      console.error('API Error:', err);
      throw err;
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  СЕССИЯ И ДАННЫЕ
  // ════════════════════════════════════════════════════════════════

  function saveSession(user, token) {
    sessionStorage.setItem('smdled_session', JSON.stringify({ user, token, ts: Date.now() }));
  }
  
  function clearSession() {
    sessionStorage.removeItem('smdled_session');
    currentUser = null;
    authToken = null;
  }
  
  function loadSession() {
    try {
      const d = JSON.parse(sessionStorage.getItem('smdled_session'));
      if (d && (Date.now() - d.ts) < SESSION_TIMEOUT_MS) {
        currentUser = d.user;
        authToken = d.token;
        return true;
      }
    } catch (e) { }
    return false;
  }

  async function loadUsers() {
    if (currentUser && currentUser.role === 'director') {
      try { users = await apiRequest('/auth/users'); } catch (e) { showToast(e.message, 'error'); }
    }
  }

  async function loadProjects() {
    try { 
      projects = await apiRequest('/projects'); 
      renderProjects();
      updateStats();
    } catch (e) { showToast('Не удалось загрузить проекты', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════
  //  УТИЛИТЫ
  // ════════════════════════════════════════════════════════════════

  function formatCurrency(n) {
    if (n == null || isNaN(n)) return '—';
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
  }
  function formatPercent(n) {
    if (n == null || isNaN(n)) return '—';
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + '%';
  }
  function formatDate(d) {
    if (!d) return '—';
    const p = d.split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
  }
  function formatFileSize(b) {
    if (b < 1024) return b + ' Б';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' КБ';
    return (b / 1048576).toFixed(1) + ' МБ';
  }
  function getFileIcon(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    return { pdf: '📕', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', jpg: '🖼️', jpeg: '🖼️', png: '🖼️' }[ext] || '📄';
  }
  function todayStr() { return new Date().toISOString().split('T')[0]; }
  function $(s) { return document.querySelector(s); }
  function $$(s) { return document.querySelectorAll(s); }
  function esc(s) { if (!s) return '—'; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
  
  function renderLink(url) { return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="link-icon" title="${esc(url)}">🔗</a>` : '—'; }
  function renderFileOrLink(fileName, link) {
    if (fileName) {
      return `<button type="button" class="file-badge" data-action="download" data-file="${esc(fileName)}" title="${esc(fileName)}">${getFileIcon(fileName)} Файл</button>`;
    }
    return link ? renderLink(link) : '—';
  }
  
  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = filename;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function showToast(msg, type = 'info') {
    const c = $('#toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${{ success: '✅', error: '❌', info: 'ℹ️' }[type] || 'ℹ️'}</span><span class="toast-message">${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('exiting'); setTimeout(() => t.remove(), 300); }, 3500);
  }

  // ════════════════════════════════════════════════════════════════
  //  СЕССИЯ
  // ════════════════════════════════════════════════════════════════

  function resetSessionTimer() {
    clearTimeout(sessionTimer);
    clearTimeout(sessionWarningTimer);
    sessionWarningTimer = setTimeout(() => {
      const w = document.createElement('div');
      w.className = 'session-warning'; w.id = 'session-warn';
      w.textContent = '⏰ Сессия истечёт через 2 минуты. Любое действие продлит сессию.';
      if (!$('#session-warn')) document.body.appendChild(w);
    }, SESSION_TIMEOUT_MS - 120000);
    
    sessionTimer = setTimeout(() => {
      clearSession(); showAuthPage();
      showToast('Сессия истекла. Войдите заново.', 'info');
    }, SESSION_TIMEOUT_MS);
    
    if (currentUser && authToken) saveSession(currentUser, authToken);
    const warn = $('#session-warn'); if (warn) warn.remove();
  }

  function initSessionTracker() {
    ['click', 'keydown', 'mousemove', 'scroll'].forEach(evt => {
      document.addEventListener(evt, () => { if (currentUser) resetSessionTimer(); }, { passive: true });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  АВТОРИЗАЦИЯ
  // ════════════════════════════════════════════════════════════════

  function initAuth() {
    $$('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        $('#login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
        $('#register-form').classList.toggle('hidden', tab.dataset.tab !== 'register');
      });
    });
    $('#btn-login').addEventListener('click', handleLogin);
    $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
    $('#btn-register').addEventListener('click', handleRegister);
    $('#register-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(); });
    $('#btn-logout').addEventListener('click', () => {
      clearTimeout(sessionTimer); clearTimeout(sessionWarningTimer);
      clearSession(); showAuthPage();
      showToast('Вы вышли из системы', 'info');
    });
  }

  async function handleLogin() {
    const email = $('#login-email').value.trim().toLowerCase();
    const password = $('#login-password').value;
    if (!email || !password) { showToast('Введите email и пароль', 'error'); return; }
    if (!isValidEmail(email)) { showToast('Введите корректный email', 'error'); return; }
    
    try {
      const res = await apiRequest('/auth/login', { method: 'POST', body: { email, password } });
      currentUser = res.user;
      authToken = res.token;
      saveSession(currentUser, authToken); 
      resetSessionTimer();
      showAppPage();
      showToast(`Добро пожаловать, ${currentUser.name}!`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function handleRegister() {
    const name = $('#register-name').value.trim();
    const email = $('#register-email').value.trim().toLowerCase();
    const password = $('#register-password').value;
    if (!name || !email || !password) { showToast('Заполните все поля', 'error'); return; }
    if (!isValidEmail(email)) { showToast('Введите корректный email', 'error'); return; }
    if (password.length < 6) { showToast('Пароль минимум 6 символов', 'error'); return; }
    
    try {
      const res = await apiRequest('/auth/register', { method: 'POST', body: { name, email, password } });
      if (res.requireVerification) {
        showToast(res.message, 'success');
        $('#register-form').reset();
        switchAuthTab('login');
      } else {
        currentUser = res.user;
        authToken = res.token;
        saveSession(currentUser, authToken); 
        resetSessionTimer();
        showAppPage();
        showToast('Регистрация успешна!', 'success');
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  function showAuthPage() {
    $('#auth-page').classList.remove('hidden'); $('#app-page').classList.add('hidden');
    ['#login-email', '#login-password', '#register-name', '#register-email', '#register-password'].forEach(s => $(s).value = '');
  }

  async function showAppPage() {
    $('#auth-page').classList.add('hidden'); $('#app-page').classList.remove('hidden');
    applyPermissions(); updateUserDisplay();
    await loadProjects();
  }

  // ════════════════════════════════════════════════════════════════
  //  RBAC
  // ════════════════════════════════════════════════════════════════

  function applyPermissions() {
    if (!currentUser) return;
    const isDir = currentUser.role === 'director';
    const canView = currentUser.canViewFinances || isDir;
    const canEdit = currentUser.canEdit || isDir;
    $$('.financial-cell').forEach(el => el.classList.toggle('hidden', !canView));
    $$('.financial-field').forEach(el => el.classList.toggle('hidden', !canView));
    $('#btn-add-project').classList.toggle('hidden', !canEdit);
    $('#btn-manage-users').classList.toggle('hidden', !isDir);
    $('#btn-generate-test').style.display = isDir ? '' : 'none'; // Временная фича скрыта для сервера
    $$('.actions-cell').forEach(el => el.classList.toggle('hidden', !canEdit));
  }

  function updateUserDisplay() {
    if (!currentUser) return;
    $('#user-display-name').textContent = currentUser.name;
    $('#user-avatar').textContent = currentUser.name.split(' ').map(s => s[0]).join('').substring(0, 2).toUpperCase();
    const badge = $('#user-role-badge');
    const labels = { director: 'Директор', manager: 'Менеджер', viewer: 'Наблюдатель' };
    badge.textContent = labels[currentUser.role] || currentUser.role;
    badge.className = `role-badge ${currentUser.role}`;
  }

  // ════════════════════════════════════════════════════════════════
  //  ПАГИНАЦИЯ И ТАБЛИЦА
  // ════════════════════════════════════════════════════════════════

  function initPagination() {
    $('#per-page-select').addEventListener('change', e => {
      pagination.perPage = parseInt(e.target.value);
      pagination.page = 1;
      loadProjects();
    });
  }

  function renderPagination(totalItems) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pagination.perPage));
    if (pagination.page > totalPages) pagination.page = totalPages;
    const start = (pagination.page - 1) * pagination.perPage + 1;
    const end = Math.min(pagination.page * pagination.perPage, totalItems);

    $('#pagination-info').innerHTML = totalItems > 0
      ? `Показано <strong>${start}–${end}</strong> из <strong>${totalItems}</strong> проектов`
      : 'Нет проектов';

    const controls = $('#pagination-controls');
    if (totalPages <= 1) { controls.innerHTML = ''; return; }

    let html = `<button class="page-btn" data-page="1" ${pagination.page === 1 ? 'disabled' : ''}>«</button>
                <button class="page-btn" data-page="${pagination.page - 1}" ${pagination.page === 1 ? 'disabled' : ''}>‹</button>`;

    getPageNumbers(pagination.page, totalPages).forEach(p => {
      if (p === '...') html += `<span class="page-btn ellipsis">…</span>`;
      else html += `<button class="page-btn ${p === pagination.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    });

    html += `<button class="page-btn" data-page="${pagination.page + 1}" ${pagination.page === totalPages ? 'disabled' : ''}>›</button>
             <button class="page-btn" data-page="${totalPages}" ${pagination.page === totalPages ? 'disabled' : ''}>»</button>`;
    controls.innerHTML = html;

    controls.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1 && p <= totalPages && p !== pagination.page) { pagination.page = p; loadProjects(); }
      });
    });
  }

  function getPageNumbers(current, total) {
    const pages = [];
    if (total <= 7) { for (let i = 1; i <= total; i++) pages.push(i); } 
    else {
      pages.push(1); if (current > 3) pages.push('...');
      for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
      if (current < total - 2) pages.push('...'); pages.push(total);
    }
    return pages;
  }

  function renderProjects() {
    const tbody = $('#projects-tbody');
    const pageItems = projects;
    const totalItems = totalProjectsCount;
    const startIdx = (pagination.page - 1) * pagination.perPage;

    renderPagination(totalItems);

    const isDir = currentUser && currentUser.role === 'director';
    const canView = currentUser && (currentUser.canViewFinances || isDir);
    const canEdit = currentUser && (currentUser.canEdit || isDir);

    if (pageItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="24" style="padding:0;border:none;"><div class="empty-state"><div class="empty-icon">📂</div><p>Проекты не найдены</p></div></td></tr>`;
      return;
    }

    let html = '';
    pageItems.forEach((p, i) => {
      const dc = p.marginDiff > 0 ? 'positive' : p.marginDiff < 0 ? 'negative' : '';
      html += `<tr>
        <td class="row-number">${startIdx + i + 1}</td>
        <td>${esc(p.mop)}</td><td>${esc(p.rp)}</td>
        <td title="${esc(p.name)}">${esc(p.name)}</td>
        <td>${renderLink(p.bitrixLink)}</td>
        <td><span class="status-badge" data-status="${esc(p.paymentStatus)}">${esc(p.paymentStatus) || '—'}</span></td>
        <td><span class="status-badge" data-status="${esc(p.projectStatus)}">${esc(p.projectStatus) || '—'}</span></td>
        <td>${formatDate(p.signDate)}</td><td>${formatDate(p.deadline)}</td><td>${formatDate(p.transferDate)}</td>
        <td>${renderFileOrLink(p.contractFileName, p.contractLink)}</td>
        <td>${renderFileOrLink(p.signedContractFileName, p.signedContractLink)}</td>
        <td>${esc(p.clientContact)}</td><td>${esc(p.clientName)}</td>
        <td class="financial-cell currency${canView ? '' : ' hidden'}">${formatCurrency(p.revenue)}</td>
        <td class="financial-cell currency${canView ? '' : ' hidden'}">${formatCurrency(p.plannedMarginRub)}</td>
        <td class="financial-cell percentage${canView ? '' : ' hidden'}">${formatPercent(p.plannedMarginPct)}</td>
        <td class="financial-cell${canView ? '' : ' hidden'}">${renderLink(p.calcLink)}</td>
        <td>${renderLink(p.updLink)}</td><td>${formatDate(p.closeDate)}</td>
        <td class="financial-cell currency${canView ? '' : ' hidden'}">${formatCurrency(p.actualMarginRub)}</td>
        <td class="financial-cell percentage${canView ? '' : ' hidden'}">${formatPercent(p.actualMarginPct)}</td>
        <td class="financial-cell currency ${dc}${canView ? '' : ' hidden'}">${formatCurrency(p.marginDiff)}</td>
        <td class="actions-cell${canEdit ? '' : ' hidden'}">
          <button class="btn-icon edit" data-action="edit" data-id="${p.id}" title="Редактировать">✏️</button>
          ${isDir ? `<button class="btn-icon audit" data-action="audit" data-id="${p.id}" title="История изменений">🕒</button>` : ''}
          ${isDir ? `<button class="btn-icon delete" data-action="delete" data-id="${p.id}" title="Удалить">🗑️</button>` : ''}
        </td>
      </tr>`;
    });
    tbody.innerHTML = html;
  }

  function updateStats() {
    $('#stat-total').textContent = projects.length;
    $('#stat-revenue').textContent = formatCurrency(projects.reduce((s, p) => s + (parseFloat(p.revenue) || 0), 0));
    const m = projects.filter(p => p.plannedMarginPct > 0);
    $('#stat-avg-margin').textContent = formatPercent(m.length ? m.reduce((s, p) => s + (parseFloat(p.plannedMarginPct) || 0), 0) / m.length : 0);
    $('#stat-active').textContent = projects.filter(p => p.projectStatus === 'В работе' || p.projectStatus === 'подписан/передан на реализацию').length;
  }

  // ════════════════════════════════════════════════════════════════
  //  CRUD ПРОЕКТЫ (Загрузка через FormData)
  // ════════════════════════════════════════════════════════════════

  function initFileUploads() {
    ['contract', 'signed-contract'].forEach(fk => {
      const input = document.getElementById(`${fk}-file-input`);
      const area = document.getElementById(`${fk}-upload-area`);
      const preview = document.getElementById(`${fk}-file-preview`);
      
      area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
      area.addEventListener('dragleave', () => area.classList.remove('dragover'));
      area.addEventListener('drop', e => { e.preventDefault(); area.classList.remove('dragover'); if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0], preview, fk); });
      input.addEventListener('change', () => { if (input.files.length) handleFileSelect(input.files[0], preview, fk); });
    });
  }

  function handleFileSelect(file, previewEl, fk) {
    if (file.size > MAX_FILE_SIZE) { showToast('Файл слишком большой', 'error'); return; }
    if (fk === 'contract') tempContractFile = file; else tempSignedContractFile = file;
    previewEl.innerHTML = `<div class="file-preview"><span class="file-icon">📄</span><span class="file-name">${file.name}</span><button type="button" class="remove-file">✕</button></div>`;
    previewEl.querySelector('.remove-file').addEventListener('click', () => {
      if (fk === 'contract') tempContractFile = null; else tempSignedContractFile = null;
      previewEl.innerHTML = '';
    });
  }

  function initProjectModal() {
    $('#btn-add-project').addEventListener('click', () => openProjectModal());
    $('#modal-close-project').addEventListener('click', closeProjectModal);
    $('#modal-close-audit').addEventListener('click', () => $('#audit-modal').classList.add('hidden'));
    $('#modal-cancel-project').addEventListener('click', closeProjectModal);
    $('#modal-save-project').addEventListener('click', handleSaveProject);
    $('#field-revenue').addEventListener('input', autoCalcMargins);
    $('#field-planned-margin-rub').addEventListener('input', autoCalcMargins);
    $('#field-actual-margin-rub').addEventListener('input', autoCalcMargins);
    
    $('#projects-tbody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'edit') { const p = projects.find(x => x.id === id); if (p) openProjectModal(p); }
      else if (btn.dataset.action === 'delete') {
        showConfirm('Удалить этот проект?', async () => {
          try {
            await apiRequest(`/projects/${id}`, { method: 'DELETE' });
            showToast('Проект удалён', 'success');
            await loadProjects();
          } catch(e) { showToast(e.message, 'error'); }
        });
      } else if (btn.dataset.action === 'download') {
        const fileName = btn.dataset.file;
        if (!fileName) return;
        btn.style.opacity = '0.5';
        apiRequest(`/projects/generate-download/${encodeURIComponent(fileName)}`)
          .then(data => {
            window.open(data.url, '_blank');
          })
          .catch(e => showToast('Ошибка доступа: ' + e.message, 'error'))
          .finally(() => btn.style.opacity = '1');
      } else if (btn.dataset.action === 'audit') {
        openAuditModal(btn.dataset.id);
      }
    });
  }

  async function openAuditModal(id) {
    try {
      const logs = await apiRequest(`/projects/${id}/audit`);
      const container = $('#audit-logs-container');
      if (logs.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#888;">История пуста</p>';
      } else {
        container.innerHTML = logs.map(l => `
          <div style="border-left: 3px solid #3b82f6; padding-left: 10px; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid #333;">
            <div style="font-size: 0.8rem; color: #888;">${new Date(l.timestamp).toLocaleString()} - <strong style="color:white;">${esc(l.userEmail)}</strong></div>
            <div style="font-weight: bold; margin: 4px 0; color: #10b981;">${esc(l.action)}</div>
            <div style="font-size: 0.9rem; color: #ccc;">${esc(l.details || '')}</div>
          </div>
        `).join('');
      }
      $('#audit-modal').classList.remove('hidden');
    } catch(e) { showToast(e.message, 'error'); }
  }

  function openProjectModal(p = null) {
    $('#project-form').reset();
    tempContractFile = null; tempSignedContractFile = null;
    $('#contract-file-preview').innerHTML = ''; $('#signed-contract-file-preview').innerHTML = '';
    applyPermissions();
    if (p) {
      $('#modal-title').textContent = 'Редактировать проект'; $('#project-id').value = p.id;
      const fields = { 'field-mop': p.mop, 'field-rp': p.rp, 'field-name': p.name, 'field-bitrix': p.bitrixLink, 'field-payment-status': p.paymentStatus, 'field-project-status': p.projectStatus, 'field-sign-date': p.signDate, 'field-deadline': p.deadline, 'field-transfer-date': p.transferDate, 'field-contract-link': p.contractLink, 'field-signed-contract-link': p.signedContractLink, 'field-client-contact': p.clientContact, 'field-client-name': p.clientName, 'field-revenue': p.revenue, 'field-planned-margin-rub': p.plannedMarginRub, 'field-planned-margin-pct': p.plannedMarginPct, 'field-calc-link': p.calcLink, 'field-upd-link': p.updLink, 'field-close-date': p.closeDate, 'field-actual-margin-rub': p.actualMarginRub, 'field-actual-margin-pct': p.actualMarginPct, 'field-margin-diff': p.marginDiff };
      Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val || ''; });
      
      if (p.contractFileName) $('#contract-file-preview').innerHTML = `<div class="file-preview"><span class="file-name">${p.contractFileName} (уже загружен)</span></div>`;
      if (p.signedContractFileName) $('#signed-contract-file-preview').innerHTML = `<div class="file-preview"><span class="file-name">${p.signedContractFileName} (уже загружен)</span></div>`;
    } else {
      $('#modal-title').textContent = 'Добавить проект'; $('#project-id').value = '';
    }
    $('#project-modal').classList.remove('hidden');
  }

  function closeProjectModal() { $('#project-modal').classList.add('hidden'); }

  async function handleSaveProject() {
    const name = $('#field-name').value.trim();
    if (!name) { showToast('Укажите наименование', 'error'); return; }
    const id = $('#project-id').value;
    
    // Используем FormData для отправки файлов и текста вместе
    const formData = new FormData();
    formData.append('mop', $('#field-mop').value.trim());
    formData.append('rp', $('#field-rp').value.trim());
    formData.append('name', name);
    formData.append('bitrixLink', $('#field-bitrix').value.trim());
    formData.append('paymentStatus', $('#field-payment-status').value);
    formData.append('projectStatus', $('#field-project-status').value);
    formData.append('signDate', $('#field-sign-date').value);
    formData.append('deadline', $('#field-deadline').value);
    formData.append('transferDate', $('#field-transfer-date').value);
    formData.append('contractLink', $('#field-contract-link').value.trim());
    formData.append('signedContractLink', $('#field-signed-contract-link').value.trim());
    formData.append('clientContact', $('#field-client-contact').value.trim());
    formData.append('clientName', $('#field-client-name').value.trim());
    formData.append('revenue', $('#field-revenue').value || 0);
    formData.append('plannedMarginRub', $('#field-planned-margin-rub').value || 0);
    formData.append('plannedMarginPct', $('#field-planned-margin-pct').value || 0);
    formData.append('calcLink', $('#field-calc-link').value.trim());
    formData.append('updLink', $('#field-upd-link').value.trim());
    formData.append('closeDate', $('#field-close-date').value);
    formData.append('actualMarginRub', $('#field-actual-margin-rub').value || 0);
    formData.append('actualMarginPct', $('#field-actual-margin-pct').value || 0);
    formData.append('marginDiff', $('#field-margin-diff').value || 0);

    if (tempContractFile) formData.append('contractFile', tempContractFile);
    if (tempSignedContractFile) formData.append('signedContractFile', tempSignedContractFile);

    try {
      if (id) {
        await apiRequest(`/projects/${id}`, { method: 'PUT', body: formData });
        showToast('Проект обновлен', 'success');
      } else {
        await apiRequest(`/projects`, { method: 'POST', body: formData });
        showToast('Проект добавлен', 'success');
      }
      closeProjectModal();
      await loadProjects();
    } catch (e) { showToast(e.message, 'error'); }
  }

  function autoCalcMargins() {
    const r = parseFloat($('#field-revenue').value) || 0;
    const p = parseFloat($('#field-planned-margin-rub').value) || 0;
    const a = parseFloat($('#field-actual-margin-rub').value) || 0;
    $('#field-planned-margin-pct').value = r > 0 ? ((p / r) * 100).toFixed(2) : '';
    $('#field-actual-margin-pct').value = r > 0 ? ((a / r) * 100).toFixed(2) : '';
    $('#field-margin-diff').value = (a - p).toFixed(2);
  }

  // ════════════════════════════════════════════════════════════════
  //  УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
  // ════════════════════════════════════════════════════════════════

  function initUsersModal() {
    $('#btn-manage-users').addEventListener('click', async () => { await loadUsers(); renderUsersTable(); $('#users-modal').classList.remove('hidden'); });
    $('#modal-close-users').addEventListener('click', () => $('#users-modal').classList.add('hidden'));
  }

  function renderUsersTable() {
    const tbody = $('#users-tbody');
    const others = users.filter(u => u.email !== currentUser.email);
    if (!others.length) { tbody.innerHTML = ''; $('#no-users-msg').classList.remove('hidden'); return; }
    $('#no-users-msg').classList.add('hidden');
    
    tbody.innerHTML = others.map(u => `<tr>
      <td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td>
      <td><select class="form-select urole" data-uid="${u.id}">
        <option value="viewer"${u.role === 'viewer' ? ' selected' : ''}>Наблюдатель</option>
        <option value="manager"${u.role === 'manager' ? ' selected' : ''}>Менеджер</option>
        <option value="director"${u.role === 'director' ? ' selected' : ''}>Директор</option>
      </select></td>
      <td style="text-align:center"><input type="checkbox" class="toggle-checkbox ufin" data-uid="${u.id}" ${u.canViewFinances ? 'checked' : ''}></td>
      <td style="text-align:center"><input type="checkbox" class="toggle-checkbox uedit" data-uid="${u.id}" ${u.canEdit ? 'checked' : ''}></td>
      <td><button class="btn-icon delete udel" data-uid="${u.id}">🗑️</button></td>
    </tr>`).join('');

    tbody.querySelectorAll('.urole').forEach(s => s.addEventListener('change', async e => {
      const uid = e.target.dataset.uid; const u = users.find(x => x.id === uid);
      if (u) {
        try {
          await apiRequest(`/auth/users/${uid}`, { method: 'PUT', body: { role: e.target.value, canViewFinances: u.canViewFinances, canEdit: u.canEdit }});
          showToast('Роль изменена', 'success'); await loadUsers(); renderUsersTable();
        } catch(err) { showToast(err.message, 'error'); }
      }
    }));
    tbody.querySelectorAll('.ufin').forEach(cb => cb.addEventListener('change', async e => {
      const uid = e.target.dataset.uid; const u = users.find(x => x.id === uid);
      if (u) {
        try {
          await apiRequest(`/auth/users/${uid}`, { method: 'PUT', body: { role: u.role, canViewFinances: e.target.checked, canEdit: u.canEdit }});
          showToast('Доступ изменен', 'success'); await loadUsers();
        } catch(err) { showToast(err.message, 'error'); }
      }
    }));
    tbody.querySelectorAll('.uedit').forEach(cb => cb.addEventListener('change', async e => {
      const uid = e.target.dataset.uid; const u = users.find(x => x.id === uid);
      if (u) {
        try {
          await apiRequest(`/auth/users/${uid}`, { method: 'PUT', body: { role: u.role, canViewFinances: u.canViewFinances, canEdit: e.target.checked }});
          showToast('Доступ изменен', 'success'); await loadUsers();
        } catch(err) { showToast(err.message, 'error'); }
      }
    }));
    tbody.querySelectorAll('.udel').forEach(btn => btn.addEventListener('click', e => {
      const uid = e.target.closest('[data-uid]').dataset.uid;
      showConfirm(`Удалить пользователя?`, async () => {
        try {
          await apiRequest(`/auth/users/${uid}`, { method: 'DELETE' });
          showToast('Удалён', 'success'); await loadUsers(); renderUsersTable();
        } catch(err) { showToast(err.message, 'error'); }
      });
    }));
  }

  // ════════════════════════════════════════════════════════════════
  //  ПРОЧЕЕ (ПОДТВЕРЖДЕНИЕ, ФИЛЬТРЫ, ЭКСПОРТ)
  // ════════════════════════════════════════════════════════════════

  let confirmCb = null;
  function initConfirmModal() {
    $('#confirm-cancel').addEventListener('click', () => { $('#confirm-modal').classList.add('hidden'); confirmCb = null; });
    $('#confirm-ok').addEventListener('click', () => { $('#confirm-modal').classList.add('hidden'); if (confirmCb) confirmCb(); confirmCb = null; });
  }
  function showConfirm(msg, cb) { $('#confirm-message').textContent = msg; confirmCb = cb; $('#confirm-modal').classList.remove('hidden'); }

  function initFilters() {
    $('#search-input').addEventListener('input', () => { clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(() => { pagination.page = 1; renderProjects(); }, 300); });
    $('#filter-payment').addEventListener('change', () => { pagination.page = 1; loadProjects(); });
    $('#filter-project').addEventListener('change', () => { pagination.page = 1; loadProjects(); });
  }

  function initSorting() {
    $('#projects-table').addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th || th.dataset.col === 'actions' || th.dataset.col === 'index') return;
      const col = th.dataset.col;
      sortState = sortState.col === col ? { col, dir: sortState.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' };
      $$('#projects-table thead th').forEach(h => { h.classList.remove('sorted'); const ic = h.querySelector('.sort-icon'); if (ic) ic.textContent = '⇅'; });
      th.classList.add('sorted'); th.querySelector('.sort-icon').textContent = sortState.dir === 'asc' ? '▲' : '▼';
      pagination.page = 1; renderProjects();
    });
  }

  function initExportDropdown() {
    const menu = $('#export-dropdown');
    $('#btn-export-toggle').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', e => { if (!$('#export-dropdown-wrapper').contains(e.target)) menu.classList.add('hidden'); });
    $('#btn-export-csv').addEventListener('click', () => { exportCSV(); menu.classList.add('hidden'); });
    $('#btn-export-excel').addEventListener('click', () => { exportExcel(); menu.classList.add('hidden'); });
    $('#btn-export-pdf').addEventListener('click', () => { exportPDF(); menu.classList.add('hidden'); });
    // Кнопки бэкапа убраны для серверной версии (бэкапы делаются на сервере)
  }

  function getExportData() {
    const isDir = currentUser && currentUser.role === 'director';
    const canView = currentUser && (currentUser.canViewFinances || isDir);
    const f = getFilteredProjects();
    const h = ['№', 'МОП/РОП', 'РП', 'Наименование', 'Битрикс', 'Статус оплаты', 'Статус проекта', 'Дата подписания', 'Срок исполнения', 'Дата передачи', 'Контакт', 'ФИО'];
    if (canView) h.push('Выручка ₽', 'План.маржа ₽', 'План.маржа %');
    if (canView) h.push('Факт.маржа ₽', 'Факт.маржа %', 'Разница ₽');
    const rows = f.map((p, i) => {
      const r = [i + 1, p.mop, p.rp, p.name, p.bitrixLink, p.paymentStatus, p.projectStatus, formatDate(p.signDate), formatDate(p.deadline), formatDate(p.transferDate), p.clientContact, p.clientName];
      if (canView) r.push(p.revenue, p.plannedMarginRub, p.plannedMarginPct);
      if (canView) r.push(p.actualMarginRub, p.actualMarginPct, p.marginDiff);
      return r;
    });
    return { headers: h, rows };
  }

  function exportCSV() {
    const { headers, rows } = getExportData();
    const csv = [headers, ...rows].map(r => r.map(c => { const s = c == null ? '' : String(c); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    downloadFile('\uFEFF' + csv, `СМДЛЕД_Реестр_${todayStr()}.csv`, 'text/csv;charset=utf-8;');
  }

  function exportExcel() {
    const { headers, rows } = getExportData();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Реестр');
    XLSX.writeFile(wb, `СМДЛЕД_Реестр_${todayStr()}.xlsx`);
  }

  function exportPDF() {
    const jsPDF = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
    doc.setFontSize(18); doc.text('СМДЛЕД — Полный Реестр Проектов', 14, 15);
    doc.setFontSize(9); doc.text(`Экспорт: ${new Date().toLocaleString('ru-RU')} | Проектов: ${projects.length}`, 14, 22);
    const { headers, rows } = getExportData();
    doc.autoTable({ head: [headers], body: rows.map(r => r.map(c => c == null ? '' : String(c))), startY: 27, styles: { fontSize: 7 } });
    doc.save(`СМДЛЕД_Реестр_${todayStr()}.pdf`);
  }

  async function init() {
    initAuth();
    initProjectModal();
    initFileUploads();
    initConfirmModal();
    initFilters();
    initSorting();
    initPagination();
    initUsersModal();
    initExportDropdown();
    initSessionTracker();

    if (loadSession()) {
      resetSessionTimer();
      showAppPage();
    } else {
      showAuthPage();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
