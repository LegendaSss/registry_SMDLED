'use strict';

/* ================================================================
   СМДЛЕД — Полный Реестр Проектов v3
   IndexedDB + AES-256-GCM + SHA-256 + Пагинация
   ================================================================ */

(function () {

  // ─── Константы ───
  const DB_NAME = 'SmdledRegistryDB';
  const DB_VERSION = 1;
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 МБ
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут
  const APP_SECRET = 'SMDLED-2025-SECURE-REGISTRY-KEY';

  // ─── Состояние ───
  let db = null;
  let encKey = null;
  let currentUser = null;
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
  //  КРИПТОГРАФИЯ (AES-256-GCM + SHA-256)
  // ════════════════════════════════════════════════════════════════

  const Crypto = {
    /** Генерация случайных байт */
    randomBytes(len) {
      return crypto.getRandomValues(new Uint8Array(len));
    },

    /** SHA-256 хеширование пароля с солью */
    async hashPassword(password, salt) {
      const enc = new TextEncoder();
      const data = enc.encode(salt + password + salt);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    /** Генерация соли */
    generateSalt() {
      return Array.from(this.randomBytes(16)).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    /** Получить AES ключ из секрета приложения */
    async deriveKey(secret) {
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('SmdledSalt2025'), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    },

    /** AES-GCM шифрование */
    async encrypt(data, key) {
      const enc = new TextEncoder();
      const iv = this.randomBytes(12);
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
      // Сохраняем IV + зашифрованные данные
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);
      return this.bufferToBase64(combined);
    },

    /** AES-GCM дешифровка */
    async decrypt(encryptedBase64, key) {
      const combined = this.base64ToBuffer(encryptedBase64);
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      return JSON.parse(new TextDecoder().decode(decrypted));
    },

    bufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    },

    base64ToBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
  };

  // ════════════════════════════════════════════════════════════════
  //  INDEXED DB
  // ════════════════════════════════════════════════════════════════

  const DB = {
    /** Открыть/создать базу данных */
    open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
          const idb = e.target.result;
          if (!idb.objectStoreNames.contains('store')) {
            idb.createObjectStore('store', { keyPath: 'key' });
          }
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e.target.error);
      });
    },

    /** Записать данные */
    put(key, value) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        tx.objectStore('store').put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    },

    /** Прочитать данные */
    get(key) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readonly');
        const request = tx.objectStore('store').get(key);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = (e) => reject(e.target.error);
      });
    },

    /** Удалить всё */
    clear() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        tx.objectStore('store').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    }
  };

  // ─── Хранение с шифрованием ───
  async function saveEncrypted(key, data) {
    const encrypted = await Crypto.encrypt(data, encKey);
    await DB.put(key, encrypted);
  }

  async function loadEncrypted(key) {
    const encrypted = await DB.get(key);
    if (!encrypted) return null;
    return Crypto.decrypt(encrypted, encKey);
  }

  async function saveUsers() { await saveEncrypted('users', users); }
  async function saveProjects() { await saveEncrypted('projects', projects); }

  async function loadUsers() {
    try { users = (await loadEncrypted('users')) || []; } catch { users = []; }
    const directorExists = users.some(u => u.email === 'director@smdled.ru');
    if (!directorExists) {
      const salt = Crypto.generateSalt();
      const hash = await Crypto.hashPassword('admin123', salt);
      users.push({
        id: generateUUID(), name: 'Директор', email: 'director@smdled.ru',
        passwordHash: hash, salt, role: 'director', canViewFinances: true, canEdit: true
      });
      await saveUsers();
    }
  }

  async function loadProjects() {
    try { projects = (await loadEncrypted('projects')) || []; } catch { projects = []; }
    if (projects.length === 0) {
      projects.push({
        id: generateUUID(), mop: 'Иванов А.А.', rp: 'Петров Б.В.',
        name: 'Светодиодное освещение — ТЦ Мега', bitrixLink: 'https://smdled.bitrix24.ru/crm/deal/123/',
        paymentStatus: 'Полностью оплачен', projectStatus: 'реализован/УПД подписан',
        signDate: '2025-10-27', deadline: '2025-12-27', transferDate: '2025-11-13',
        contractLink: '', contractFile: null, signedContractLink: '', signedContractFile: null,
        clientContact: '7 913 118-51-38', clientName: 'Сурков Андрей',
        revenue: 305470.91, plannedMarginRub: 100000, plannedMarginPct: 32.74,
        calcLink: '', updLink: '', closeDate: '2025-12-07',
        actualMarginRub: 168000, actualMarginPct: 55.00, marginDiff: 68000,
        createdAt: new Date().toISOString(), createdBy: 'director@smdled.ru'
      });
      await saveProjects();
    }
  }

  function saveSession(user) { sessionStorage.setItem('smdled_session', JSON.stringify({ email: user.email, ts: Date.now() })); }
  function clearSession() { sessionStorage.removeItem('smdled_session'); }
  function loadSessionEmail() {
    try {
      const d = JSON.parse(sessionStorage.getItem('smdled_session'));
      if (d && (Date.now() - d.ts) < SESSION_TIMEOUT_MS) return d.email;
    } catch { }
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  //  УТИЛИТЫ
  // ════════════════════════════════════════════════════════════════

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
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
  function renderLink(url) { return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="link-icon" title="${esc(url)}">🔗</a>` : '—'; }
  function renderFileOrLink(file, link) {
    if (file && file.name && file.data)
      return `<button class="file-badge" onclick="window.__downloadFile('${esc(file.name)}','${file.data}')" title="${esc(file.name)}">${getFileIcon(file.name)} ${esc(file.name)}</button>`;
    return link ? renderLink(link) : '—';
  }
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  window.__downloadFile = function (name, dataUrl) {
    const a = document.createElement('a'); a.href = dataUrl; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = filename;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  // ════════════════════════════════════════════════════════════════
  //  ТОСТЫ
  // ════════════════════════════════════════════════════════════════

  function showToast(msg, type = 'info') {
    const c = $('#toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${{ success: '✅', error: '❌', info: 'ℹ️' }[type] || 'ℹ️'}</span><span class="toast-message">${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('exiting'); setTimeout(() => t.remove(), 300); }, 3500);
  }

  // ════════════════════════════════════════════════════════════════
  //  СЕССИЯ — автоматический выход через 30 мин
  // ════════════════════════════════════════════════════════════════

  function resetSessionTimer() {
    clearTimeout(sessionTimer);
    clearTimeout(sessionWarningTimer);
    // Предупреждение за 2 мин до конца
    sessionWarningTimer = setTimeout(() => {
      const w = document.createElement('div');
      w.className = 'session-warning'; w.id = 'session-warn';
      w.textContent = '⏰ Сессия истечёт через 2 минуты. Любое действие продлит сессию.';
      if (!$('#session-warn')) document.body.appendChild(w);
    }, SESSION_TIMEOUT_MS - 120000);
    // Выход
    sessionTimer = setTimeout(() => {
      clearSession(); currentUser = null; showAuthPage();
      showToast('Сессия истекла. Войдите заново.', 'info');
    }, SESSION_TIMEOUT_MS);
    // Обновляем метку времени сессии
    if (currentUser) saveSession(currentUser);
    const warn = $('#session-warn');
    if (warn) warn.remove();
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
      clearSession(); currentUser = null; showAuthPage();
      showToast('Вы вышли из системы', 'info');
    });
  }

  async function handleLogin() {
    const email = $('#login-email').value.trim().toLowerCase();
    const password = $('#login-password').value;
    if (!email || !password) { showToast('Введите email и пароль', 'error'); return; }
    if (!isValidEmail(email)) { showToast('Введите корректный email', 'error'); return; }
    const user = users.find(u => u.email.toLowerCase() === email);
    if (!user) { showToast('Неверный email или пароль', 'error'); return; }
    // Проверка хеша пароля
    const hash = await Crypto.hashPassword(password, user.salt);
    if (hash !== user.passwordHash) { showToast('Неверный email или пароль', 'error'); return; }
    currentUser = user;
    saveSession(user); resetSessionTimer();
    showAppPage();
    showToast(`Добро пожаловать, ${user.name}!`, 'success');
  }

  async function handleRegister() {
    const name = $('#register-name').value.trim();
    const email = $('#register-email').value.trim().toLowerCase();
    const password = $('#register-password').value;
    if (!name || !email || !password) { showToast('Заполните все поля', 'error'); return; }
    if (!isValidEmail(email)) { showToast('Введите корректный email', 'error'); return; }
    if (password.length < 6) { showToast('Пароль минимум 6 символов', 'error'); return; }
    if (users.some(u => u.email.toLowerCase() === email)) { showToast('Такой email уже есть', 'error'); return; }
    const salt = Crypto.generateSalt();
    const passwordHash = await Crypto.hashPassword(password, salt);
    const u = { id: generateUUID(), name, email, passwordHash, salt, role: 'viewer', canViewFinances: false, canEdit: false };
    users.push(u);
    await saveUsers();
    currentUser = u; saveSession(u); resetSessionTimer();
    showAppPage();
    showToast('Регистрация успешна! Роль: Наблюдатель', 'success');
  }

  function showAuthPage() {
    $('#auth-page').classList.remove('hidden'); $('#app-page').classList.add('hidden');
    ['#login-email', '#login-password', '#register-name', '#register-email', '#register-password'].forEach(s => $(s).value = '');
  }

  function showAppPage() {
    $('#auth-page').classList.add('hidden'); $('#app-page').classList.remove('hidden');
    currentUser = users.find(u => u.email === currentUser.email) || currentUser;
    applyPermissions(); renderProjects(); updateStats(); updateUserDisplay();
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
    $('#btn-generate-test').style.display = isDir ? '' : 'none';
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
  //  ПАГИНАЦИЯ
  // ════════════════════════════════════════════════════════════════

  function initPagination() {
    $('#per-page-select').addEventListener('change', e => {
      pagination.perPage = parseInt(e.target.value);
      pagination.page = 1;
      renderProjects();
    });
  }

  function renderPagination(totalItems) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pagination.perPage));
    if (pagination.page > totalPages) pagination.page = totalPages;
    const start = (pagination.page - 1) * pagination.perPage + 1;
    const end = Math.min(pagination.page * pagination.perPage, totalItems);

    // Информация
    $('#pagination-info').innerHTML = totalItems > 0
      ? `Показано <strong>${start}–${end}</strong> из <strong>${totalItems}</strong> проектов`
      : 'Нет проектов';

    // Кнопки страниц
    const controls = $('#pagination-controls');
    if (totalPages <= 1) { controls.innerHTML = ''; return; }

    let html = '';
    html += `<button class="page-btn" data-page="1" ${pagination.page === 1 ? 'disabled' : ''}>«</button>`;
    html += `<button class="page-btn" data-page="${pagination.page - 1}" ${pagination.page === 1 ? 'disabled' : ''}>‹</button>`;

    const pages = getPageNumbers(pagination.page, totalPages);
    pages.forEach(p => {
      if (p === '...') {
        html += `<span class="page-btn ellipsis">…</span>`;
      } else {
        html += `<button class="page-btn ${p === pagination.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
      }
    });

    html += `<button class="page-btn" data-page="${pagination.page + 1}" ${pagination.page === totalPages ? 'disabled' : ''}>›</button>`;
    html += `<button class="page-btn" data-page="${totalPages}" ${pagination.page === totalPages ? 'disabled' : ''}>»</button>`;

    controls.innerHTML = html;

    controls.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1 && p <= totalPages && p !== pagination.page) {
          pagination.page = p;
          renderProjects();
        }
      });
    });
  }

  function getPageNumbers(current, total) {
    const pages = [];
    if (total <= 7) {
      for (let i = 1; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      if (current > 3) pages.push('...');
      for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
      if (current < total - 2) pages.push('...');
      pages.push(total);
    }
    return pages;
  }

  // ════════════════════════════════════════════════════════════════
  //  РЕНДЕР ТАБЛИЦЫ
  // ════════════════════════════════════════════════════════════════

  function getFilteredProjects() {
    let f = [...projects];
    const q = ($('#search-input').value || '').trim().toLowerCase();
    if (q) f = f.filter(p => [p.mop, p.rp, p.name, p.clientContact, p.clientName, p.paymentStatus, p.projectStatus].join(' ').toLowerCase().includes(q));
    const pf = $('#filter-payment').value;
    if (pf) f = f.filter(p => p.paymentStatus === pf);
    const sf = $('#filter-project').value;
    if (sf) f = f.filter(p => p.projectStatus === sf);
    if (sortState.col) {
      f.sort((a, b) => {
        let va = a[sortState.col], vb = b[sortState.col];
        const numCols = ['revenue', 'plannedMarginRub', 'plannedMarginPct', 'actualMarginRub', 'actualMarginPct', 'marginDiff'];
        const dateCols = ['signDate', 'deadline', 'transferDate', 'closeDate'];
        if (numCols.includes(sortState.col)) { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; return sortState.dir === 'asc' ? va - vb : vb - va; }
        if (dateCols.includes(sortState.col)) { return sortState.dir === 'asc' ? (va || '').localeCompare(vb || '') : (vb || '').localeCompare(va || ''); }
        return sortState.dir === 'asc' ? (va || '').toString().toLowerCase().localeCompare((vb || '').toString().toLowerCase(), 'ru') : (vb || '').toString().toLowerCase().localeCompare((va || '').toString().toLowerCase(), 'ru');
      });
    }
    return f;
  }

  function renderProjects() {
    const tbody = $('#projects-tbody');
    const filtered = getFilteredProjects();
    const totalItems = filtered.length;

    // Пагинация — вырезаем нужную страницу
    const startIdx = (pagination.page - 1) * pagination.perPage;
    const pageItems = filtered.slice(startIdx, startIdx + pagination.perPage);

    renderPagination(totalItems);

    const isDir = currentUser && currentUser.role === 'director';
    const canView = currentUser && (currentUser.canViewFinances || isDir);
    const canEdit = currentUser && (currentUser.canEdit || isDir);

    if (pageItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="24" style="padding:0;border:none;"><div class="empty-state"><div class="empty-icon">📂</div><p>Проекты не найдены</p><p class="empty-sub">Добавьте проект или измените фильтры</p></div></td></tr>`;
      return;
    }

    let html = '';
    pageItems.forEach((p, i) => {
      const num = startIdx + i + 1;
      const dc = p.marginDiff > 0 ? 'positive' : p.marginDiff < 0 ? 'negative' : '';
      html += `<tr data-id="${p.id}">
        <td class="row-number">${num}</td>
        <td>${esc(p.mop)}</td><td>${esc(p.rp)}</td>
        <td title="${esc(p.name)}">${esc(p.name)}</td>
        <td>${renderLink(p.bitrixLink)}</td>
        <td><span class="status-badge" data-status="${esc(p.paymentStatus)}">${esc(p.paymentStatus) || '—'}</span></td>
        <td><span class="status-badge" data-status="${esc(p.projectStatus)}">${esc(p.projectStatus) || '—'}</span></td>
        <td>${formatDate(p.signDate)}</td><td>${formatDate(p.deadline)}</td><td>${formatDate(p.transferDate)}</td>
        <td>${renderFileOrLink(p.contractFile, p.contractLink)}</td>
        <td>${renderFileOrLink(p.signedContractFile, p.signedContractLink)}</td>
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
  //  ЗАГРУЗКА ФАЙЛОВ (до 50 МБ)
  // ════════════════════════════════════════════════════════════════

  function initFileUploads() {
    setupFileUpload('contract-file-input', 'contract-upload-area', 'contract-file-preview', 'contract');
    setupFileUpload('signed-contract-file-input', 'signed-contract-upload-area', 'signed-contract-file-preview', 'signedContract');
  }

  function setupFileUpload(inputId, areaId, previewId, fk) {
    const input = document.getElementById(inputId), area = document.getElementById(areaId);
    area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
    area.addEventListener('dragleave', () => area.classList.remove('dragover'));
    area.addEventListener('drop', e => { e.preventDefault(); area.classList.remove('dragover'); if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0], document.getElementById(previewId), fk); });
    input.addEventListener('change', () => { if (input.files.length) handleFileSelect(input.files[0], document.getElementById(previewId), fk); });
  }

  function handleFileSelect(file, previewEl, fk) {
    if (file.size > MAX_FILE_SIZE) { showToast(`Файл слишком большой (макс. ${MAX_FILE_SIZE / 1048576} МБ)`, 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const obj = { name: file.name, size: file.size, type: file.type, data: e.target.result };
      if (fk === 'contract') tempContractFile = obj; else tempSignedContractFile = obj;
      renderFilePreview(previewEl, obj, fk);
      showToast(`Файл «${file.name}» загружен (${formatFileSize(file.size)})`, 'success');
    };
    reader.readAsDataURL(file);
  }

  function renderFilePreview(container, obj, fk) {
    if (!obj) { container.innerHTML = ''; return; }
    container.innerHTML = `<div class="file-preview">
      <span class="file-icon">${getFileIcon(obj.name)}</span>
      <span class="file-name">${obj.name}</span>
      <span class="file-size">${formatFileSize(obj.size)}</span>
      <div class="file-actions">
        <button type="button" title="Скачать" onclick="window.__downloadFile('${obj.name}','${obj.data}')">⬇️</button>
        <button type="button" class="remove-file" title="Удалить" data-fk="${fk}">✕</button>
      </div></div>`;
    container.querySelector('.remove-file').addEventListener('click', () => {
      if (fk === 'contract') tempContractFile = null; else tempSignedContractFile = null;
      container.innerHTML = '';
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  CRUD
  // ════════════════════════════════════════════════════════════════

  function initProjectModal() {
    $('#btn-add-project').addEventListener('click', () => openProjectModal());
    $('#modal-close-project').addEventListener('click', closeProjectModal);
    $('#modal-cancel-project').addEventListener('click', closeProjectModal);
    $('#modal-save-project').addEventListener('click', handleSaveProject);
    $('#project-modal').addEventListener('click', e => { if (e.target === $('#project-modal')) closeProjectModal(); });
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
          projects = projects.filter(x => x.id !== id);
          await saveProjects(); renderProjects(); updateStats();
          showToast('Проект удалён', 'success');
        });
      }
    });
  }

  function openProjectModal(p = null) {
    $('#project-form').reset();
    tempContractFile = null; tempSignedContractFile = null;
    $('#contract-file-preview').innerHTML = ''; $('#signed-contract-file-preview').innerHTML = '';
    applyPermissions();
    if (p) {
      $('#modal-title').textContent = 'Редактировать проект';
      $('#project-id').value = p.id;
      const fields = { 'field-mop': p.mop, 'field-rp': p.rp, 'field-name': p.name, 'field-bitrix': p.bitrixLink,
        'field-payment-status': p.paymentStatus, 'field-project-status': p.projectStatus,
        'field-sign-date': p.signDate, 'field-deadline': p.deadline, 'field-transfer-date': p.transferDate,
        'field-contract-link': p.contractLink, 'field-signed-contract-link': p.signedContractLink,
        'field-client-contact': p.clientContact, 'field-client-name': p.clientName,
        'field-revenue': p.revenue, 'field-planned-margin-rub': p.plannedMarginRub,
        'field-planned-margin-pct': p.plannedMarginPct, 'field-calc-link': p.calcLink,
        'field-upd-link': p.updLink, 'field-close-date': p.closeDate,
        'field-actual-margin-rub': p.actualMarginRub, 'field-actual-margin-pct': p.actualMarginPct,
        'field-margin-diff': p.marginDiff };
      Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val || ''; });
      if (p.contractFile) { tempContractFile = p.contractFile; renderFilePreview($('#contract-file-preview'), p.contractFile, 'contract'); }
      if (p.signedContractFile) { tempSignedContractFile = p.signedContractFile; renderFilePreview($('#signed-contract-file-preview'), p.signedContractFile, 'signedContract'); }
    } else {
      $('#modal-title').textContent = 'Добавить проект'; $('#project-id').value = '';
    }
    $('#project-modal').classList.remove('hidden');
    setTimeout(() => $('#field-mop').focus(), 100);
  }

  function closeProjectModal() { $('#project-modal').classList.add('hidden'); tempContractFile = null; tempSignedContractFile = null; }

  async function handleSaveProject() {
    const name = $('#field-name').value.trim();
    if (!name) { showToast('Укажите наименование', 'error'); $('#field-name').focus(); return; }
    const id = $('#project-id').value;
    const data = {
      mop: $('#field-mop').value.trim(), rp: $('#field-rp').value.trim(), name,
      bitrixLink: $('#field-bitrix').value.trim(), paymentStatus: $('#field-payment-status').value,
      projectStatus: $('#field-project-status').value, signDate: $('#field-sign-date').value,
      deadline: $('#field-deadline').value, transferDate: $('#field-transfer-date').value,
      contractLink: $('#field-contract-link').value.trim(), contractFile: tempContractFile,
      signedContractLink: $('#field-signed-contract-link').value.trim(), signedContractFile: tempSignedContractFile,
      clientContact: $('#field-client-contact').value.trim(), clientName: $('#field-client-name').value.trim(),
      revenue: parseFloat($('#field-revenue').value) || 0, plannedMarginRub: parseFloat($('#field-planned-margin-rub').value) || 0,
      plannedMarginPct: parseFloat($('#field-planned-margin-pct').value) || 0, calcLink: $('#field-calc-link').value.trim(),
      updLink: $('#field-upd-link').value.trim(), closeDate: $('#field-close-date').value,
      actualMarginRub: parseFloat($('#field-actual-margin-rub').value) || 0, actualMarginPct: parseFloat($('#field-actual-margin-pct').value) || 0,
      marginDiff: parseFloat($('#field-margin-diff').value) || 0
    };
    if (id) { const idx = projects.findIndex(x => x.id === id); if (idx !== -1) projects[idx] = { ...projects[idx], ...data }; showToast('Проект обновлён', 'success'); }
    else { projects.push({ id: generateUUID(), ...data, createdAt: new Date().toISOString(), createdBy: currentUser.email }); showToast('Проект добавлен', 'success'); }
    await saveProjects(); closeProjectModal(); renderProjects(); updateStats();
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
  //  ПОДТВЕРЖДЕНИЕ
  // ════════════════════════════════════════════════════════════════

  let confirmCb = null;
  function initConfirmModal() {
    $('#confirm-cancel').addEventListener('click', () => { $('#confirm-modal').classList.add('hidden'); confirmCb = null; });
    $('#confirm-ok').addEventListener('click', () => { $('#confirm-modal').classList.add('hidden'); if (confirmCb) confirmCb(); confirmCb = null; });
    $('#confirm-modal').addEventListener('click', e => { if (e.target === $('#confirm-modal')) { $('#confirm-modal').classList.add('hidden'); confirmCb = null; } });
  }
  function showConfirm(msg, cb) { $('#confirm-message').textContent = msg; confirmCb = cb; $('#confirm-modal').classList.remove('hidden'); }

  // ════════════════════════════════════════════════════════════════
  //  ФИЛЬТРЫ, СОРТИРОВКА
  // ════════════════════════════════════════════════════════════════

  function initFilters() {
    $('#search-input').addEventListener('input', () => { clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(() => { pagination.page = 1; renderProjects(); }, 300); });
    $('#filter-payment').addEventListener('change', () => { pagination.page = 1; renderProjects(); });
    $('#filter-project').addEventListener('change', () => { pagination.page = 1; renderProjects(); });
  }

  function initSorting() {
    $('#projects-table').addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th || th.dataset.col === 'actions' || th.dataset.col === 'index') return;
      const col = th.dataset.col;
      sortState = sortState.col === col ? { col, dir: sortState.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' };
      $$('#projects-table thead th').forEach(h => { h.classList.remove('sorted'); const ic = h.querySelector('.sort-icon'); if (ic) ic.textContent = '⇅'; });
      th.classList.add('sorted');
      const si = th.querySelector('.sort-icon');
      if (si) si.textContent = sortState.dir === 'asc' ? '▲' : '▼';
      pagination.page = 1; renderProjects();
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
  // ════════════════════════════════════════════════════════════════

  function initUsersModal() {
    $('#btn-manage-users').addEventListener('click', async () => { await loadUsers(); renderUsersTable(); $('#users-modal').classList.remove('hidden'); });
    $('#modal-close-users').addEventListener('click', () => $('#users-modal').classList.add('hidden'));
    $('#users-modal').addEventListener('click', e => { if (e.target === $('#users-modal')) $('#users-modal').classList.add('hidden'); });
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
      const u = users.find(x => x.id === e.target.dataset.uid);
      if (u) { u.role = e.target.value; if (u.role === 'director') { u.canViewFinances = true; u.canEdit = true; } await saveUsers(); renderUsersTable(); showToast(`Роль изменена`, 'success'); }
    }));
    tbody.querySelectorAll('.ufin').forEach(cb => cb.addEventListener('change', async e => {
      const u = users.find(x => x.id === e.target.dataset.uid);
      if (u) { u.canViewFinances = e.target.checked; await saveUsers(); showToast(`Финансы: ${e.target.checked ? '✅' : '❌'}`, 'info'); }
    }));
    tbody.querySelectorAll('.uedit').forEach(cb => cb.addEventListener('change', async e => {
      const u = users.find(x => x.id === e.target.dataset.uid);
      if (u) { u.canEdit = e.target.checked; await saveUsers(); showToast(`Редактирование: ${e.target.checked ? '✅' : '❌'}`, 'info'); }
    }));
    tbody.querySelectorAll('.udel').forEach(btn => btn.addEventListener('click', e => {
      const uid = e.target.closest('[data-uid]').dataset.uid;
      const u = users.find(x => x.id === uid);
      if (u) showConfirm(`Удалить ${u.name}?`, async () => { users = users.filter(x => x.id !== uid); await saveUsers(); renderUsersTable(); showToast('Удалён', 'success'); });
    }));
  }

  // ════════════════════════════════════════════════════════════════
  //  ЭКСПОРТ — DROPDOWN + CSV + EXCEL + PDF + БЭКАП
  // ════════════════════════════════════════════════════════════════

  function initExportDropdown() {
    const menu = $('#export-dropdown');
    $('#btn-export-toggle').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', e => { if (!$('#export-dropdown-wrapper').contains(e.target)) menu.classList.add('hidden'); });
    $('#btn-export-csv').addEventListener('click', () => { exportCSV(); menu.classList.add('hidden'); });
    $('#btn-export-excel').addEventListener('click', () => { exportExcel(); menu.classList.add('hidden'); });
    $('#btn-export-pdf').addEventListener('click', () => { exportPDF(); menu.classList.add('hidden'); });
    $('#btn-backup-export').addEventListener('click', () => { backupExport(); menu.classList.add('hidden'); });
    $('#backup-file-input').addEventListener('change', e => { if (e.target.files.length) { backupImport(e.target.files[0]); e.target.value = ''; } menu.classList.add('hidden'); });
  }

  function getExportData() {
    const isDir = currentUser && currentUser.role === 'director';
    const canView = currentUser && (currentUser.canViewFinances || isDir);
    const f = getFilteredProjects();
    const h = ['№', 'МОП/РОП', 'РП', 'Наименование', 'Битрикс', 'Статус оплаты', 'Статус проекта', 'Дата подписания', 'Срок исполнения', 'Дата передачи', 'Договор', 'Подп. договор', 'Контакт', 'ФИО'];
    if (canView) h.push('Выручка ₽', 'План.маржа ₽', 'План.маржа %', 'Расчет');
    h.push('УПД', 'Дата закрытия');
    if (canView) h.push('Факт.маржа ₽', 'Факт.маржа %', 'Разница ₽');
    const rows = f.map((p, i) => {
      const r = [i + 1, p.mop, p.rp, p.name, p.bitrixLink, p.paymentStatus, p.projectStatus, formatDate(p.signDate), formatDate(p.deadline), formatDate(p.transferDate), p.contractFile ? p.contractFile.name : p.contractLink, p.signedContractFile ? p.signedContractFile.name : p.signedContractLink, p.clientContact, p.clientName];
      if (canView) r.push(p.revenue, p.plannedMarginRub, p.plannedMarginPct, p.calcLink);
      r.push(p.updLink, formatDate(p.closeDate));
      if (canView) r.push(p.actualMarginRub, p.actualMarginPct, p.marginDiff);
      return r;
    });
    return { headers: h, rows };
  }

  function exportCSV() {
    const { headers, rows } = getExportData();
    const csv = [headers, ...rows].map(r => r.map(c => { const s = c == null ? '' : String(c); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    downloadFile('\uFEFF' + csv, `СМДЛЕД_Реестр_${todayStr()}.csv`, 'text/csv;charset=utf-8;');
    showToast('CSV экспортирован', 'success');
  }

  function exportExcel() {
    try {
      const { headers, rows } = getExportData();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 14) }));
      XLSX.utils.book_append_sheet(wb, ws, 'Реестр');
      XLSX.writeFile(wb, `СМДЛЕД_Реестр_${todayStr()}.xlsx`);
      showToast('Excel экспортирован', 'success');
    } catch (e) { showToast('Ошибка Excel: ' + e.message, 'error'); }
  }

  function exportPDF() {
    try {
      const jsPDF = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
      if (!jsPDF) throw new Error("jsPDF library not loaded");
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
      doc.setFontSize(18); doc.setTextColor(59, 130, 246);
      doc.text('СМДЛЕД — Полный Реестр Проектов', 14, 15);
      doc.setFontSize(9); doc.setTextColor(100);
      doc.text(`Экспорт: ${new Date().toLocaleString('ru-RU')} | Проектов: ${projects.length}`, 14, 22);
      const { headers, rows } = getExportData();
      doc.autoTable({
        head: [headers], body: rows.map(r => r.map(c => c == null ? '' : String(c))), startY: 27,
        styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak', lineColor: [200, 200, 200], lineWidth: 0.1 },
        headStyles: { fillColor: [30, 30, 46], textColor: [240, 240, 245], fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [245, 245, 250] },
        columnStyles: { 0: { cellWidth: 8 } }, margin: { left: 10, right: 10 },
        didParseCell(data) {
          if (data.section === 'body') {
            const v = data.cell.raw;
            if (v === 'Полностью оплачен' || v === 'реализован/УПД подписан') data.cell.styles.textColor = [16, 185, 129];
            else if (v === 'В работе') data.cell.styles.textColor = [59, 130, 246];
            else if (v === 'Приостановлен') data.cell.styles.textColor = [245, 158, 11];
            else if (v === 'Отменён') data.cell.styles.textColor = [239, 68, 68];
          }
        }
      });
      const pages = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(150); doc.text(`Стр. ${i}/${pages}`, doc.internal.pageSize.getWidth() - 25, doc.internal.pageSize.getHeight() - 5); }
      doc.save(`СМДЛЕД_Реестр_${todayStr()}.pdf`);
      showToast('PDF экспортирован', 'success');
    } catch (e) { showToast('Ошибка PDF: ' + e.message, 'error'); }
  }

  // ─── Бэкап ───
  function backupExport() {
    // Для бэкапа НЕ включаем файлы (слишком большие), только метаданные
    const projectsClean = projects.map(p => ({ ...p, contractFile: p.contractFile ? { name: p.contractFile.name, size: p.contractFile.size } : null, signedContractFile: p.signedContractFile ? { name: p.signedContractFile.name, size: p.signedContractFile.size } : null }));
    // Полный бэкап с файлами
    const backup = {
      version: '3.0', exportedAt: new Date().toISOString(), exportedBy: currentUser.email,
      projectsCount: projects.length, usersCount: users.length,
      users: users.map(u => ({ ...u, passwordHash: u.passwordHash, salt: u.salt })),
      projects: projects
    };
    downloadFile(JSON.stringify(backup, null, 2), `СМДЛЕД_Бэкап_${todayStr()}.json`, 'application/json');
    showToast(`Бэкап: ${projects.length} проектов, ${users.length} пользователей`, 'success');
  }

  function backupImport(file) {
    if (!file.name.endsWith('.json')) { showToast('Нужен .json файл', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const b = JSON.parse(e.target.result);
        if (!b.projects || !Array.isArray(b.projects)) { showToast('Неверный формат бэкапа', 'error'); return; }
        showConfirm(`Загрузить бэкап от ${new Date(b.exportedAt).toLocaleString('ru-RU')}?\n${b.projects.length} проектов, ${(b.users || []).length} пользователей.\nТекущие данные будут ЗАМЕНЕНЫ!`, async () => {
          projects = b.projects;
          if (b.users) {
            const hasDir = b.users.some(u => u.email === 'director@smdled.ru');
            users = hasDir ? b.users : [users.find(u => u.email === 'director@smdled.ru'), ...b.users];
          }
          await saveProjects(); await saveUsers();
          currentUser = users.find(u => u.email === currentUser.email) || currentUser;
          renderProjects(); updateStats(); applyPermissions();
          showToast(`Бэкап восстановлен: ${projects.length} проектов`, 'success');
        });
      } catch (err) { showToast('Ошибка бэкапа: ' + err.message, 'error'); }
    };
    reader.readAsText(file);
  }

  // ════════════════════════════════════════════════════════════════
  //  ГЕНЕРАТОР ТЕСТОВЫХ ДАННЫХ (100 проектов)
  // ════════════════════════════════════════════════════════════════

  function initTestGenerator() {
    $('#btn-generate-test').addEventListener('click', () => {
      showConfirm(`Сгенерировать 100 тестовых проектов? Это дополнит текущий реестр.`, async () => {
        const names = ['Освещение ТЦ', 'LED подсветка', 'Промышленное освещение', 'Фасадное освещение', 'Уличное освещение', 'Офисное освещение', 'Освещение склада', 'Архитектурная подсветка', 'Спортивное освещение', 'Парковое освещение'];
        const cities = ['Москва', 'СПб', 'Новосибирск', 'Казань', 'Екатеринбург', 'Краснодар', 'Самара', 'Тюмень', 'Ростов', 'Уфа'];
        const mops = ['Иванов А.А.', 'Петров Б.В.', 'Сидоров К.Л.', 'Козлов Д.М.', 'Николаев Р.С.'];
        const rps = ['Смирнов П.А.', 'Кузнецов В.И.', 'Попов Н.Е.', 'Васильев Т.К.', 'Морозов О.Ю.'];
        const payStatuses = ['Полностью оплачен', 'Оплачен (предоплата)', 'Ожидает (постоплата)', '100% постоплата'];
        const projStatuses = ['подписан/передан на реализацию', 'реализован/УПД подписан', 'В работе', 'Приостановлен', 'Отменён'];
        const lastNames = ['Алексеев', 'Борисов', 'Волков', 'Григорьев', 'Дмитриев', 'Егоров', 'Жуков', 'Зайцев', 'Ильин', 'Калинин'];
        const firstNames = ['Андрей', 'Борис', 'Виктор', 'Георгий', 'Дмитрий', 'Евгений', 'Игорь', 'Константин', 'Максим', 'Олег'];

        const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const rndN = (min, max) => Math.round((Math.random() * (max - min) + min) * 100) / 100;
        const rndDate = (y) => { const m = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0'); const d = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0'); return `${y}-${m}-${d}`; };

        for (let i = 0; i < 100; i++) {
          const revenue = rndN(50000, 2000000);
          const plannedRub = rndN(revenue * 0.1, revenue * 0.5);
          const actualRub = rndN(revenue * 0.05, revenue * 0.6);
          projects.push({
            id: generateUUID(), mop: rnd(mops), rp: rnd(rps),
            name: `${rnd(names)} — ${rnd(cities)} #${i + 1}`,
            bitrixLink: `https://smdled.bitrix24.ru/crm/deal/${1000 + i}/`,
            paymentStatus: rnd(payStatuses), projectStatus: rnd(projStatuses),
            signDate: rndDate(2025), deadline: rndDate(2026), transferDate: rndDate(2025),
            contractLink: '', contractFile: null, signedContractLink: '', signedContractFile: null,
            clientContact: `+7 9${Math.floor(Math.random() * 90 + 10)} ${Math.floor(Math.random() * 900 + 100)}-${Math.floor(Math.random() * 90 + 10)}-${Math.floor(Math.random() * 90 + 10)}`,
            clientName: `${rnd(lastNames)} ${rnd(firstNames)}`,
            revenue, plannedMarginRub: plannedRub, plannedMarginPct: parseFloat(((plannedRub / revenue) * 100).toFixed(2)),
            calcLink: '', updLink: '', closeDate: Math.random() > 0.4 ? rndDate(2025) : '',
            actualMarginRub: actualRub, actualMarginPct: parseFloat(((actualRub / revenue) * 100).toFixed(2)),
            marginDiff: parseFloat((actualRub - plannedRub).toFixed(2)),
            createdAt: new Date().toISOString(), createdBy: 'director@smdled.ru'
          });
        }
        await saveProjects(); pagination.page = 1; renderProjects(); updateStats();
        showToast(`✅ Сгенерировано 100 проектов. Всего: ${projects.length}`, 'success');
      });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  КЛАВИАТУРА
  // ════════════════════════════════════════════════════════════════

  function initKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        ['#project-modal', '#users-modal', '#confirm-modal'].forEach(s => $(s).classList.add('hidden'));
        $('#export-dropdown').classList.add('hidden');
        confirmCb = null;
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  ИНИЦИАЛИЗАЦИЯ (async)
  // ════════════════════════════════════════════════════════════════

  async function init() {
    try {
      // 1. Открываем IndexedDB
      await DB.open();
      console.log('✅ IndexedDB открыта');

      // 2. Генерируем ключ шифрования AES-256
      encKey = await Crypto.deriveKey(APP_SECRET);
      console.log('🔐 Ключ шифрования AES-256-GCM готов');

      // 3. Загружаем данные (дешифровка)
      await loadUsers();
      await loadProjects();
      console.log(`📦 Загружено: ${users.length} пользователей, ${projects.length} проектов`);

      // 4. Инициализация UI
      initAuth();
      initProjectModal();
      initFileUploads();
      initConfirmModal();
      initFilters();
      initSorting();
      initPagination();
      initUsersModal();
      initExportDropdown();
      initTestGenerator();
      initKeyboard();
      initSessionTracker();

      // 5. Проверка сессии
      const email = loadSessionEmail();
      if (email) {
        currentUser = users.find(u => u.email === email);
        if (currentUser) { resetSessionTimer(); showAppPage(); }
        else showAuthPage();
      } else {
        showAuthPage();
      }

      console.log('✅ Приложение СМДЛЕД загружено');

    } catch (err) {
      console.error('❌ Ошибка инициализации:', err);
      // Fallback — показываем ошибку
      document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0a0f;color:#f0f0f5;font-family:Inter,sans-serif;text-align:center;padding:40px;">
        <div><h1 style="color:#ef4444;font-size:2rem;">Ошибка загрузки</h1><p style="margin-top:16px;color:#9ca3af;">${err.message}</p>
        <p style="margin-top:12px;color:#6b7280;">Убедитесь что вы используете современный браузер и открываете через HTTP (не file://)</p>
        <button onclick="location.reload()" style="margin-top:24px;padding:12px 32px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:1rem;cursor:pointer;">Перезагрузить</button></div></div>`;
    }
  }

  // Запуск
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
