#!/usr/bin/env python3
"""Allow-listed, read-only Telegram user-session reader for BinanceAlpha (ADR 0003).

Adapted from a prior internal reader: a dedicated Unix user holds API ID/Hash, the session and cursors under PRIVATE;
only explicitly added channels/groups are read; minimized messages are published as `event-<seq>.json` files in the
SPOOL hand-off directory, which the Node `alpha social` process consumes and acknowledges (`ack.json`). Never log
account secrets. No messages are sent, no chats enumerated, no groups joined.
"""
import asyncio
import fcntl
import getpass
import hashlib
import html
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import unicodedata
import uuid

PRIVATE = Path(os.environ.get('ALPHA_TG_PRIVATE', '/var/lib/binance-alpha-telegram/private'))
SPOOL = Path(os.environ.get('ALPHA_TG_SPOOL', '/var/lib/binance-alpha/telegram-inbox'))
MAX_CHANNELS = 10
MAX_TEXT = 16384
MAX_OUTBOX = 3000
SCHEMA = 1


# ---------------------------------------------------------------- small helpers

def atomic_json(file, value, mode=0o600):
    temporary = file.parent / ('.' + file.name + '-' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as stream:
            json.dump(value, stream, ensure_ascii=True)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, file)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(file, fallback=None):
    if not file.exists() and fallback is not None:
        return fallback
    if file.is_symlink() or file.stat().st_size > 65536:
        raise ValueError('INVALID_STATE_FILE')
    return json.loads(file.read_text('utf8'))


def normalize_phone(value):
    """Normalize formatting only; never guess a missing international country code."""
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError('INVALID_PHONE_FORMAT')
    phone = unicodedata.normalize('NFKC', html.unescape(value))
    phone = re.sub(r'[\s()\-​‎‏﻿]', '', phone)
    if not re.fullmatch(r'\+[1-9][0-9]{6,14}', phone):
        raise ValueError('INVALID_PHONE_FORMAT')
    return phone


def login_status(phase, error_class=None):
    value = {'phase': phase, 'updatedAt': int(time.time() * 1000)}
    if error_class and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', error_class):
        value['errorClass'] = error_class
    atomic_json(PRIVATE / 'login-status.json', value)


def confirm(prompt):
    while True:
        answer = unicodedata.normalize('NFKC', input(prompt)).strip().casefold()
        if answer == 'yes':
            return True
        if answer in ('', 'no'):
            login_status('CANCELLED')
            print('已取消；账号登录保留，未新增监听频道。')
            return False
        print('请输入 yes 确认（不区分大小写），或 no 取消。')


def ensure_spool_directory(directory):
    directory.mkdir(mode=0o770, exist_ok=True)
    current = directory.lstat()
    if not stat.S_ISDIR(current.st_mode):
        raise ValueError('INVALID_SPOOL_DIRECTORY')
    if stat.S_IMODE(current.st_mode) != 0o2770:
        os.chmod(directory, 0o2770)


# ---------------------------------------------------------------- configuration

def configure_api(value):
    if (not isinstance(value, dict) or type(value.get('apiId')) is not int
            or not re.fullmatch(r'[1-9]\d{2,12}', str(value['apiId']))
            or not re.fullmatch(r'[a-fA-F0-9]{32}', value.get('apiHash', ''))):
        raise ValueError('INVALID_API_CONFIGURATION')
    safe = {'apiId': value['apiId'], 'apiHash': value['apiHash']}
    previous = read_json(PRIVATE / 'api.json', {})
    if previous and previous != safe:
        raise ValueError('EXISTING_API_CONFIGURATION_DIFFERS')
    if not previous:
        atomic_json(PRIVATE / 'api.json', safe)
    print('API_CONFIGURATION_SAVED' if not previous else 'API_CONFIGURATION_ALREADY_MATCHES')


def configure_phone(value):
    if not isinstance(value, dict):
        raise ValueError('INVALID_PHONE_FORMAT')
    phone = normalize_phone(value.get('phone'))
    previous = read_json(PRIVATE / 'login-phone.json', {})
    if previous and previous.get('phone') != phone:
        raise ValueError('EXISTING_PHONE_CONFIGURATION_DIFFERS')
    if not previous:
        atomic_json(PRIVATE / 'login-phone.json', {'phone': phone})
    print('PHONE_CONFIGURATION_SAVED')


def configured_channels(config):
    channels = config.get('channels') if config.get('schema') == SCHEMA else None
    if not isinstance(channels, list) or len(channels) > MAX_CHANNELS:
        raise ValueError('INVALID_CHANNEL_CONFIGURATION')
    for c in channels:
        if not re.fullmatch(r'[a-f0-9]{32}', c.get('scope', '')) or not re.fullmatch(r'-?\d{1,20}', str(c.get('chatId', ''))):
            raise ValueError('INVALID_CHANNEL_CONFIGURATION')
    if len({c['scope'] for c in channels}) != len(channels) or len({c['chatId'] for c in channels}) != len(channels):
        raise ValueError('DUPLICATE_CHANNEL')
    return channels


def publish_scope(config):
    channels = configured_channels(config)
    ensure_spool_directory(SPOOL)
    atomic_json(SPOOL / 'channels.json', {'schema': SCHEMA, 'channels': [
        {'scope': c['scope'], 'chatId': c['chatId'], 'title': c.get('title', ''), 'username': c.get('username'), 'enabledAt': c['enabledAt']} for c in channels]}, 0o640)


# ---------------------------------------------------------------- message minimization

def entity_links(message):
    text = getattr(message, 'message', '') or ''
    links = []
    for entity in (getattr(message, 'entities', None) or [])[:100]:
        kind = type(entity).__name__
        if kind == 'MessageEntityTextUrl':
            links.append(entity.url)
        elif kind == 'MessageEntityUrl':
            try:
                links.append(text.encode('utf-16-le')[entity.offset * 2:(entity.offset + entity.length) * 2].decode('utf-16-le'))
            except (UnicodeError, AttributeError):
                pass
    for row in (getattr(getattr(message, 'reply_markup', None), 'rows', None) or [])[:30]:
        for button in (getattr(row, 'buttons', None) or [])[:10]:
            if getattr(button, 'url', None):
                links.append(button.url)
    out = []
    for link in links[:100]:
        if isinstance(link, str) and len(link) <= 1000 and re.match(r'https?://', link) and link not in out:
            out.append(link)
    return out[:50]


def minimal_message(message, channel, now):
    """Keep ids, time, sender id/username, text and links. Drop names, media, own/outgoing and pre-enable messages."""
    chat_id = getattr(message, 'chat_id', None)
    if str(chat_id) != str(channel['chatId']):
        return None
    if not isinstance(message.id, int) or message.id <= channel['startId']:
        return None
    if getattr(message, 'out', False):
        return None
    at = int(message.date.timestamp())
    if at < channel['enabledAt'] // 1000 or at > now + 30:
        return None
    text = getattr(message, 'message', '') or ''
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        return None
    links = entity_links(message)
    if not text.strip() and not links:
        return None  # media-only or empty
    sender = getattr(message, 'sender', None)
    sender_id = getattr(message, 'sender_id', None)
    username = getattr(sender, 'username', None) if sender is not None else None
    if not (isinstance(username, str) and re.fullmatch(r'[A-Za-z0-9_]{1,64}', username)):
        username = None
    result = {
        'schema': SCHEMA, 'seq': 0,
        'chat': {'id': int(channel['chatId']), 'title': str(channel.get('title', ''))[:200], 'username': channel.get('username')},
        'message': {
            'id': message.id, 'date': at,
            'edit_date': int(message.edit_date.timestamp()) if getattr(message, 'edit_date', None) else None,
            'sender': {'id': int(sender_id) if isinstance(sender_id, int) else None, 'username': username, 'bot': bool(getattr(sender, 'bot', False)) if sender is not None else False},
            'text': text, 'links': links,
            'forward': bool(getattr(message, 'fwd_from', None)),
            'reply_to_id': getattr(getattr(message, 'reply_to', None), 'reply_to_msg_id', None),
        },
    }
    return result


class Queue:
    """Durable outbox + per-channel cursors; `publish` materializes outbox rows as spool files and prunes acknowledged ones."""

    def __init__(self, directory):
        self.db = sqlite3.connect(directory / 'reader.sqlite')
        self.db.executescript('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
                              'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);'
                              'CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,fingerprint TEXT UNIQUE,payload TEXT);'
                              'CREATE TABLE IF NOT EXISTS seen(fingerprint TEXT PRIMARY KEY,at INTEGER);')

    def get(self, key, default=0):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return int(row[0]) if row else default

    def set(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, str(value)))

    def pending(self):
        return self.db.execute('SELECT count(*) FROM outbox').fetchone()[0]

    def collect(self, messages, channel, now, advance=True):
        key = 'lastId:' + channel['scope']
        with self.db:
            for message in messages:
                normalized = minimal_message(message, channel, now)
                if normalized:
                    payload = json.dumps(normalized, sort_keys=True)
                    fingerprint = hashlib.sha256(payload.encode()).hexdigest()
                    if self.db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (fingerprint, now)).rowcount:
                        self.db.execute('INSERT INTO outbox(fingerprint,payload) VALUES (?,?)', (fingerprint, payload))
                if advance and isinstance(message.id, int):
                    self.set(key, max(self.get(key), message.id))

    def publish(self, spool):
        ack = read_json(spool / 'ack.json', {}) if (spool / 'ack.json').exists() else {}
        next_seq = ack.get('nextSeq', 0) if ack.get('schema') == SCHEMA else 0
        maximum = self.db.execute("SELECT seq FROM sqlite_sequence WHERE name='outbox'").fetchone()
        if type(next_seq) is int and 0 <= next_seq <= (maximum[0] + 1 if maximum else 0):
            with self.db:
                self.db.execute('DELETE FROM outbox WHERE seq<?', (next_seq,))
        for seq, payload in self.db.execute('SELECT seq,payload FROM outbox ORDER BY seq LIMIT 100'):
            file = spool / f'event-{seq:016d}.json'
            if not file.exists():
                value = json.loads(payload)
                value['seq'] = seq
                atomic_json(file, value, 0o640)


# ---------------------------------------------------------------- telegram client

def client_for(api):
    from telethon import TelegramClient
    from telethon.sessions import SQLiteSession
    session = SQLiteSession(str(PRIVATE / 'account'))
    session.save_entities = False
    # request_retries must be >= 1: Telegram answers the first auth request for a phone on another data center with
    # PHONE_MIGRATE_X; Telethon switches DC and needs one more attempt, otherwise it raises a bare ValueError.
    return TelegramClient(session, api['apiId'], api['apiHash'], receive_updates=False, catch_up=False,
                          request_retries=2, connection_retries=1, auto_reconnect=False, flood_sleep_threshold=0,
                          device_model='BinanceAlpha Read-only', app_version='1.0')


def peer_for(channel):
    from telethon.tl.types import InputPeerChannel, InputPeerChat
    peer = channel['peer']
    if peer['type'] == 'channel':
        return InputPeerChannel(peer['id'], peer['accessHash'])
    return InputPeerChat(peer['id'])


def pending_code(phone):
    pending = read_json(PRIVATE / 'pending-code.json', {})
    if (pending.get('phone') == phone and pending.get('expiresAt', 0) > time.time()
            and isinstance(pending.get('phoneCodeHash'), str) and pending['phoneCodeHash']):
        return pending
    return None


def prompt_phone():
    preset = read_json(PRIVATE / 'login-phone.json', {}).get('phone', '')
    if preset:
        preset = normalize_phone(preset)
    while True:
        login_status('AWAITING_PHONE_CONFIRMATION' if preset else 'AWAITING_PHONE')
        prompt = (f'已预填手机号（尾号 {preset[-4:]}）。按回车使用，或输入其他带国家区号的号码（不回显）： '
                  if preset else '手机号（带 +国家区号；输入不回显）： ')
        entered = getpass.getpass(prompt)
        try:
            return normalize_phone(entered if entered.strip() else preset)
        except ValueError:
            print('手机号格式不正确。请包含 +国家区号。')


async def request_login_code(client, phone):
    from telethon import functions, types
    pending = pending_code(phone)
    if pending:
        return pending
    request_state = read_json(PRIVATE / 'auth-request.json', {})
    if request_state.get('nextRequestAt', 0) > time.time():
        raise ValueError('CODE_REQUEST_WAIT_90_SECONDS')
    atomic_json(PRIVATE / 'auth-request.json', {'nextRequestAt': time.time() + 90})
    login_status('REQUESTING_CODE')
    print('正在向 Telegram 请求验证码……')
    try:
        result = await client(functions.auth.SendCodeRequest(phone.lstrip('+'), client.api_id, client.api_hash, types.CodeSettings()))
    except ValueError as error:
        # Telethon raises a bare ValueError when a request exhausts its retries (e.g. repeated data-center migration).
        login_status('CODE_REQUEST_FAILED', type(error).__name__)
        raise ValueError('CODE_REQUEST_FAILED_RETRY_LOGIN') from None
    phone_hash = getattr(result, 'phone_code_hash', None)
    if not isinstance(phone_hash, str) or not phone_hash:
        login_status('CODE_DELIVERY_UNAVAILABLE', type(result).__name__)
        raise ValueError('CODE_DELIVERY_RESPONSE_UNSUPPORTED')
    pending = {'phone': phone, 'phoneCodeHash': phone_hash, 'expiresAt': time.time() + 300}
    atomic_json(PRIVATE / 'pending-code.json', pending)
    login_status('AWAITING_CODE')
    return pending


async def sign_in_with_code(client, phone, pending):
    from telethon import errors
    for _ in range(3):
        login_status('AWAITING_CODE')
        entered = getpass.getpass('请输入 Telegram 最新登录验证码（不回显；不要发到聊天里）： ')
        code = re.sub(r'\s', '', unicodedata.normalize('NFKC', entered))
        if not re.fullmatch(r'[0-9]{4,10}', code):
            print('请输入收到的数字验证码；不能留空。本次不会重新发送验证码。')
            continue
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=pending['phoneCodeHash'])
            return
        except errors.PhoneCodeInvalidError:
            print('验证码无效，请核对后重新输入；未重新发送。')
        except errors.PhoneCodeExpiredError:
            atomic_json(PRIVATE / 'pending-code.json', {})
            raise ValueError('LOGIN_CODE_EXPIRED_REOPEN_LOGIN') from None
        except errors.SessionPasswordNeededError:
            login_status('AWAITING_PASSWORD')
            await client.sign_in(password=getpass.getpass('请输入 Telegram 两步验证密码（不回显）： '))
            return
    raise ValueError('CODE_ATTEMPTS_STOPPED_REOPEN_LOGIN')


async def resolve_target(client, target):
    """Resolve a public @username / t.me link / existing invite link to an entity the account already has access to."""
    from telethon import functions, types
    invite = re.fullmatch(r'https://t\.me/(?:\+|joinchat/)([A-Za-z0-9_-]+)', target)
    if invite:
        result = await client(functions.messages.CheckChatInviteRequest(invite.group(1)))
        if not isinstance(result, types.ChatInviteAlready):
            raise ValueError('JOIN_TARGET_CHANNEL_MANUALLY_FIRST')
        return result.chat
    public = re.fullmatch(r'(?:https://t\.me/)?@?([A-Za-z][A-Za-z0-9_]{3,31})/?', target)
    if public:
        return await client.get_entity(public.group(1))
    raise ValueError('USE_CHANNEL_USERNAME_OR_EXISTING_INVITE_LINK')


async def add_channel_interactive(client, existing, me):
    from telethon import types, utils
    channels = configured_channels(existing) if existing else []
    if len(channels) >= MAX_CHANNELS:
        raise ValueError('CHANNEL_LIMIT_REVIEW_REQUIRED')
    login_status('AWAITING_CHANNEL')
    target = getpass.getpass('频道/群组 @username、t.me 链接或已加入的 t.me/+ 邀请链接（不回显）： ').strip()
    entity = await resolve_target(client, target)
    if not isinstance(entity, (types.Chat, types.Channel)):
        raise ValueError('CHANNEL_OR_GROUP_REQUIRED')
    chat_id = str(utils.get_peer_id(entity))
    if any(c['chatId'] == chat_id for c in channels):
        raise ValueError('DUPLICATE_CHANNEL')
    kind = 'channel' if isinstance(entity, types.Channel) and not entity.megagroup else 'group'
    print(f'Selected {kind}:', entity.title)
    login_status('AWAITING_CHANNEL_CONFIRMATION')
    if not confirm('输入 yes 允许只读监听此频道/群组的新消息，no 取消： '):
        return None
    channel = {'scope': uuid.uuid4().hex, 'chatId': chat_id, 'title': entity.title, 'username': getattr(entity, 'username', None),
               'kind': kind, 'enabledAt': int(time.time() * 1000),
               'peer': {'type': 'channel', 'id': entity.id, 'accessHash': entity.access_hash} if isinstance(entity, types.Channel) else {'type': 'chat', 'id': entity.id}}
    latest = await client.get_messages(peer_for(channel), limit=1)
    channel['startId'] = latest[0].id if latest else 0
    queue = Queue(PRIVATE)
    with queue.db:
        queue.set('lastId:' + channel['scope'], channel['startId'])
    queue.db.close()
    envelope = {'schema': SCHEMA, 'accountId': me.id, 'channels': [*channels, channel]}
    atomic_json(PRIVATE / 'config.json', envelope)
    publish_scope(envelope)
    login_status('COMPLETE')
    print(f'Channel added ({len(envelope["channels"])}/{MAX_CHANNELS}). Only NEW messages after now are read.')
    return envelope


async def login(add_channel=False):
    from telethon import errors
    if not sys.stdin.isatty():
        raise ValueError('INTERACTIVE_TERMINAL_REQUIRED')
    existing = read_json(PRIVATE / 'config.json', {})
    retry = read_json(PRIVATE / 'auth-cooldown.json', {}).get('retryAt', 0)
    if retry > time.time():
        print('Telegram login cooldown active. Retry later; no code requested.')
        return False
    print('Only explicitly allow-listed channels/groups are read. The session grants account-level access; a dedicated account is recommended.')
    api = read_json(PRIVATE / 'api.json', {})
    if not api:
        print('Get your own API ID and API Hash at https://my.telegram.org/apps . Never enter a Bot Token here.')
        api_id = input('API ID: ').strip()
        api_hash = getpass.getpass('API Hash (hidden): ').strip()
        if not re.fullmatch(r'[1-9]\d{2,12}', api_id) or not re.fullmatch(r'[a-fA-F0-9]{32}', api_hash):
            raise ValueError('INVALID_API_CONFIGURATION')
        api = {'apiId': int(api_id), 'apiHash': api_hash}
        atomic_json(PRIVATE / 'api.json', api)
    client = client_for(api)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            preset = read_json(PRIVATE / 'login-phone.json', {}).get('phone', '')
            pending = pending_code(preset) if preset else None
            phone = preset if pending else prompt_phone()
            if not pending:
                pending = await request_login_code(client, phone)
            await sign_in_with_code(client, phone, pending)
        me = await client.get_me()
        if not me or me.bot:
            raise ValueError('USER_ACCOUNT_REQUIRED')
        if (PRIVATE / 'pending-code.json').exists():
            atomic_json(PRIVATE / 'pending-code.json', {})
        print('Account login verified. No chats or contacts have been listed.')
        login_status('ACCOUNT_VERIFIED')
        if existing and existing.get('accountId') != me.id:
            raise ValueError('EXISTING_ACCOUNT_MISMATCH')
        if existing and existing.get('channels') and not add_channel:
            print(f'{len(existing["channels"])} channel(s) already configured; configuration retained.')
            publish_scope(existing)
            login_status('COMPLETE')
            return True
        return (await add_channel_interactive(client, existing, me)) is not None
    except errors.FloodWaitError as error:
        atomic_json(PRIVATE / 'auth-cooldown.json', {'retryAt': time.time() + error.seconds})
        login_status('AUTH_COOLDOWN')
        print('Telegram requested a login cooldown. Seconds:', error.seconds)
        return False
    finally:
        await client.disconnect()


def list_channels():
    config = read_json(PRIVATE / 'config.json', {})
    for c in (configured_channels(config) if config else []):
        print(json.dumps({'scope': c['scope'], 'chatId': c['chatId'], 'title': c.get('title'), 'username': c.get('username'), 'kind': c.get('kind'), 'enabledAt': c['enabledAt']}, ensure_ascii=False))
    return 0


async def diagnose_connection():
    from telethon import errors
    retry = read_json(PRIVATE / 'auth-cooldown.json', {}).get('retryAt', 0)
    if retry > time.time():
        print(json.dumps({'status': 'AUTH_COOLDOWN', 'retryAt': retry}))
        return 78
    client = client_for(read_json(PRIVATE / 'api.json'))
    try:
        await client.connect()
        print(json.dumps({'connected': True, 'authorized': bool(await client.is_user_authorized())}))
        return 0
    except errors.FloodWaitError as error:
        atomic_json(PRIVATE / 'auth-cooldown.json', {'retryAt': time.time() + error.seconds})
        print(json.dumps({'connected': False, 'errorClass': type(error).__name__}))
        return 78
    except Exception as error:
        print(json.dumps({'connected': False, 'errorClass': type(error).__name__}))
        return 78
    finally:
        await client.disconnect()


async def run_reader():
    from telethon import errors
    config = read_json(PRIVATE / 'config.json')
    channels = configured_channels(config)
    publish_scope(config)
    client = client_for(read_json(PRIVATE / 'api.json'))
    queue = Queue(PRIVATE)

    def health(status, detail=None):
        atomic_json(SPOOL / 'health.json', {'status': status, 'updatedAt': int(time.time() * 1000), 'channels': len(channels),
                    'pending': queue.pending(), 'retryAt': queue.get('retryAt'), 'detail': detail}, 0o640)
    turn = 0
    try:
        while True:
            now = int(time.time())
            if queue.get('retryAt') > now * 1000:
                health('COOLDOWN')
                await asyncio.sleep(min(60, max(1, queue.get('retryAt') / 1000 - now)))
                continue
            channel = channels[turn % len(channels)]
            turn += 1
            try:
                if not client.is_connected():
                    await client.connect()
                    if not await client.is_user_authorized():
                        health('AUTH_REQUIRED')
                        return 78
                queue.publish(SPOOL)
                if queue.get('channelRetryAt:' + channel['scope']) > now * 1000:
                    health('CHANNEL_ACCESS_REQUIRED', channel.get('title'))
                    await asyncio.sleep(1)
                    continue
                if queue.pending() >= MAX_OUTBOX:
                    health('BACKPRESSURE')
                    await asyncio.sleep(5)
                    continue
                messages = await client.get_messages(peer_for(channel), min_id=queue.get('lastId:' + channel['scope'], channel['startId']), reverse=True, limit=100)
                queue.collect(messages, channel, now)
                if now - queue.get('lastEditCheck:' + channel['scope']) >= 120:
                    recent = await client.get_messages(peer_for(channel), limit=20)
                    queue.collect(recent, channel, now, advance=False)
                    with queue.db:
                        queue.set('lastEditCheck:' + channel['scope'], now)
                        queue.db.execute('DELETE FROM seen WHERE at<?', (now - 7 * 86400,))
                queue.publish(SPOOL)
                health('BACKLOG' if len(messages) == 100 else 'POLLING')
            except errors.FloodWaitError as error:
                with queue.db:
                    queue.set('retryAt', int((time.time() + error.seconds + 1) * 1000))
                health('COOLDOWN', type(error).__name__)
            except errors.UnauthorizedError:
                health('AUTH_REQUIRED')
                return 78
            except (errors.ForbiddenError, errors.ChannelPrivateError):
                with queue.db:
                    queue.set('channelRetryAt:' + channel['scope'], int((time.time() + 300) * 1000))
                health('CHANNEL_ACCESS_REQUIRED', channel.get('title'))
            except Exception as error:
                with queue.db:
                    queue.set('retryAt', int((time.time() + 60) * 1000))
                health('SOURCE_READ_ERROR', type(error).__name__)
                await client.disconnect()
            await asyncio.sleep(max(1, 5 / len(channels)))
    finally:
        queue.db.close()
        await client.disconnect()


SAFE_CODES = {'INVALID_API_CONFIGURATION', 'INVALID_PHONE_FORMAT', 'USER_ACCOUNT_REQUIRED', 'CHANNEL_OR_GROUP_REQUIRED',
              'JOIN_TARGET_CHANNEL_MANUALLY_FIRST', 'USE_CHANNEL_USERNAME_OR_EXISTING_INVITE_LINK', 'INTERACTIVE_TERMINAL_REQUIRED',
              'EXISTING_ACCOUNT_MISMATCH', 'EXISTING_API_CONFIGURATION_DIFFERS', 'INVALID_CHANNEL_CONFIGURATION', 'DUPLICATE_CHANNEL',
              'CHANNEL_LIMIT_REVIEW_REQUIRED', 'EXISTING_PHONE_CONFIGURATION_DIFFERS', 'CODE_REQUEST_WAIT_90_SECONDS',
              'CODE_DELIVERY_RESPONSE_UNSUPPORTED', 'LOGIN_CODE_EXPIRED_REOPEN_LOGIN', 'CODE_ATTEMPTS_STOPPED_REOPEN_LOGIN',
              'CODE_REQUEST_FAILED_RETRY_LOGIN'}
COMMANDS = ('login', 'add-channel', 'list', 'run', 'configure-api', 'configure-phone', 'diagnose')


def main():
    logging.disable(logging.CRITICAL)
    os.umask(0o077)
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print('usage: reader.py ' + '|'.join(COMMANDS))
        return 2
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (PRIVATE / 'account.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Telegram reader or login already running. No second session started.')
            return 78
        try:
            command = sys.argv[1]
            if command == 'configure-api':
                configure_api(json.loads(sys.stdin.read(4097)))
                return 0
            if command == 'configure-phone':
                configure_phone(json.loads(sys.stdin.read(4097)))
                return 0
            if command == 'list':
                return list_channels()
            if command == 'diagnose':
                return asyncio.run(diagnose_connection())
            if command in ('login', 'add-channel'):
                return 0 if asyncio.run(login(add_channel=command == 'add-channel')) else 78
            return asyncio.run(run_reader())
        except KeyboardInterrupt:
            if sys.argv[1] in ('login', 'add-channel'):
                login_status('CANCELLED')
            print('Cancelled. No credentials displayed.')
            return 130
        except Exception as error:
            if sys.argv[1] in ('login', 'add-channel'):
                login_status('SETUP_OR_SESSION_ERROR', type(error).__name__)
            safe_class = type(error).__name__
            safe_class = safe_class if re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', safe_class) else 'UnknownError'
            print(str(error) if str(error) in SAFE_CODES else 'TELEGRAM_SETUP_OR_SESSION_ERROR (' + safe_class + ')')
            return 78


if __name__ == '__main__':
    sys.exit(main())
