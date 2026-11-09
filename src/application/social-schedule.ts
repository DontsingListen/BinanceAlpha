/**
 * X polling cadence (ADR 0003): fixed wall-clock times in an IANA time zone (production: twice a day), or a plain interval.
 * Whether a poll is due is derived from the stored poll attempts, so a restart never adds a billed request; failed attempts
 * retry after a delay and are capped per slot. Pure functions, no I/O.
 */

export type PollSchedule = { readonly times: readonly string[]; readonly timeZone: string };
export type PollCadence = { readonly kind: 'schedule'; readonly schedule: PollSchedule } | { readonly kind: 'interval'; readonly intervalMs: number };
export type PollAttempt = { readonly startedAt: number; readonly outcome: string };
export type PollDecisionReason = 'SLOT_OPEN' | 'RETRY' | 'BEFORE_SLOT' | 'SLOT_DONE' | 'RETRY_WAIT' | 'ATTEMPTS_EXHAUSTED';
export type PollDecision = { due: boolean; reason: PollDecisionReason; slotAt: number; nextAt: number; lastSettledAt: number | null; attemptsForSlot: number };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

export function parseSchedule(raw: unknown): PollSchedule {
  const doc = (raw ?? {}) as { times?: unknown; timeZone?: unknown };
  const times = Array.isArray(doc.times) ? doc.times : [];
  if (!times.length || times.length > 12 || !times.every((t) => typeof t === 'string' && TIME.test(t))) throw new Error('social.x.schedule.times must be 1..12 "HH:MM" entries');
  const unique = [...new Set(times as string[])].sort();
  if (unique.length !== times.length) throw new Error('social.x.schedule.times must be unique');
  const timeZone = typeof doc.timeZone === 'string' ? doc.timeZone : '';
  if (!timeZone || !isValidTimeZone(timeZone)) throw new Error(`social.x.schedule.timeZone must be an IANA time zone (got ${JSON.stringify(doc.timeZone)})`);
  return { times: unique, timeZone };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

type WallClock = { y: number; mo: number; d: number; h: number; mi: number; s: number };

export function zonedParts(utcMs: number, timeZone: string): WallClock {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p['year']!, mo: p['month']!, d: p['day']!, h: p['hour']!, mi: p['minute']!, s: p['second']! };
}

function offsetMs(utcMs: number, timeZone: string): number {
  const p = zonedParts(utcMs, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of the wall-clock time y-mo-d h:mi in the zone. `d` may overflow the month; a DST gap resolves to the post-transition offset. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const guess = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(guess, timeZone);
}

/** The latest scheduled slot at or before `now` and the next one after it (yesterday..tomorrow in the zone always contain both). */
export function scheduleSlots(s: PollSchedule, now: number): { latestAt: number; nextAt: number } {
  const p = zonedParts(now, s.timeZone);
  const slots: number[] = [];
  for (const dayOffset of [-1, 0, 1]) {
    for (const t of s.times) {
      const [h, mi] = t.split(':').map(Number) as [number, number];
      slots.push(zonedToUtc(p.y, p.mo, p.d + dayOffset, h, mi, s.timeZone));
    }
  }
  slots.sort((a, b) => a - b);
  return { latestAt: slots.filter((x) => x <= now).at(-1)!, nextAt: slots.find((x) => x > now)! };
}

/** Longest gap between consecutive scheduled polls, wrapping past midnight (nominal day; DST shifts are within an hour). */
export function maxGapMs(s: PollSchedule): number {
  const mins = s.times.map((t) => { const [h, mi] = t.split(':').map(Number) as [number, number]; return h * 60 + mi; }).sort((a, b) => a - b);
  let max = 1440 - mins[mins.length - 1]! + mins[0]!;
  for (let i = 1; i < mins.length; i++) max = Math.max(max, mins[i]! - mins[i - 1]!);
  return max * 60_000;
}

/** A poll that produced a stored response (complete or truncated) settles its slot; transport/API failures do not. */
export const isSettled = (outcome: string): boolean => outcome === 'OK' || outcome.startsWith('INCOMPLETE');

export function describeCadence(c: PollCadence): string {
  return c.kind === 'schedule' ? `at ${c.schedule.times.join(', ')} ${c.schedule.timeZone}` : `every ${Math.round(c.intervalMs / 60_000)} min`;
}

/** Decides whether an X poll is due. `attempts` are the stored polls of this kind, newest first, any outcome. */
export function decidePoll(o: { cadence: PollCadence; now: number; attempts: readonly PollAttempt[]; retryDelayMs: number; maxAttemptsPerSlot: number }): PollDecision {
  const lastSettledAt = o.attempts.find((a) => isSettled(a.outcome))?.startedAt ?? null;
  let slotAt: number;
  let nextAt: number;
  if (o.cadence.kind === 'schedule') {
    ({ latestAt: slotAt, nextAt } = scheduleSlots(o.cadence.schedule, o.now));
  } else {
    const iv = o.cadence.intervalMs;
    const oldest = o.attempts[o.attempts.length - 1];
    slotAt = lastSettledAt === null ? (oldest ? oldest.startedAt : o.now) : lastSettledAt + iv;
    const failedSince = o.attempts.filter((a) => a.startedAt >= slotAt);
    if (failedSince.length >= o.maxAttemptsPerSlot) slotAt = failedSince[0]!.startedAt + iv; // back off a full interval after exhausting retries
    nextAt = slotAt > o.now ? slotAt : o.now + iv;
  }
  const attemptsForSlot = o.attempts.filter((a) => a.startedAt >= slotAt).length;
  const base = { slotAt, nextAt, lastSettledAt, attemptsForSlot };
  if (slotAt > o.now) return { due: false, reason: 'BEFORE_SLOT', ...base };
  if (lastSettledAt !== null && lastSettledAt >= slotAt) return { due: false, reason: 'SLOT_DONE', ...base };
  if (attemptsForSlot >= o.maxAttemptsPerSlot) return { due: false, reason: 'ATTEMPTS_EXHAUSTED', ...base };
  const newest = o.attempts[0];
  if (newest && newest.startedAt >= slotAt && o.now - newest.startedAt < o.retryDelayMs) return { due: false, reason: 'RETRY_WAIT', ...base, nextAt: newest.startedAt + o.retryDelayMs };
  return { due: true, reason: attemptsForSlot ? 'RETRY' : 'SLOT_OPEN', ...base };
}
