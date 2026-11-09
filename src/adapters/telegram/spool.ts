/**
 * Reads minimized Telegram messages published by the isolated reader process (tools/telegram-reader/reader.py) into the
 * hand-off spool directory. The scanner never holds the Telegram session: it only parses `event-*.json` files, acknowledges
 * the highest consumed sequence in `ack.json` and deletes consumed files. Every field is validated; text is data, not instructions.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SpoolEvent = {
  file: string; seq: number;
  chat: { id: number; title: string; username: string | null };
  message: { id: number; date: number; editDate: number | null; sender: { id: number | null; username: string | null; bot: boolean }; text: string; links: string[]; forward: boolean };
};

export type SpoolHealth = { status: string; updatedAt: number; channels: number; pending: number | null; detail: string | null } | null;

const EVENT_FILE = /^event-(\d{16})\.json$/;
const MAX_FILE_BYTES = 65_536;

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
}

/** Validates one spool payload; returns null for anything malformed (the file is then reported, not consumed). */
export function parseSpoolEvent(file: string, doc: unknown): SpoolEvent | null {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || d['schema'] !== 1) return null;
  const seq = int(d['seq'], 1, 9_999_999_999_999_999);
  const chat = d['chat'] as Record<string, unknown> | undefined;
  const msg = d['message'] as Record<string, unknown> | undefined;
  if (seq === null || !chat || !msg) return null;
  const chatId = int(chat['id'], -9_999_999_999_999, 9_999_999_999_999);
  const msgId = int(msg['id'], 1, 9_999_999_999);
  const date = int(msg['date'], 1_000_000_000, 4_000_000_000);
  if (chatId === null || msgId === null || date === null || typeof msg['text'] !== 'string' || msg['text'].length > 16_384) return null;
  const sender = (msg['sender'] ?? {}) as Record<string, unknown>;
  const links = Array.isArray(msg['links']) ? (msg['links'] as unknown[]).filter((l): l is string => typeof l === 'string' && l.length <= 1000 && /^https?:\/\//.test(l)).slice(0, 50) : [];
  const username = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : null);
  return {
    file, seq,
    chat: { id: chatId, title: typeof chat['title'] === 'string' ? chat['title'].slice(0, 200) : '', username: username(chat['username']) },
    message: {
      id: msgId, date, editDate: int(msg['edit_date'], 1_000_000_000, 4_000_000_000),
      sender: { id: int(sender['id'], -9_999_999_999_999, 9_999_999_999_999), username: username(sender['username']), bot: sender['bot'] === true },
      text: msg['text'], links, forward: msg['forward'] === true,
    },
  };
}

export function readSpool(dir: string, limit = 200): { events: SpoolEvent[]; invalid: string[]; health: SpoolHealth } {
  const out = { events: [] as SpoolEvent[], invalid: [] as string[], health: readSpoolHealth(dir) };
  if (!existsSync(dir)) return out;
  const names = readdirSync(dir).filter((n) => EVENT_FILE.test(n)).sort().slice(0, limit);
  for (const name of names) {
    const path = join(dir, name);
    try {
      const text = readFileSync(path, 'utf8');
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) { out.invalid.push(name); continue; }
      const ev = parseSpoolEvent(name, JSON.parse(text));
      if (!ev || String(ev.seq).padStart(16, '0') !== (name.match(EVENT_FILE) as RegExpMatchArray)[1]) { out.invalid.push(name); continue; }
      out.events.push(ev);
    } catch {
      out.invalid.push(name);
    }
  }
  return out;
}

export function readSpoolHealth(dir: string): SpoolHealth {
  try {
    const h = JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8')) as Record<string, unknown>;
    return {
      status: typeof h['status'] === 'string' ? h['status'].slice(0, 40) : 'UNKNOWN', updatedAt: int(h['updatedAt'], 0, 9_999_999_999_999) ?? 0,
      channels: int(h['channels'], 0, 1000) ?? 0, pending: int(h['pending'], 0, 1_000_000), detail: typeof h['detail'] === 'string' ? h['detail'].slice(0, 200) : null,
    };
  } catch { return null; }
}

/** Records the next sequence the reader may discard, then removes the consumed files. */
export function ackSpool(dir: string, nextSeq: number, consumed: readonly string[], now: number): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.ack-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ schema: 1, nextSeq, updatedAt: now }), { mode: 0o640 });
  chmodSync(tmp, 0o640); // the reader runs as another user in the same group; the process umask must not hide the file
  renameSync(tmp, join(dir, 'ack.json'));
  for (const name of consumed) {
    try { unlinkSync(join(dir, name)); } catch { /* already gone */ }
  }
}
