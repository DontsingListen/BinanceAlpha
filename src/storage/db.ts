import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

export class SchemaError extends Error {}

export type Db = DatabaseSync;

/** Opens (creating if needed) the SQLite database with WAL and a bounded busy timeout, then migrates. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  let current = 0;
  if (hasTable) {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
    current = row?.v ?? 0;
  }
  if (current > SCHEMA_VERSION) {
    throw new SchemaError(`database schema version ${current} is newer than supported ${SCHEMA_VERSION}; refusing to start`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Runs fn inside BEGIN IMMEDIATE / COMMIT; rolls back and rethrows on error. */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
