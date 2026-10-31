import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let dataDir;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error('Сервер не запустился');
}

before(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TRACKER_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.once('exit', resolve);
      server.kill();
      setTimeout(resolve, 3000);
    });
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

async function request(method, endpoint, { token, body, accept } = {}) {
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Cookie: `tracker_sid=${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (accept === 'text') return { status: response.status, text, headers: response.headers };
  return { status: response.status, data: text ? JSON.parse(text) : {}, headers: response.headers };
}

async function login(loginName, password) {
  const { status, data } = await request('POST', '/api/login', {
    body: { login: loginName, password },
  });
  assert.equal(status, 200, `ожидался успешный вход для ${loginName}`);
  return data.token;
}

let managerToken;
let employeeToken;

test('вход: неверный пароль и защита API', async () => {
  const wrong = await request('POST', '/api/login', { body: { login: 'manager', password: 'nope' } });
  assert.equal(wrong.status, 401);
  const anonymous = await request('GET', '/api/tasks');
  assert.equal(anonymous.status, 401);

  managerToken = await login('manager', 'manager123');
  employeeToken = await login('ivanov', 'employee123');
  assert.equal(managerToken.length, 64);
});

test('роли: сотрудник видит только свои задачи', async () => {
  const all = await request('GET', '/api/tasks', { token: managerToken });
  assert.equal(all.status, 200);
  assert.ok(all.data.tasks.length >= 5);
  assert.ok(all.data.users.length >= 4);

  const own = await request('GET', '/api/tasks', { token: employeeToken });
  assert.equal(own.status, 200);
  assert.ok(own.data.tasks.length >= 1);
  assert.ok(own.data.tasks.every((task) => task.assignee_name === 'Пётр Иванов'));
  assert.equal(own.data.users, undefined);
});

test('сотрудник не может читать чужие задачи', async () => {
  const foreign = await request('GET', '/api/tasks/2', { token: employeeToken });
  assert.equal(foreign.status, 403);
});

test('сотрудник не может создавать задачи и управлять пользователями', async () => {
  const create = await request('POST', '/api/tasks', { token: employeeToken, body: { title: 'x' } });
  assert.equal(create.status, 403);
  const users = await request('GET', '/api/users', { token: employeeToken });
  assert.equal(users.status, 403);
});

test('сотрудник не может назначать исполнителя и ставить «Готово»', async () => {
  const task = (await request('GET', '/api/tasks', { token: employeeToken })).data.tasks[0];
  const assign = await request('PATCH', `/api/tasks/${task.id}`, {
    token: employeeToken,
    body: { assignee_id: 3, version: task.version },
  });
  assert.equal(assign.status, 403);

  const done = await request('PATCH', `/api/tasks/${task.id}`, {
    token: employeeToken,
    body: { status: 'done', version: task.version },
  });
  assert.equal(done.status, 403);

  const progress = await request('PATCH', `/api/tasks/${task.id}`, {
    token: employeeToken,
    body: { status: 'in_progress', version: task.version },
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.data.task.status, 'in_progress');
  assert.equal(progress.data.task.version, task.version + 1);
});

test('конфликт версий при одновременном редактировании', async () => {
  const task = (await request('GET', '/api/tasks', { token: employeeToken })).data.tasks[0];
  const conflict = await request('PATCH', `/api/tasks/${task.id}`, {
    token: employeeToken,
    body: { status: 'review', version: task.version - 1 },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.conflict, true);
  assert.equal(conflict.data.current.status, task.status);

  const retried = await request('PATCH', `/api/tasks/${task.id}`, {
    token: employeeToken,
    body: { status: 'review', version: conflict.data.current.version },
  });
  assert.equal(retried.status, 200);
});

test('комментарии и история изменений', async () => {
  const created = await request('POST', '/api/tasks', {
    token: managerToken,
    body: { title: 'Задача из теста', description: 'проверка', assignee_id: 2, due_date: '2030-01-01' },
  });
  assert.equal(created.status, 201);
  const id = created.data.task.id;

  const comment = await request('POST', `/api/tasks/${id}/comments`, {
    token: employeeToken,
    body: { body: 'Взял в работу' },
  });
  assert.equal(comment.status, 200);
  assert.equal(comment.data.comment.user_name, 'Пётр Иванов');

  const detail = await request('GET', `/api/tasks/${id}`, { token: managerToken });
  assert.equal(detail.data.comments.length, 1);
  const actions = detail.data.history.map((item) => item.action);
  assert.ok(actions.includes('created'));
  assert.ok(actions.includes('comment_added'));
  assert.ok(actions.includes('assigned'));

  const removed = await request('DELETE', `/api/tasks/${id}`, { token: managerToken });
  assert.equal(removed.status, 200);
  const gone = await request('GET', `/api/tasks/${id}`, { token: managerToken });
  assert.equal(gone.status, 404);
});

test('поиск и фильтры', async () => {
  const search = await request('GET', '/api/tasks?q=резервное', { token: managerToken });
  assert.equal(search.data.tasks.length, 1);
  assert.match(search.data.tasks[0].title, /резервное/);

  const byStatus = await request('GET', '/api/tasks?status=done', { token: managerToken });
  assert.ok(byStatus.data.tasks.every((task) => task.status === 'done'));

  const overdue = await request('GET', '/api/tasks?due=overdue', { token: managerToken });
  assert.ok(overdue.data.tasks.every((task) => task.status !== 'done'));

  const unassigned = await request('GET', '/api/tasks?assignee=none', { token: managerToken });
  assert.ok(unassigned.data.tasks.every((task) => task.assignee_id === null));
});

test('CSV-экспорт отдаёт файл с BOM и разделителем «;»', async () => {
  const csv = await request('GET', '/api/export.csv', { token: managerToken, accept: 'text' });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="tasks-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(csv.text, /ID;Название;Описание;Статус;Исполнитель;Срок/);

  const raw = Buffer.from(await (await fetch(`${BASE}/api/export.csv`, {
    headers: { Cookie: `tracker_sid=${managerToken}` },
  })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'файл должен начинаться с BOM UTF-8');
});

test('лимит в 10 аккаунтов соблюдается', async () => {
  const users = await request('GET', '/api/users', { token: managerToken });
  const free = users.data.limit - users.data.users.length;
  for (let index = 0; index < free; index += 1) {
    const created = await request('POST', '/api/users', {
      token: managerToken,
      body: { login: `test_user_${index}`, name: `Тест ${index}`, password: 'secret123', role: 'employee' },
    });
    assert.equal(created.status, 201);
  }
  const overflow = await request('POST', '/api/users', {
    token: managerToken,
    body: { login: 'one_more', name: 'Лишний', password: 'secret123', role: 'employee' },
  });
  assert.equal(overflow.status, 400);
  assert.match(overflow.data.error, /не более 10/);
});

test('нельзя удалить или заблокировать последнего руководителя', async () => {
  const users = await request('GET', '/api/users', { token: managerToken });
  const manager = users.data.users.find((user) => user.role === 'manager');
  const demote = await request('PATCH', `/api/users/${manager.id}`, {
    token: managerToken,
    body: { role: 'employee' },
  });
  assert.equal(demote.status, 400);
  const remove = await request('DELETE', `/api/users/${manager.id}`, { token: managerToken });
  assert.equal(remove.status, 400);
});
