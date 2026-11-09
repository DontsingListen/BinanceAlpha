"""Offline tests for the Telegram reader: no network, no Telethon import required."""
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

TMP = tempfile.mkdtemp(prefix='alpha-tg-')
os.environ['ALPHA_TG_PRIVATE'] = str(Path(TMP) / 'private')
os.environ['ALPHA_TG_SPOOL'] = str(Path(TMP) / 'inbox')
sys.path.insert(0, str(Path(__file__).resolve().parent))
import reader  # noqa: E402

NOW = int(time.time())
CHANNEL = {'scope': 'a' * 32, 'chatId': '-1001234', 'title': 'Alpha Calls', 'username': 'alphacalls', 'startId': 10, 'enabledAt': (NOW - 3600) * 1000}


class MessageEntityTextUrl:  # same class name as Telethon's entity; the reader dispatches on the type name
    def __init__(self, url, offset=0, length=1):
        self.url, self.offset, self.length = url, offset, length


def message(mid, text, **extra):
    base = dict(id=mid, chat_id=-1001234, out=False, date=datetime.fromtimestamp(NOW - 30, timezone.utc), message=text, entities=[],
                sender_id=777, sender=SimpleNamespace(username='caller', bot=False), fwd_from=None, edit_date=None, reply_to=None, reply_markup=None)
    base.update(extra)
    return SimpleNamespace(**base)


class ReaderTests(unittest.TestCase):
    def test_normalize_phone(self):
        self.assertEqual(reader.normalize_phone(' +1 (415) 555-0100 '), '+14155550100')
        with self.assertRaises(ValueError):
            reader.normalize_phone('4155550100')  # missing country code is never guessed

    def test_minimal_message_keeps_text_links_and_drops_noise(self):
        m = message(11, '$UAI 二段突破 https://x.com/a/status/1', entities=[MessageEntityTextUrl('https://t.me/alphacalls/5')])
        out = reader.minimal_message(m, CHANNEL, NOW)
        self.assertEqual(out['message']['id'], 11)
        self.assertEqual(out['message']['text'], '$UAI 二段突破 https://x.com/a/status/1')
        self.assertEqual(out['message']['sender'], {'id': 777, 'username': 'caller', 'bot': False})
        self.assertEqual(out['chat'], {'id': -1001234, 'title': 'Alpha Calls', 'username': 'alphacalls'})
        self.assertEqual(out['message']['links'], ['https://t.me/alphacalls/5'])
        self.assertIsNone(reader.minimal_message(message(10, 'old'), CHANNEL, NOW))  # at or before startId
        self.assertIsNone(reader.minimal_message(message(12, 'mine', out=True), CHANNEL, NOW))
        self.assertIsNone(reader.minimal_message(message(13, ''), CHANNEL, NOW))  # media-only
        self.assertIsNone(reader.minimal_message(message(14, 'x', chat_id=-999), CHANNEL, NOW))
        self.assertIsNone(reader.minimal_message(message(15, 'future', date=datetime.fromtimestamp(NOW + 600, timezone.utc)), CHANNEL, NOW))
        fwd = reader.minimal_message(message(16, 'fwd', fwd_from=object()), CHANNEL, NOW)
        self.assertTrue(fwd['message']['forward'])

    def test_queue_publish_ack_and_cursor(self):
        private = Path(TMP) / 'private'
        private.mkdir(parents=True, exist_ok=True)
        spool = Path(TMP) / 'inbox'
        reader.ensure_spool_directory(spool)
        q = reader.Queue(private)
        q.collect([message(11, 'first'), message(12, 'second'), message(12, 'second')], CHANNEL, NOW)
        self.assertEqual(q.get('lastId:' + CHANNEL['scope']), 12)
        self.assertEqual(q.pending(), 2)
        q.publish(spool)
        files = sorted(p.name for p in spool.glob('event-*.json'))
        self.assertEqual(files, ['event-0000000000000001.json', 'event-0000000000000002.json'])
        doc = json.loads((spool / files[0]).read_text())
        self.assertEqual((doc['schema'], doc['seq'], doc['message']['text']), (1, 1, 'first'))
        self.assertEqual(oct(os.stat(spool / files[0]).st_mode & 0o777), '0o640')
        # the Node side acknowledges seq < 2 and deletes consumed files; the reader prunes and does not re-create them
        (spool / files[0]).unlink()
        reader.atomic_json(spool / 'ack.json', {'schema': 1, 'nextSeq': 2, 'updatedAt': NOW * 1000}, 0o640)
        q.publish(spool)
        self.assertEqual(q.pending(), 1)
        self.assertFalse((spool / files[0]).exists())
        self.assertTrue((spool / files[1]).exists())
        q.db.close()


if __name__ == '__main__':
    unittest.main()
