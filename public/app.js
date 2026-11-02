const $ = (selector) => document.querySelector(selector);
const API_BASE = window.location.pathname.replace(/\/$/, '') || '';

const STATUS_FALLBACK = ['new', 'in_progress', 'review', 'done'];
const STATUS_LABELS_FALLBACK = {
  new: 'Новая',
  in_progress: 'В работе',
  review: 'На проверке',
  done: 'Готово',
};

const state = {
  me: null,
  users: [],
  tasks: [],
  statuses: STATUS_FALLBACK,
  statusLabels: { ...STATUS_LABELS_FALLBACK },
  filters: { q: '', status: new Set(), assignee: '', due: '' },
  editing: null,
};

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error ?? `Ошибка ${status}`);
    this.status = status;
    this.payload = payload ?? {};
  }
}

async function api(method, path, body) {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (response.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new ApiError(401, { error: 'Сессия истекла, войдите заново' });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

/* ---------- Общие утилиты ---------- */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

function isManager() {
  return state.me?.role === 'manager';
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: '2-digit' });
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3600);
}

const STATUS_ACTIONS = {
  created: 'создал(а) задачу',
  updated: 'обновил(а)',
  status_changed: 'сменил(а) статус',
  comment_added: 'добавил(а) комментарий',
  assigned: 'назначил(а) исполнителя',
  deleted: 'удалил(а) задачу',
};

const FIELD_LABELS = {
  title: 'название',
  description: 'описание',
  due_date: 'срок',
  assignee_id: 'исполнитель',
  status: 'статус',
};

/* ---------- Авторизация ---------- */

function showLogin() {
  state.me = null;
  $('#app').hidden = true;
  $('#login-view').hidden = false;
  $('#login-error').hidden = true;
  $('#login-form').reset();
}

function showApp(user) {
  state.me = user;
  $('#login-view').hidden = true;
  $('#app').hidden = false;
  $('#user-name').textContent = user.name;
  $('#user-avatar').textContent = initials(user.name);
  $('#user-role').textContent = user.role === 'manager' ? 'Руководитель' : 'Сотрудник';
  $('#btn-users').hidden = !isManager();
  $('#btn-new').hidden = !isManager();
  $('#filter-assignee').hidden = !isManager();
  renderStatusFilter();
}

async function init() {
  $('#login-form').addEventListener('submit', onLoginSubmit);
  $('#btn-logout').addEventListener('click', onLogout);
  $('#search').addEventListener('input', debounce(() => {
    state.filters.q = $('#search').value.trim();
    loadBoard();
  }, 250));
  $('#filter-due').addEventListener('change', (event) => {
    state.filters.due = event.target.value;
    loadBoard();
  });
  $('#filter-assignee').addEventListener('change', (event) => {
    state.filters.assignee = event.target.value;
    loadBoard();
  });
  $('#btn-reset').addEventListener('click', resetFilters);
  $('#btn-export').addEventListener('click', () => {
    window.location.href = `${API_BASE}/api/export.csv?${buildQuery().toString()}`;
  });
  $('#btn-new').addEventListener('click', () => openTaskDialog(null));
  $('#btn-users').addEventListener('click', openUsersDialog);

  $('#task-save').addEventListener('click', saveTask);
  $('#task-delete').addEventListener('click', deleteTask);
  $('#comment-form').addEventListener('submit', submitComment);
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });
  $('#user-form').addEventListener('submit', createUser);

  try {
    const { user } = await api('GET', '/api/me');
    showApp(user);
    await loadBoard();
  } catch {
    showLogin();
  }

  setInterval(syncInBackground, 20000);
}

async function syncInBackground() {
  if (!state.me || document.hidden) return;
  if (document.querySelector('dialog[open]')) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
  try {
    await loadBoard();
  } catch {
    /* тихо игнорируем фоновые ошибки */
  }
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const button = $('#login-submit');
  const error = $('#login-error');
  error.hidden = true;
  button.disabled = true;
  try {
    const { user } = await api('POST', '/api/login', {
      login: $('#login-input').value.trim(),
      password: $('#password-input').value,
    });
    showApp(user);
    await loadBoard();
    toast(`Здравствуйте, ${user.name}!`, 'success');
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function onLogout() {
  try {
    await api('POST', '/api/logout');
  } catch {
    /* игнорируем */
  }
  showLogin();
}

/* ---------- Данные ---------- */

function buildQuery() {
  const params = new URLSearchParams();
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.status.size) params.set('status', [...state.filters.status].join(','));
  if (state.filters.assignee) params.set('assignee', state.filters.assignee);
  if (state.filters.due) params.set('due', state.filters.due);
  return params;
}

async function loadBoard() {
  const data = await api('GET', `/api/tasks?${buildQuery().toString()}`);
  state.tasks = data.tasks;
  state.statuses = data.statuses ?? STATUS_FALLBACK;
  state.statusLabels = data.statusLabels ?? STATUS_FALLBACK_LABELS;
  if (data.users) state.users = data.users;
  renderAssigneeFilter();
  renderBoard();
}

/* ---------- Фильтры ---------- */

function renderStatusFilter() {
  const container = $('#status-filter');
  container.innerHTML = state.statuses
    .map((status) => {
      const count = state.tasks.filter((task) => task.status === status).length;
      return `<button class="chip" type="button" data-status="${status}" aria-pressed="${state.filters.status.has(status)}">
        ${esc(state.statusLabels[status])}<span class="chip__count">${count}</span>
      </button>`;
    })
    .join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const status = chip.dataset.status;
      if (state.filters.status.has(status)) state.filters.status.delete(status);
      else state.filters.status.add(status);
      loadBoard();
    });
  });
}

function renderAssigneeFilter() {
  if (!isManager()) return;
  const select = $('#filter-assignee');
  const current = state.filters.assignee;
  select.innerHTML = [
    '<option value="">Все исполнители</option>',
    '<option value="me">Мои задачи</option>',
    ...state.users.map((user) => `<option value="${user.id}">${esc(user.name)}</option>`),
    '<option value="none">Без исполнителя</option>',
  ].join('');
  select.value = current;
  if (select.value !== current) {
    select.value = '';
    state.filters.assignee = '';
  }
}

function resetFilters() {
  state.filters = { q: '', status: new Set(), assignee: '', due: '' };
  $('#search').value = '';
  $('#filter-due').value = '';
  const assignee = $('#filter-assignee');
  if (assignee) assignee.value = '';
  loadBoard();
}

/* ---------- Канбан ---------- */

function renderBoard() {
  const board = $('#board');
  board.innerHTML = state.statuses
    .map((status) => {
      const tasks = state.tasks.filter((task) => task.status === status);
      const cards = tasks.length
        ? tasks.map(cardHtml).join('')
        : '<li class="column__empty">Нет задач</li>';
      return `<section class="column" data-status="${status}">
        <header class="column__head">
          <span class="column__dot" aria-hidden="true"></span>
          <span>${esc(state.statusLabels[status])}</span>
          <span class="column__count">${tasks.length}</span>
        </header>
        <ul class="column__list">${cards}</ul>
      </section>`;
    })
    .join('');

  renderStatusFilter();
  $('#board-summary').textContent = summaryText();

  board.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-move]')) return;
      openTaskDialog(Number(card.dataset.id));
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openTaskDialog(Number(card.dataset.id));
      }
    });
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', card.dataset.id);
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  });

  board.querySelectorAll('[data-move]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = Number(button.closest('.card').dataset.id);
      moveTask(id, button.dataset.move);
    });
  });

  board.querySelectorAll('.column').forEach((column) => {
    const list = column.querySelector('.column__list');
    const setOver = (state_) => column.classList.toggle('is-over', state_);
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(true);
    });
    column.addEventListener('dragleave', (event) => {
      if (!column.contains(event.relatedTarget)) setOver(false);
    });
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      setOver(false);
      const id = Number(event.dataTransfer.getData('text/plain'));
      if (id) moveTask(id, column.dataset.status);
    });
    if (list) list.dataset.dropzone = 'true';
  });
}

function summaryText() {
  const total = state.tasks.length;
  const active = state.tasks.filter((task) => task.status !== 'done').length;
  const overdue = state.tasks.filter(isOverdue).length;
  const scope = isManager() ? 'всего в системе' : 'назначено вам';
  const parts = [`Показано задач: ${total} (${scope})`, `в работе: ${active}`];
  if (overdue) parts.push(`просрочено: ${overdue}`);
  return parts.join(' · ');
}

function isOverdue(task) {
  if (!task.due_date || task.status === 'done') return false;
  return task.due_date < todayIso();
}

function dueBadge(task) {
  if (!task.due_date) return '<span class="badge">Без срока</span>';
  if (task.status === 'done') return `<span class="badge badge--ok">${esc(formatDate(task.due_date))}</span>`;
  const today = todayIso();
  if (task.due_date < today) return `<span class="badge badge--overdue">Просрочено · ${esc(formatDate(task.due_date))}</span>`;
  if (task.due_date === today) return `<span class="badge badge--soon">Сегодня</span>`;
  return `<span class="badge">${esc(formatDate(task.due_date))}</span>`;
}

function cardHtml(task) {
  const index = state.statuses.indexOf(task.status);
  const prev = state.statuses[index - 1];
  const next = state.statuses[index + 1];
  const assignee = task.assignee_name
    ? `<span class="card__assignee"><span class="avatar">${esc(initials(task.assignee_name))}</span>${esc(task.assignee_name)}</span>`
    : '<span class="card__assignee"><span class="avatar avatar--empty">?</span>Не назначен</span>';
  return `<li class="card" data-id="${task.id}" tabindex="0" draggable="true" role="button" aria-label="Задача ${esc(task.title)}">
    <h3 class="card__title">${esc(task.title)}</h3>
    ${task.description ? `<p class="card__desc">${esc(task.description)}</p>` : ''}
    <div class="card__footer">
      ${assignee}
      <span class="card__spacer"></span>
      ${dueBadge(task)}
      ${task.comments_count ? `<span class="badge">💬 ${task.comments_count}</span>` : ''}
    </div>
    <div class="card__move">
      ${prev && canMoveFor(task, prev) ? `<button class="btn btn--ghost" type="button" data-move="${prev}">‹ ${esc(state.statusLabels[prev])}</button>` : ''}
      ${next && canMoveFor(task, next) ? `<button class="btn btn--ghost" type="button" data-move="${next}">${esc(state.statusLabels[next])} ›</button>` : ''}
    </div>
  </li>`;
}

function canMoveFor(task, status) {
  return isManager() || status !== 'done';
}

async function moveTask(id, status) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || task.status === status) return;
  if (!canMoveFor({ ...task, status }, status)) {
    toast('Сотрудник не может ставить статусы «Готово»', 'error');
    return;
  }
  try {
    await api('PATCH', `/api/tasks/${id}`, { status, version: task.version });
    toast(`«${task.title}» → ${state.statusLabels[status]}`, 'success');
  } catch (err) {
    if (err.status === 409) toast('Задачу изменил другой пользователь, список обновлён', 'warn');
    else if (err.status === 403) toast(err.message, 'error');
    else toast(err.message, 'error');
  }
  await loadBoard();
}

/* ---------- Диалог задачи ---------- */

async function openTaskDialog(id) {
  const dialog = $('#task-dialog');
  const isNew = id === null;
  if (isNew && !isManager()) return;

  $('#task-dialog-title').textContent = isNew ? 'Новая задача' : 'Задача';
  $('#task-delete').hidden = true;
  $('#task-meta').textContent = '';
  setTaskFormEnabled(true);

  if (isNew) {
    state.editing = { task: null, comments: [], history: [] };
    $('#task-title').value = '';
    $('#task-description').value = '';
    $('#task-due').value = '';
    renderAssigneeSelect(null);
    renderStatusSelect('new');
    document.querySelector('.task-side').hidden = true;
    $('#task-save').textContent = 'Создать задачу';
    $('#task-save').disabled = false;
    dialog.showModal();
    $('#task-title').focus();
    return;
  }

  try {
    const data = await api('GET', `/api/tasks/${id}`);
    state.editing = data;
    document.querySelector('.task-side').hidden = false;
    $('#task-title').value = data.task.title;
    $('#task-description').value = data.task.description;
    $('#task-due').value = data.task.due_date ?? '';
    renderAssigneeSelect(data.task.assignee_id);
    renderStatusSelect(data.task.status);
    $('#task-delete').hidden = !isManager();
    $('#task-save').textContent = 'Сохранить';
    $('#task-save').disabled = false;
    renderMeta(data.task);
    renderComments();
    renderHistory();
    selectTab('comments');
    dialog.showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setTaskFormEnabled(enabled) {
  ['#task-title', '#task-description', '#task-due', '#task-assignee', '#task-status'].forEach((selector) => {
    $(selector).disabled = !enabled;
  });
}

function renderMeta(task) {
  $('#task-meta').textContent =
    `Создана: ${formatDateTime(task.created_at)} · Изменена: ${formatDateTime(task.updated_at)} · Версия: ${task.version}`;
}

function renderAssigneeSelect(currentId) {
  const select = $('#task-assignee');
  const field = select.closest('.field');
  if (!isManager()) {
    field.hidden = true;
    return;
  }
  field.hidden = false;
  select.innerHTML = [
    '<option value="none">Не назначен</option>',
    ...state.users.map((user) => `<option value="${user.id}">${esc(user.name)}</option>`),
  ].join('');
  select.value = currentId ? String(currentId) : 'none';
}

function renderStatusSelect(current) {
  const select = $('#task-status');
  select.innerHTML = state.statuses
    .filter((status) => isManager() || status !== 'done' || status === current)
    .map((status) => `<option value="${status}">${esc(state.statusLabels[status])}</option>`)
    .join('');
  select.value = current;
}

async function saveTask() {
  const button = $('#task-save');
  button.disabled = true;
  const title = $('#task-title').value.trim();
  if (!title) {
    toast('Укажите название задачи', 'error');
    button.disabled = false;
    return;
  }
  const payload = {
    title,
    description: $('#task-description').value,
    due_date: $('#task-due').value || null,
    status: $('#task-status').value,
  };
  if (isManager()) payload.assignee_id = $('#task-assignee').value;

  try {
    if (state.editing?.task) {
      payload.version = state.editing.task.version;
      await api('PATCH', `/api/tasks/${state.editing.task.id}`, payload);
      toast('Задача сохранена', 'success');
    } else {
      await api('POST', '/api/tasks', payload);
      toast('Задача создана', 'success');
    }
    $('#task-dialog').close();
    await loadBoard();
  } catch (err) {
    if (err.status === 409) {
      toast('Задачу успел изменить другой пользователь — обновили данные', 'warn');
      $('#task-dialog').close();
      await loadBoard();
      await openTaskDialog(err.payload.current?.id ?? state.editing?.task?.id);
    } else {
      toast(err.message, 'error');
      button.disabled = false;
    }
  }
}

async function deleteTask() {
  const task = state.editing?.task;
  if (!task) return;
  if (!window.confirm(`Удалить задачу «${task.title}»?`)) return;
  try {
    await api('DELETE', `/api/tasks/${task.id}`);
    toast('Задача удалена', 'success');
    $('#task-dialog').close();
    await loadBoard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  });
  $('#panel-comments').hidden = name !== 'comments';
  $('#panel-history').hidden = name !== 'history';
}

function renderComments() {
  const comments = state.editing?.comments ?? [];
  $('#comments-list').innerHTML = comments.length
    ? comments.map((comment) => `<li class="comment">
        <div class="comment__head">
          <span class="comment__author">${esc(comment.user_name)}</span>
          <span>${esc(formatDateTime(comment.created_at))}</span>
        </div>
        <p class="comment__body">${esc(comment.body)}</p>
      </li>`).join('')
    : '<li class="hint">Комментариев пока нет.</li>';
  const list = $('#comments-list');
  list.scrollTop = list.scrollHeight;
}

function historyEntry(item) {
  if (['status_changed', 'updated', 'assigned'].includes(item.action)) {
    const field = FIELD_LABELS[item.field] ?? item.field ?? '';
    const from = item.old_value ?? '—';
    const to = item.new_value ?? '—';
    if (item.action === 'assigned') {
      return `${STATUS_ACTIONS.assigned}: <span class="history__field">${esc(to)}</span>`;
    }
    return `${STATUS_ACTIONS[item.action]} <span class="history__field">${esc(field)}</span>: ${esc(from)} → ${esc(to)}`;
  }
  return STATUS_ACTIONS[item.action] ?? item.action;
}

function renderHistory() {
  const history = state.editing?.history ?? [];
  $('#history-list').innerHTML = history.length
    ? history.map((item) => `<li class="history__item">
        <span class="history__dot" aria-hidden="true"></span>
        <span class="history__text">
          <b>${esc(item.user_name ?? 'Система')}</b> ${historyEntry(item)}<br />
          <span class="history__time">${esc(formatDateTime(item.created_at))}</span>
        </span>
      </li>`).join('')
    : '<li class="hint">История пуста.</li>';
}

async function submitComment(event) {
  event.preventDefault();
  const input = $('#comment-input');
  const text = input.value.trim();
  if (!text || !state.editing?.task) return;
  try {
    const { comment } = await api('POST', `/api/tasks/${state.editing.task.id}/comments`, { body: text });
    state.editing.comments.push(comment);
    state.editing.history.unshift({
      id: Date.now(),
      user_name: state.me.name,
      action: 'comment_added',
      created_at: comment.created_at,
    });
    input.value = '';
    renderComments();
    renderHistory();
    await loadBoard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Пользователи ---------- */

async function openUsersDialog() {
  try {
    const data = await api('GET', '/api/users');
    state.users = data.users.filter((user) => user.is_active);
    $('#users-limit').textContent = `Занято ${data.users.length} из ${data.limit} аккаунтов.`;
    renderUsersList(data.users);
    $('#users-dialog').showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderUsersList(users) {
  $('#users-list').innerHTML = users
    .map((user) => `<li class="user-row ${user.is_active ? '' : 'user-row--off'}">
      <span class="avatar">${esc(initials(user.name))}</span>
      <span class="user-row__info">
        <span class="user-row__name">${esc(user.name)}</span>
        <span class="user-row__meta">${user.role === 'manager' ? 'Руководитель' : 'Сотрудник'}${user.is_active ? '' : ' · заблокирован'}</span>
      </span>
      <span class="user-row__actions">
        <button class="btn btn--ghost btn--small" type="button" data-role="${user.id}">${user.role === 'manager' ? 'Сделать сотрудником' : 'Сделать руководителем'}</button>
        <button class="btn btn--ghost btn--small" type="button" data-password="${user.id}">Новый пароль</button>
        <button class="btn btn--ghost btn--small" type="button" data-toggle="${user.id}">${user.is_active ? 'Заблокировать' : 'Разблокировать'}</button>
        <button class="btn btn--danger btn--small" type="button" data-delete="${user.id}">Удалить</button>
      </span>
    </li>`).join('');

  const list = $('#users-list');
  list.querySelectorAll('[data-role]').forEach((button) => button.addEventListener('click', () => {
    const user = users.find((item) => item.id === Number(button.dataset.role));
    patchUser(user.id, { role: user.role === 'manager' ? 'employee' : 'manager' });
  }));
  list.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => {
    const user = users.find((item) => item.id === Number(button.dataset.toggle));
    patchUser(user.id, { is_active: !user.is_active });
  }));
  list.querySelectorAll('[data-password]').forEach((button) => button.addEventListener('click', () => {
    const password = window.prompt('Новый пароль (минимум 6 символов):');
    if (password) patchUser(Number(button.dataset.password), { password });
  }));
  list.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => {
    const user = users.find((item) => item.id === Number(button.dataset.delete));
    if (window.confirm(`Удалить пользователя «${user.name}»? Все сессии будут закрыты.`)) removeUser(user.id);
  }));
}

async function patchUser(id, payload) {
  try {
    await api('PATCH', `/api/users/${id}`, payload);
    toast('Пользователь обновлён', 'success');
    await openUsersDialog();
    await loadBoard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeUser(id) {
  try {
    await api('DELETE', `/api/users/${id}`);
    toast('Пользователь удалён', 'success');
    await openUsersDialog();
    await loadBoard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createUser(event) {
  event.preventDefault();
  try {
    await api('POST', '/api/users', {
      login: $('#new-login').value.trim(),
      name: $('#new-name').value.trim(),
      password: $('#new-password').value,
      role: $('#new-role').value,
    });
    $('#user-form').reset();
    toast('Пользователь добавлен', 'success');
    await openUsersDialog();
    await loadBoard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

init();
