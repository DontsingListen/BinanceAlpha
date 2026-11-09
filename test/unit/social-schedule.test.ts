import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decidePoll, maxGapMs, parseSchedule, scheduleSlots, zonedToUtc } from '../../src/application/social-schedule.ts';
import { loadSocialConfig } from '../../src/application/social-config.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const NY = parseSchedule({ times: ['22:00', '10:00'], timeZone: 'America/New_York' });
const H = 3_600_000;

test('schedule: wall-clock slots follow the zone (incl. DST); longest gap wraps midnight; invalid entries rejected', () => {
  assert.deepEqual(NY.times, ['10:00', '22:00']);
  assert.equal(zonedToUtc(2026, 11, 7, 10, 0, 'America/New_York'), Date.UTC(2026, 10, 7, 15, 0)); // EST
  assert.equal(zonedToUtc(2026, 7, 1, 10, 0, 'America/New_York'), Date.UTC(2026, 6, 1, 14, 0)); // EDT
  assert.equal(zonedToUtc(2026, 11, 7, 10, 0, 'Asia/Shanghai'), Date.UTC(2026, 10, 7, 2, 0));
  assert.equal(zonedToUtc(2026, 10, 32, 10, 0, 'Asia/Shanghai'), Date.UTC(2026, 10, 1, 2, 0)); // day overflow normalizes
  const now = Date.UTC(2026, 10, 7, 4, 0); // 23:00 EST, Nov 6
  const s = scheduleSlots(NY, now);
  assert.equal(s.latestAt, Date.UTC(2026, 10, 7, 3, 0)); // 22:00 EST Nov 6
  assert.equal(s.nextAt, Date.UTC(2026, 10, 7, 15, 0)); // 10:00 EST Nov 7
  assert.equal(maxGapMs(NY), 12 * H);
  assert.equal(maxGapMs(parseSchedule({ times: ['09:00', '12:00'], timeZone: 'UTC' })), 21 * H);
  assert.throws(() => parseSchedule({ times: ['24:00'], timeZone: 'UTC' }), /HH:MM/);
  assert.throws(() => parseSchedule({ times: ['10:00', '10:00'], timeZone: 'UTC' }), /unique/);
  assert.throws(() => parseSchedule({ times: ['10:00'], timeZone: 'Mars/Olympus' }), /IANA/);
});

test('decidePoll: one billed poll per slot, restart-safe, failures retried after a delay and capped per slot', () => {
  const now = Date.UTC(2026, 10, 7, 4, 0);
  const slot = Date.UTC(2026, 10, 7, 3, 0);
  const base = { cadence: { kind: 'schedule' as const, schedule: NY }, now, retryDelayMs: 30 * 60_000, maxAttemptsPerSlot: 3 };
  assert.equal(decidePoll({ ...base, attempts: [] }).reason, 'SLOT_OPEN');
  assert.equal(decidePoll({ ...base, attempts: [{ startedAt: slot - 12 * H, outcome: 'OK' }] }).due, true); // previous slot settled, this one open
  const done = decidePoll({ ...base, attempts: [{ startedAt: slot + 60_000, outcome: 'INCOMPLETE_MAX_TURNS' }] });
  assert.deepEqual([done.due, done.reason, done.nextAt], [false, 'SLOT_DONE', Date.UTC(2026, 10, 7, 15, 0)]);
  const fail = (ago: number) => ({ startedAt: now - ago, outcome: 'XAI_TIMEOUT' });
  const wait = decidePoll({ ...base, attempts: [fail(5 * 60_000)] });
  assert.deepEqual([wait.reason, wait.nextAt], ['RETRY_WAIT', now + 25 * 60_000]);
  assert.equal(decidePoll({ ...base, attempts: [fail(31 * 60_000)] }).reason, 'RETRY');
  assert.equal(decidePoll({ ...base, attempts: [fail(31 * 60_000), fail(45 * 60_000), fail(59 * 60_000)] }).reason, 'ATTEMPTS_EXHAUSTED');
  const iv = { cadence: { kind: 'interval' as const, intervalMs: H }, now, retryDelayMs: 30 * 60_000, maxAttemptsPerSlot: 3 };
  assert.equal(decidePoll({ ...iv, attempts: [] }).reason, 'SLOT_OPEN');
  assert.equal(decidePoll({ ...iv, attempts: [{ startedAt: now - 30 * 60_000, outcome: 'OK' }] }).reason, 'BEFORE_SLOT');
  assert.equal(decidePoll({ ...iv, attempts: [{ startedAt: now - 61 * 60_000, outcome: 'OK' }] }).reason, 'SLOT_OPEN');
  assert.equal(decidePoll({ ...iv, attempts: [fail(31 * 60_000), fail(45 * 60_000), fail(59 * 60_000)] }).reason, 'BEFORE_SLOT'); // backed off a full interval
});

test('social config: schedule cadence needs a lookback covering the longest gap; interval mode remains the fallback; shipped config is valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-social-sched-'));
  const path = join(dir, 'social.json');
  const write = (x: Record<string, unknown>) => writeFileSync(path, JSON.stringify({ x: { enabled: true, handles: ['fixture_alpha'], ...x } }));
  write({ schedule: { times: ['10:00', '22:00'], timeZone: 'America/New_York' }, lookbackMs: 3 * H });
  assert.throws(() => loadSocialConfig(ROOT, { socialConfig: path }), /lookbackMs/);
  write({ schedule: { times: ['10:00', '22:00'], timeZone: 'America/New_York' }, lookbackMs: 13 * H });
  const scheduled = loadSocialConfig(ROOT, { socialConfig: path });
  assert.deepEqual(scheduled.x.cadence, { kind: 'schedule', schedule: { times: ['10:00', '22:00'], timeZone: 'America/New_York' } });
  assert.deepEqual([scheduled.x.retryDelayMs, scheduled.x.maxAttemptsPerSlot], [30 * 60_000, 3]);
  write({ pollIntervalMs: 15 * 60_000 });
  assert.deepEqual(loadSocialConfig(ROOT, { socialConfig: path }).x.cadence, { kind: 'interval', intervalMs: 15 * 60_000 });
  const shipped = loadSocialConfig(ROOT, { socialConfig: 'config/social.example.json' });
  assert.equal(shipped.x.cadence.kind, 'schedule');
  assert.equal(shipped.x.handles.length, 0);
  assert.equal(shipped.x.enabled, false);
  assert.equal(shipped.telegram.enabled, false);
  const defaults = loadSocialConfig(dir);
  assert.equal(defaults.x.enabled, false);
  assert.equal(defaults.telegram.enabled, false);
});
