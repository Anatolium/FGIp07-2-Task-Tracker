import { db, MAX_ACCOUNTS } from './db.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  createSession,
  destroySession,
  destroyUserSessions,
  sessionUser,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './auth.js';
import * as rules from './rules.js';
import { HttpError, parseCookies, readJson, sendJson, sessionCookie } from './http-util.js';

const nowIso = () => new Date().toISOString();
const todayIso = () => new Date().toISOString().slice(0, 10);
const isoAfterDays = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const stmt = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY role DESC, name COLLATE NOCASE'),
  activeUsers: db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name COLLATE NOCASE"),
  insertUser: db.prepare(
    'INSERT INTO users (login, name, role, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  ),
  countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
  countActiveManagers: db.prepare(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'manager' AND is_active = 1",
  ),
  taskById: db.prepare(`
    SELECT t.*, u.name AS assignee_name,
           (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comments_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = ?
  `),
  insertTask: db.prepare(`
    INSERT INTO tasks (title, description, status, assignee_id, due_date, version, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  insertComment: db.prepare(
    'INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
  ),
  commentsByTask: db.prepare(`
    SELECT c.id, c.body, c.created_at, c.user_id, COALESCE(u.name, 'Удалённый пользователь') AS user_name
    FROM comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.id
  `),
  insertHistory: db.prepare(`
    INSERT INTO history (task_id, user_id, user_name, action, field, old_value, new_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  historyByTask: db.prepare(
    'SELECT id, user_id, user_name, action, field, old_value, new_value, created_at FROM history WHERE task_id = ? ORDER BY id DESC',
  ),
};

function publicUser(row) {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    role: row.role,
    is_active: !!row.is_active,
    created_at: row.created_at,
  };
}

function serializeTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    statusLabel: rules.STATUS_LABELS[row.status],
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name ?? null,
    due_date: row.due_date ?? null,
    version: row.version,
    comments_count: row.comments_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function recordHistory(taskId, user, action, field = null, oldValue = null, newValue = null) {
  stmt.insertHistory.run(
    taskId,
    user?.id ?? null,
    user?.name ?? 'Система',
    action,
    field,
    oldValue === null ? null : String(oldValue),
    newValue === null ? null : String(newValue),
    nowIso(),
  );
}

function requireUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const header = req.headers.authorization;
  const token = cookies[SESSION_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
  const user = token ? sessionUser(token) : null;
  if (!user) throw new HttpError(401, 'Требуется вход в систему');
  return { user, token };
}

function requireRole(user, check, message) {
  if (!check(user)) throw new HttpError(403, message);
}

function cleanText(value, { field, max, required = false }) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && text.length === 0) throw new HttpError(400, `Поле «${field}» обязательно`);
  if (text.length > max) throw new HttpError(400, `Поле «${field}» длиннее ${max} символов`);
  return text;
}

function cleanDueDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new HttpError(400, 'Некорректный срок выполнения');
  }
  return text;
}

function resolveAssignee(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'none') return null;
  const id = Number(value);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Некорректный исполнитель');
  const row = stmt.userById.get(id);
  if (!row) throw new HttpError(400, 'Исполнитель не найден');
  return row.id;
}

function listTasks(user, params) {
  const where = [];
  const args = [];
  if (!rules.isManager(user)) {
    where.push('t.assignee_id = ?');
    args.push(user.id);
  }

  const q = (params.get('q') ?? '').trim();
  if (q) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }

  const statuses = (params.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => rules.STATUSES.includes(s));
  if (statuses.length) {
    where.push(`t.status IN (${statuses.map(() => '?').join(', ')})`);
    args.push(...statuses);
  }

  const assignee = params.get('assignee');
  if (assignee && rules.isManager(user)) {
    if (assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (assignee === 'me') {
      where.push('t.assignee_id = ?');
      args.push(user.id);
    } else if (/^\d+$/.test(assignee)) {
      where.push('t.assignee_id = ?');
      args.push(Number(assignee));
    }
  }

  const due = params.get('due');
  if (due === 'overdue') {
    where.push("t.due_date IS NOT NULL AND t.due_date <> '' AND t.due_date < ? AND t.status <> 'done'");
    args.push(todayIso());
  } else if (due === 'today') {
    where.push('t.due_date = ?');
    args.push(todayIso());
  } else if (due === 'week') {
    where.push("t.due_date IS NOT NULL AND t.due_date <> '' AND t.due_date BETWEEN ? AND ?");
    args.push(todayIso(), isoAfterDays(6));
  } else if (due === 'none') {
    where.push("(t.due_date IS NULL OR t.due_date = '')");
  } else if (due === 'set') {
    where.push("t.due_date IS NOT NULL AND t.due_date <> ''");
  }

  const sql = `
    SELECT t.*, u.name AS assignee_name,
           (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comments_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (t.due_date IS NULL OR t.due_date = ''), t.due_date, t.id DESC
  `;
  return db.prepare(sql).all(...args).map(serializeTask);
}

function loadTaskFor(user, id) {
  const row = stmt.taskById.get(id);
  if (!row) throw new HttpError(404, 'Задача не найдена');
  if (!rules.canViewTask(user, row)) {
    throw new HttpError(403, 'Нет доступа к этой задаче');
  }
  return row;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const loginAttempts = new Map();

function throttleLogin(key) {
  const state = loginAttempts.get(key);
  if (!state) return;
  const WINDOW = 5 * 60 * 1000;
  if (Date.now() - state.first > WINDOW) {
    loginAttempts.delete(key);
    return;
  }
  if (state.count >= 10) throw new HttpError(429, 'Слишком много попыток входа, повторите позже');
}

function noteLoginFailure(key) {
  const state = loginAttempts.get(key) ?? { count: 0, first: Date.now() };
  state.count += 1;
  loginAttempts.set(key, state);
}

export async function handleApi(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter(Boolean);

  if (segments[0] !== 'api') return false;

  try {
    const result = await route(req, res, url, segments, method);
    if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
  } catch (error) {
    if (res.writableEnded) return true;
    const status = error.status ?? 500;
    if (status >= 500) console.error('[tracker] Ошибка API:', error);
    sendJson(res, status, {
      error: status >= 500 ? 'Внутренняя ошибка сервера' : error.message,
      ...(error.extra ?? {}),
    });
  }
  return true;
}

async function route(req, res, url, segments, method) {
  const [, rawResource, id, action] = segments;
  const resource = (rawResource ?? '').replace(/\.csv$/i, '');

  if (resource === 'login' && method === 'POST') return login(req, res);
  if (resource === 'logout' && method === 'POST') return logout(req, res);
  if (resource === 'me' && method === 'GET') {
    const { user } = requireUser(req);
    return { user };
  }

  const { user } = requireUser(req);

  if (resource === 'session-check') return { user };
  if (resource === 'users') return users(req, res, method, id, user);
  if (resource === 'tasks') return tasks(req, res, url, method, id, action, user);
  if (resource === 'export' && method === 'GET') return exportCsv(res, url, user);
  if (resource === 'board' && method === 'GET') return board(url, user);
  throw new HttpError(404, 'Неизвестный метод API');
}

async function login(req, res) {
  const body = await readJson(req);
  const loginName = cleanText(body.login, { field: 'Логин', max: 64, required: true });
  const password = String(body.password ?? '');
  throttleLogin(loginName.toLowerCase());

  const row = stmt.userByLogin.get(loginName);
  const ok = row && row.is_active && verifyPassword(password, row.password_hash);
  if (!ok) {
    noteLoginFailure(loginName.toLowerCase());
    throw new HttpError(401, 'Неверный логин или пароль');
  }

  loginAttempts.delete(loginName.toLowerCase());
  const { token, expiresAt } = createSession(row.id);
  const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  sendJson(res, 200, { user: publicUser(row), token }, {
    'Set-Cookie': sessionCookie(SESSION_COOKIE, token, maxAge),
  });
  return undefined;
}

async function logout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const header = req.headers.authorization;
  const token = cookies[SESSION_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
  destroySession(token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(SESSION_COOKIE, '', 0) });
  return undefined;
}

function board(url, user) {
  const tasks = listTasks(user, url.searchParams);
  const payload = { tasks, statuses: rules.STATUSES, statusLabels: rules.STATUS_LABELS };
  if (rules.isManager(user)) payload.users = stmt.activeUsers.all().map(publicUser);
  return payload;
}

async function tasks(req, res, url, method, id, action, user) {
  if (method === 'GET' && !id) return board(url, user);

  if (method === 'POST' && !id) {
    requireRole(user, rules.canCreateTask, 'Создавать задачи может только руководитель');
    return createTask(req, res, user);
  }

  const taskId = Number(id);
  if (!Number.isInteger(taskId)) throw new HttpError(400, 'Некорректный идентификатор задачи');

  if (action === 'comments') {
    const task = loadTaskFor(user, taskId);
    if (method === 'GET') return { comments: stmt.commentsByTask.all(task.id) };
    if (method === 'POST') return addComment(req, task, user);
    throw new HttpError(405, 'Метод не поддерживается');
  }

  if (action === 'history' && method === 'GET') {
    const task = loadTaskFor(user, taskId);
    return { history: stmt.historyByTask.all(task.id) };
  }

  if (method === 'GET') {
    const task = loadTaskFor(user, taskId);
    return {
      task: serializeTask(task),
      comments: stmt.commentsByTask.all(task.id),
      history: stmt.historyByTask.all(task.id),
    };
  }

  if (method === 'PATCH' || method === 'PUT') return updateTask(req, taskId, user);

  if (method === 'DELETE') {
    const task = loadTaskFor(user, taskId);
    requireRole(user, rules.canDeleteTask, 'Удалять задачи может только руководитель');
    recordHistory(task.id, user, 'deleted', 'title', task.title, null);
    stmt.deleteTask.run(task.id);
    sendJson(res, 200, { ok: true });
    return undefined;
  }

  throw new HttpError(405, 'Метод не поддерживается');
}

async function createTask(req, res, user) {
  const body = await readJson(req);
  const title = cleanText(body.title, { field: 'Название', max: 200, required: true });
  const description = cleanText(body.description, { field: 'Описание', max: 5000 });
  const due = cleanDueDate(body.due_date) ?? null;
  const assignee = resolveAssignee(body.assignee_id) ?? null;
  const status = rules.STATUSES.includes(body.status) ? body.status : 'new';
  const at = nowIso();

  const info = stmt.insertTask.run(title, description, status, assignee, due, user.id, user.id, at, at);
  const taskId = Number(info.lastInsertRowid);
  recordHistory(taskId, user, 'created', null, null, null);
  if (assignee) {
    const assigneeRow = stmt.userById.get(assignee);
    recordHistory(taskId, user, 'assigned', 'assignee_id', null, assigneeRow?.name ?? assignee);
  }
  sendJson(res, 201, { task: serializeTask(stmt.taskById.get(taskId)) });
  return undefined;
}

async function updateTask(req, taskId, user) {
  const task = loadTaskFor(user, taskId);
  requireRole(user, (u) => rules.canEditTaskFields(u, task), 'Нет прав на изменение задачи');

  const body = await readJson(req);
  const expected = body.version;
  if (expected === undefined || expected === null) {
    throw new HttpError(428, 'Не передана версия задачи (version)');
  }
  if (Number(expected) !== task.version) {
    throw new HttpError(409, 'Задачу успел изменить другой пользователь', {
      conflict: true,
      current: serializeTask(stmt.taskById.get(task.id)),
    });
  }

  const changes = [];
  const next = {
    title: task.title,
    description: task.description,
    status: task.status,
    assignee_id: task.assignee_id,
    due_date: task.due_date,
  };

  if (body.title !== undefined) {
    const title = cleanText(body.title, { field: 'Название', max: 200, required: true });
    if (title !== next.title) changes.push(['title', 'Название', next.title, title]);
    next.title = title;
  }
  if (body.description !== undefined) {
    const description = cleanText(body.description, { field: 'Описание', max: 5000 });
    if (description !== next.description) changes.push(['description', 'Описание', next.description, description]);
    next.description = description;
  }
  if (body.due_date !== undefined) {
    const due = cleanDueDate(body.due_date);
    if (due !== next.due_date) changes.push(['due_date', 'Срок', next.due_date, due]);
    next.due_date = due;
  }
  if (body.assignee_id !== undefined) {
    requireRole(user, rules.canAssign, 'Назначать исполнителя может только руководитель');
    const assignee = resolveAssignee(body.assignee_id);
    if (assignee !== next.assignee_id) {
      const from = next.assignee_id ? stmt.userById.get(next.assignee_id)?.name ?? null : null;
      const to = assignee ? stmt.userById.get(assignee)?.name ?? null : null;
      changes.push(['assignee_id', 'Исполнитель', from, to]);
      next.assignee_id = assignee;
    }
  }
  if (body.status !== undefined) {
    if (!rules.STATUSES.includes(body.status)) throw new HttpError(400, 'Неизвестный статус');
    if (body.status !== next.status) {
      requireRole(
        user,
        (u) => rules.canSetStatus(u, task, body.status),
        'Сотрудник может переводить задачу только в статусы «В работе» и «На проверке»',
      );
      changes.push(['status', 'Статус', rules.STATUS_LABELS[next.status], rules.STATUS_LABELS[body.status]]);
      next.status = body.status;
    }
  }

  if (changes.length === 0) return { task: serializeTask(stmt.taskById.get(task.id)) };

  const at = nowIso();
  db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, status = ?, assignee_id = ?, due_date = ?,
        version = version + 1, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(next.title, next.description, next.status, next.assignee_id, next.due_date, user.id, at, task.id);

  for (const [field, label, from, to] of changes) {
    recordHistory(task.id, user, field === 'status' ? 'status_changed' : 'updated', field, from, to);
  }

  return { task: serializeTask(stmt.taskById.get(task.id)) };
}

async function addComment(req, task, user) {
  const body = await readJson(req);
  const text = cleanText(body.body, { field: 'Комментарий', max: 2000, required: true });
  const at = nowIso();
  const info = stmt.insertComment.run(task.id, user.id, text, at);
  recordHistory(task.id, user, 'comment_added', null, null, null);
  const comment = db
    .prepare(`
      SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name
      FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?
    `)
    .get(info.lastInsertRowid);
  return { comment };
}

function exportCsv(res, url, user) {
  const tasks = listTasks(user, url.searchParams);
  const header = ['ID', 'Название', 'Описание', 'Статус', 'Исполнитель', 'Срок', 'Создана', 'Обновлена', 'Комментариев'];
  const rows = tasks.map((task) => [
    task.id,
    task.title,
    task.description,
    task.statusLabel,
    task.assignee_name ?? 'Не назначен',
    task.due_date ?? '',
    task.created_at,
    task.updated_at,
    task.comments_count,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  const body = Buffer.from(`\uFEFF${csv}\r\n`, 'utf8');
  const stamp = todayIso();
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="tasks-${stamp}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function users(req, res, method, id, user) {
  requireRole(user, rules.canManageUsers, 'Управление пользователями доступно только руководителю');

  if (method === 'GET') {
    return { users: stmt.allUsers.all().map(publicUser), limit: MAX_ACCOUNTS };
  }

  if (method === 'POST') {
    const body = await readJson(req);
    const { count } = stmt.countUsers.get();
    if (count >= MAX_ACCOUNTS) {
      throw new HttpError(400, `Достигнут лимит: не более ${MAX_ACCOUNTS} аккаунтов`);
    }
    const login = cleanText(body.login, { field: 'Логин', max: 64, required: true });
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(login)) {
      throw new HttpError(400, 'Логин: 3–64 символа, латиница, цифры, . _ -');
    }
    if (stmt.userByLogin.get(login)) throw new HttpError(400, 'Такой логин уже занят');
    const name = cleanText(body.name, { field: 'Имя', max: 120, required: true });
    const role = body.role === 'manager' ? 'manager' : 'employee';
    const password = String(body.password ?? '');
    if (password.length < 6) throw new HttpError(400, 'Пароль: минимум 6 символов');

    const info = stmt.insertUser.run(login, name, role, hashPassword(password), nowIso());
    sendJson(res, 201, { user: publicUser(stmt.userById.get(Number(info.lastInsertRowid))) });
    return undefined;
  }

  const userId = Number(id);
  if (!Number.isInteger(userId)) throw new HttpError(400, 'Некорректный идентификатор пользователя');
  const target = stmt.userById.get(userId);
  if (!target) throw new HttpError(404, 'Пользователь не найден');

  if (method === 'PATCH') {
    const body = await readJson(req);
    const name = body.name === undefined ? target.name : cleanText(body.name, { field: 'Имя', max: 120, required: true });
    const role = body.role === undefined ? target.role : body.role === 'manager' ? 'manager' : 'employee';
    const isActive = body.is_active === undefined ? !!target.is_active : !!body.is_active;

    const losesManager =
      target.role === 'manager' && target.is_active && (role !== 'manager' || !isActive);
    if (losesManager && stmt.countActiveManagers.get().count <= 1) {
      throw new HttpError(400, 'В системе должен остаться хотя бы один активный руководитель');
    }
    if (target.id === user.id && !isActive) {
      throw new HttpError(400, 'Нельзя заблокировать собственную учётную запись');
    }

    let passwordHash = target.password_hash;
    if (body.password !== undefined && body.password !== '') {
      const password = String(body.password);
      if (password.length < 6) throw new HttpError(400, 'Пароль: минимум 6 символов');
      passwordHash = hashPassword(password);
    }

    db.prepare('UPDATE users SET name = ?, role = ?, is_active = ?, password_hash = ? WHERE id = ?')
      .run(name, role, isActive ? 1 : 0, passwordHash, userId);

    if (body.password !== undefined && body.password !== '') destroyUserSessions(userId);
    if (!isActive) destroyUserSessions(userId);

    return { user: publicUser(stmt.userById.get(userId)) };
  }

  if (method === 'DELETE') {
    if (target.id === user.id) throw new HttpError(400, 'Нельзя удалить собственную учётную запись');
    const losesManager = target.role === 'manager' && target.is_active;
    if (losesManager && stmt.countActiveManagers.get().count <= 1) {
      throw new HttpError(400, 'В системе должен остаться хотя бы один активный руководитель');
    }
    destroyUserSessions(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return { ok: true };
  }

  throw new HttpError(405, 'Метод не поддерживается');
}
