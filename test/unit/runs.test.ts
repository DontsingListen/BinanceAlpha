import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { openDatabase } from '../../src/storage/db.ts';
import { endRun, getRun } from '../../src/storage/repos.ts';
import { loadConfig } from '../../src/application/config.ts';
import { ensureOnlineRun } from '../../src/application/runs.ts';
import { loadPolicy } from './helpers.ts';

const cfg = loadConfig(resolve(import.meta.dirname, '../..'));
const policy = loadPolicy();

const runCount = (db: ReturnType<typeof openDatabase>): number => (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;

test('online run is continued after a crash and reopened after a clean stop', () => {
  const db = openDatabase(':memory:');
  const a = ensureOnlineRun(db, cfg, policy, 1_000);
  assert.equal(a.resumed, false);
  assert.equal(a.run.status, 'running');
  // crash: the run is still open and is simply continued
  const b = ensureOnlineRun(db, cfg, policy, 2_000);
  assert.equal(b.resumed, true);
  assert.equal(b.run.runId, a.run.runId);
  assert.equal(b.reopenedFrom, null);
  // clean stop marks the run paused with an end time; the next start reopens that same run
  endRun(db, a.run.runId, 'paused', 3_000);
  assert.equal(getRun(db, a.run.runId)!.status, 'paused');
  const c = ensureOnlineRun(db, cfg, policy, 4_000);
  assert.equal(c.resumed, true);
  assert.equal(c.run.runId, a.run.runId);
  assert.equal(c.reopenedFrom, 3_000);
  assert.equal(c.run.status, 'running');
  const stored = getRun(db, a.run.runId)!;
  assert.equal(stored.status, 'running');
  assert.equal(stored.endedAt, null);
  assert.equal(runCount(db), 1);
});

test('policy change starts a new run and supersedes the paused one; other closed runs stay closed', () => {
  const db = openDatabase(':memory:');
  const a = ensureOnlineRun(db, cfg, policy, 1_000);
  endRun(db, a.run.runId, 'paused', 2_000);
  const changed = loadPolicy({ impulseReturnMin: 0.3 });
  assert.notEqual(changed.policyHash, policy.policyHash);
  const b = ensureOnlineRun(db, cfg, changed, 3_000);
  assert.equal(b.resumed, false);
  assert.notEqual(b.run.runId, a.run.runId);
  assert.equal(getRun(db, a.run.runId)!.status, 'superseded');
  assert.equal((b.run.config as { previousRun: string | null }).previousRun, a.run.runId);
  // a run closed with any status other than paused is never reopened
  endRun(db, b.run.runId, 'completed', 4_000);
  const c = ensureOnlineRun(db, cfg, changed, 5_000);
  assert.equal(c.resumed, false);
  assert.notEqual(c.run.runId, b.run.runId);
  assert.equal(getRun(db, b.run.runId)!.status, 'completed');
  assert.equal(runCount(db), 3);
});
