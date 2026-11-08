import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('properties','property_checks')").all();
  if (legacy.length) {
    throw new Error(
      'This database uses the obsolete v0.2 flat properties/property_checks schema. ' +
        'Run `npm run seed` to recreate it with the v0.3 Area > Site > Room > Equipment model.',
    );
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    })();
  }
}

// ---- settings -------------------------------------------------------------

export const DEFAULT_SETTINGS: Record<string, string> = {
  operator_name: 'Compliance Officer (demo)',
  warning_days: '30',
  reminder_thresholds: '30,14,7',
  email_mode: 'demo',
  recalculation_pending: 'false',
};

/** Settings the operator may edit through the API. */
export const EDITABLE_SETTINGS = ['operator_name', 'warning_days', 'reminder_thresholds'] as const;

export function getSetting(db: DB, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key] ?? '';
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Any saved change that could affect calculated status flags the snapshot as stale. */
export function markPending(db: DB): void {
  setSetting(db, 'recalculation_pending', 'true');
}

export function isPending(db: DB): boolean {
  return getSetting(db, 'recalculation_pending') === 'true';
}

export function parseThresholds(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
}
