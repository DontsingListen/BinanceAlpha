/** SQLite schema. Bump SCHEMA_VERSION and append a migration when the shape changes. */

export const SCHEMA_VERSION = 2;

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS raw_responses (
  sha256 TEXT PRIMARY KEY,
  first_observed_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  gzip BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_attempts (
  request_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  params_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  http_status INTEGER,
  business_code TEXT,
  outcome TEXT NOT NULL,
  row_count INTEGER,
  error_class TEXT,
  error_message TEXT,
  raw_sha256 TEXT,
  raw_bytes INTEGER,
  server_date_ms INTEGER,
  clock_offset_ms INTEGER,
  retry_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fetch_attempts_time ON fetch_attempts(started_at);

CREATE TABLE IF NOT EXISTS universe_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  token_list_sha256 TEXT NOT NULL,
  exchange_info_sha256 TEXT NOT NULL,
  selection_policy_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  eligible_count INTEGER NOT NULL,
  selected_count INTEGER NOT NULL,
  members_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  instrument_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  market_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  alpha_id TEXT NOT NULL,
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  display_symbol TEXT NOT NULL,
  token_name TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  status TEXT NOT NULL,
  token_offline INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  identity_version INTEGER NOT NULL,
  identity_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instrument_identity_versions (
  instrument_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  identity_json TEXT NOT NULL,
  PRIMARY KEY (instrument_id, version)
);

CREATE TABLE IF NOT EXISTS identity_conflicts (
  conflict_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candle_versions (
  version_id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  open_at INTEGER NOT NULL,
  close_at INTEGER NOT NULL,
  source_close_at INTEGER NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  base_volume TEXT NOT NULL,
  quote_volume TEXT NOT NULL,
  trade_count TEXT,
  content_hash TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  raw_sha256 TEXT,
  UNIQUE (instrument_id, interval_ms, open_at, content_hash)
);
CREATE INDEX IF NOT EXISTS candle_versions_lookup ON candle_versions(instrument_id, interval_ms, open_at, first_observed_at);

CREATE TABLE IF NOT EXISTS collection_cursors (
  instrument_id TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  earliest_open_at INTEGER,
  latest_closed_open_at INTEGER,
  backfill_target_open_at INTEGER,
  backfill_done INTEGER NOT NULL DEFAULT 0,
  backfill_reason TEXT,
  last_fetch_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  PRIMARY KEY (instrument_id, interval_ms)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  config_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS input_journal (
  run_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  candle_version_id TEXT NOT NULL,
  open_at INTEGER NOT NULL,
  close_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  quality TEXT NOT NULL,
  now_ms INTEGER NOT NULL,
  history_length INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, instrument_id, seq)
);

CREATE TABLE IF NOT EXISTS setup_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  setup_id TEXT,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  decision_bar_open_at INTEGER NOT NULL,
  decision_bar_close_at INTEGER NOT NULL,
  emitted_at INTEGER NOT NULL,
  is_fresh INTEGER NOT NULL,
  candle_version_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  values_json TEXT NOT NULL,
  thresholds_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS setup_events_by_run ON setup_events(run_id, instrument_id, seq);
CREATE INDEX IF NOT EXISTS setup_events_by_time ON setup_events(emitted_at);

CREATE TABLE IF NOT EXISTS setup_heads (
  run_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  phase TEXT NOT NULL,
  last_open_at INTEGER,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS run_stats (
  run_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (run_id, instrument_id, code)
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_fresh INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_by_time ON alerts(created_at);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
-- Social signal sources (ADR 0003): watched X handles / Telegram chats, provider polls, posts, token mentions.
CREATE TABLE IF NOT EXISTS social_sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  handle TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS social_polls (
  poll_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_class TEXT,
  http_status INTEGER,
  raw_sha256 TEXT,
  cost_usd_ticks INTEGER,
  posts_fetched INTEGER,
  users_fetched INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  posts_returned INTEGER NOT NULL DEFAULT 0,
  posts_new INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS social_polls_started ON social_polls(kind, started_at);
CREATE TABLE IF NOT EXISTS social_posts (
  post_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  author_handle TEXT,
  author_id TEXT,
  posted_at INTEGER,
  observed_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  evidence TEXT NOT NULL,
  poll_id TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS social_posts_time ON social_posts(kind, posted_at);
CREATE TABLE IF NOT EXISTS token_mentions (
  mention_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  extractor TEXT NOT NULL,
  token_text TEXT NOT NULL,
  match_kind TEXT NOT NULL,
  instrument_id TEXT,
  resolution TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  stance TEXT NOT NULL,
  confidence REAL NOT NULL,
  extracted_at INTEGER NOT NULL,
  UNIQUE(post_id, extractor, token_text)
);
CREATE INDEX IF NOT EXISTS token_mentions_instrument ON token_mentions(instrument_id, extracted_at);
`,
  },
];
