import { randomBytes } from 'node:crypto';
import { db } from './db.js';

export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
export const SESSION_COOKIE = 'tracker_sid';

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, userId, createdAt.toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

export function sessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(`
      SELECT u.id, u.login, u.name, u.role, u.is_active, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `)
    .get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now() || !row.is_active) {
    destroySession(token);
    return null;
  }
  return { id: row.id, login: row.login, name: row.name, role: row.role };
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}
