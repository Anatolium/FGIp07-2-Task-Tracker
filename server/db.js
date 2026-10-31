import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './password.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TRACKER_DATA_DIR ?? path.join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const MAX_ACCOUNTS = 10;
export const dbFile = path.join(DATA_DIR, 'tracker.db');
export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    login         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('manager', 'employee')),
    password_hash TEXT    NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'in_progress', 'review', 'done')),
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_date    TEXT,
    version     INTEGER NOT NULL DEFAULT 1,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name  TEXT,
    action     TEXT    NOT NULL,
    field      TEXT,
    old_value  TEXT,
    new_value  TEXT,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_comments_task  ON comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_history_task   ON history(task_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
`);

const nowIso = () => new Date().toISOString();

function seed() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (login, name, role, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  );
  const at = nowIso();
  const accounts = [
    ['manager', 'Ольга Смирнова', 'manager', 'manager123'],
    ['ivanov', 'Пётр Иванов', 'employee', 'employee123'],
    ['petrova', 'Анна Петрова', 'employee', 'employee123'],
    ['sidorov', 'Максим Сидоров', 'employee', 'employee123'],
  ];
  for (const [login, name, role, password] of accounts) {
    insertUser.run(login, name, role, hashPassword(password), at);
  }

  const idOf = (login) => db.prepare('SELECT id FROM users WHERE login = ?').get(login).id;
  const managerId = idOf('manager');

  const insertTask = db.prepare(`
    INSERT INTO tasks (title, description, status, assignee_id, due_date, version, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);
  const insertComment = db.prepare(
    'INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertHistory = db.prepare(`
    INSERT INTO history (task_id, user_id, user_name, action, field, old_value, new_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const DAY = 24 * 60 * 60 * 1000;
  const dueIn = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

  const tasks = [
    ['Обновить прайс-лист на сайте', 'Заменить PDF, проверить мобильную версию страницы.', 'new', 'petrova', dueIn(3)],
    ['Настроить резервное копирование', 'Ежедневный бэкап каталога отчётов, хранение 14 дней.', 'in_progress', 'sidorov', dueIn(1)],
    ['Согласовать договор с подрядчиком', 'Проверить пункт 4.2 про сроки оплаты.', 'review', 'ivanov', dueIn(-1)],
    ['Разослать итоги месяца', 'Сводка по KPI за прошлый месяц в общий чат.', 'done', 'petrova', dueIn(-5)],
    ['Почистить таблицу заявок', 'Убрать дубли и закрытые заявки старше года.', 'new', null, dueIn(7)],
  ];
  for (const [title, description, status, login, due] of tasks) {
    const assignee = login ? idOf(login) : null;
    const info = insertTask.run(title, description, status, assignee, due, managerId, managerId, at, at);
    insertHistory.run(info.lastInsertRowid, managerId, 'Ольга Смирнова', 'created', null, null, null, at);
  }

  const taskId = (title) => db.prepare('SELECT id FROM tasks WHERE title = ?').get(title).id;
  const priceTask = taskId('Обновить прайс-лист на сайте');
  insertComment.run(priceTask, managerId, 'Просьба сделать до конца недели.', at);
  insertComment.run(priceTask, idOf('petrova'), 'Приняла, приступаю.', at);

  console.log(`[tracker] База создана: ${dbFile} (демо-доступ manager / manager123).`);
}

seed();
