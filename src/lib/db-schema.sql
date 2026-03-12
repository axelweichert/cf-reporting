-- =============================================================================
-- cf-reporting – Normalized SQLite Schema (v3)
-- =============================================================================
-- Replaces JSON blob snapshots with proper tables.
-- 33 tables covering all 16 report types.
--
-- Design principles:
--   1. INTEGER timestamps (unix epoch) – faster comparisons, smaller storage
--   2. Time series tables have UNIQUE(scope_id, ts[, dimension]) – natural dedup
--   3. Snapshot tables use collected_at for point-in-time captures
--   4. Generic top_items table handles all top-N ranked lists across reports
--   5. aggregate_stats handles single-value metrics that change over time
--   6. All tables have indexed scope_id + time columns for range queries
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. CORE – Collection tracking
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL UNIQUE,
  started_at   INTEGER NOT NULL,  -- unix epoch
  finished_at  INTEGER,
  status       TEXT    NOT NULL CHECK(status IN ('running','success','partial','error')),
  zones_count  INTEGER DEFAULT 0,
  accounts_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT    NOT NULL,
  scope_id      TEXT    NOT NULL,  -- zone_id or account_id
  scope_name    TEXT    NOT NULL,
  report_type   TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK(status IN ('success','error','skipped')),
  error_message TEXT,
  duration_ms   INTEGER,
  collected_at  INTEGER NOT NULL   -- unix epoch
);


-- ---------------------------------------------------------------------------
-- 2. SHARED DIMENSIONAL – Generic tables used across multiple report types
-- ---------------------------------------------------------------------------

-- Top-N ranked lists (covers ~30 different rankings across all reports)
-- Examples: top_paths, top_countries, top_attacking_ips, blocked_categories, etc.
CREATE TABLE IF NOT EXISTS top_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id     TEXT    NOT NULL,  -- zone_id or account_id
  collected_at INTEGER NOT NULL,  -- unix epoch
  report_type  TEXT    NOT NULL,  -- 'traffic', 'security', 'dns', etc.
  category     TEXT    NOT NULL,  -- 'top_paths', 'top_countries', 'attack_categories', etc.
  rank         INTEGER NOT NULL,  -- 1-based position
  name         TEXT    NOT NULL,  -- the item (path, country code, IP, etc.)
  value        INTEGER NOT NULL DEFAULT 0,  -- primary metric (count, requests)
  value2       INTEGER,           -- secondary metric (e.g. blocked count)
  value_pct    REAL,              -- percentage or rate
  detail       TEXT               -- extra context (ASN description, app_id, etc.)
);

-- Single-value aggregate stats that change over time
-- Examples: total_requests, cache_hit_ratio, encrypted_percent, avg_ttfb, etc.
CREATE TABLE IF NOT EXISTS aggregate_stats (
  scope_id     TEXT    NOT NULL,  -- zone_id or account_id
  collected_at INTEGER NOT NULL,  -- unix epoch
  report_type  TEXT    NOT NULL,
  stat_key     TEXT    NOT NULL,  -- e.g. 'total_requests', 'cache_hit_ratio'
  stat_value   REAL    NOT NULL,
  PRIMARY KEY (scope_id, collected_at, report_type, stat_key)
);

-- Protocol/version distributions (TLS versions, HTTP protocols, transport protocols)
CREATE TABLE IF NOT EXISTS protocol_distribution (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id     TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  report_type  TEXT    NOT NULL,  -- 'ssl', 'performance', 'gateway-network'
  category     TEXT    NOT NULL,  -- 'tls_version', 'http_protocol', 'transport'
  name         TEXT    NOT NULL,  -- 'TLSv1.3', 'HTTP/2', 'TCP', etc.
  requests     INTEGER NOT NULL DEFAULT 0
);

-- Bot score distribution (used by both security and bots reports)
CREATE TABLE IF NOT EXISTS bot_score_distribution (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id     TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  report_type  TEXT    NOT NULL,  -- 'security' or 'bots'
  range_start  INTEGER NOT NULL,  -- 0, 10, 20, ..., 90
  range_end    INTEGER NOT NULL,  -- 9, 19, 29, ..., 99
  count        INTEGER NOT NULL DEFAULT 0
);


-- ---------------------------------------------------------------------------
-- 3. ZONE TIME SERIES – Hourly metrics (one row per zone per hour)
-- ---------------------------------------------------------------------------

-- HTTP requests + cache + performance (traffic, performance, executive reports)
CREATE TABLE IF NOT EXISTS http_requests_ts (
  zone_id            TEXT    NOT NULL,
  ts                 INTEGER NOT NULL,  -- unix epoch, hourly bucket
  requests           INTEGER NOT NULL DEFAULT 0,
  bandwidth          INTEGER NOT NULL DEFAULT 0,  -- bytes
  cached_requests    INTEGER NOT NULL DEFAULT 0,
  cached_bandwidth   INTEGER NOT NULL DEFAULT 0,
  encrypted_requests INTEGER NOT NULL DEFAULT 0,
  status_1xx         INTEGER NOT NULL DEFAULT 0,
  status_2xx         INTEGER NOT NULL DEFAULT 0,
  status_3xx         INTEGER NOT NULL DEFAULT 0,
  status_4xx         INTEGER NOT NULL DEFAULT 0,
  status_5xx         INTEGER NOT NULL DEFAULT 0,
  avg_ttfb_ms        INTEGER,  -- milliseconds
  p95_ttfb_ms        INTEGER,
  avg_origin_time_ms INTEGER,
  p95_origin_time_ms INTEGER,
  PRIMARY KEY (zone_id, ts)
);

-- WAF / firewall action counts (security report)
CREATE TABLE IF NOT EXISTS firewall_events_ts (
  zone_id             TEXT    NOT NULL,
  ts                  INTEGER NOT NULL,
  blocks              INTEGER NOT NULL DEFAULT 0,
  challenges          INTEGER NOT NULL DEFAULT 0,
  managed_challenges  INTEGER NOT NULL DEFAULT 0,
  js_challenges       INTEGER NOT NULL DEFAULT 0,
  challenges_solved   INTEGER NOT NULL DEFAULT 0,
  logs                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (zone_id, ts)
);

-- Bot traffic classification (bots report)
CREATE TABLE IF NOT EXISTS bot_traffic_ts (
  zone_id        TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  automated      INTEGER NOT NULL DEFAULT 0,
  verified_bot   INTEGER NOT NULL DEFAULT 0,
  unverified_bot INTEGER NOT NULL DEFAULT 0,
  human          INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (zone_id, ts)
);

-- DDoS + rate limiting events (ddos report)
CREATE TABLE IF NOT EXISTS ddos_events_ts (
  zone_id          TEXT    NOT NULL,
  ts               INTEGER NOT NULL,
  l7_ddos_count    INTEGER NOT NULL DEFAULT 0,
  rate_limit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (zone_id, ts)
);

-- Origin response health (origin-health report)
CREATE TABLE IF NOT EXISTS origin_health_ts (
  zone_id             TEXT    NOT NULL,
  ts                  INTEGER NOT NULL,
  requests            INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms INTEGER,
  error_rate          REAL,  -- 0.0–100.0
  PRIMARY KEY (zone_id, ts)
);

-- API Shield session traffic (api-shield report)
CREATE TABLE IF NOT EXISTS api_session_ts (
  zone_id          TEXT    NOT NULL,
  ts               INTEGER NOT NULL,
  authenticated    INTEGER NOT NULL DEFAULT 0,
  unauthenticated  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (zone_id, ts)
);

-- DNS query volume by type (dns report)
-- One row per zone + hour + query type (A, AAAA, MX, NS, etc.)
CREATE TABLE IF NOT EXISTS dns_queries_ts (
  zone_id    TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  query_type TEXT    NOT NULL,  -- 'A', 'AAAA', 'MX', 'NS', etc.
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (zone_id, ts, query_type)
);


-- ---------------------------------------------------------------------------
-- 4. ACCOUNT TIME SERIES – Zero Trust hourly/daily metrics
-- ---------------------------------------------------------------------------

-- Gateway DNS query volume (gateway-dns report)
CREATE TABLE IF NOT EXISTS gateway_dns_ts (
  account_id TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ts)
);

-- Gateway network sessions (gateway-network report)
CREATE TABLE IF NOT EXISTS gateway_network_ts (
  account_id TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  allowed    INTEGER NOT NULL DEFAULT 0,
  blocked    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ts)
);

-- Gateway HTTP inspection (gateway-dns report, httpInspection sub-object)
CREATE TABLE IF NOT EXISTS gateway_http_ts (
  account_id TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ts)
);

-- Shadow IT app usage trends (shadow-it report)
-- One row per account + hour + app
CREATE TABLE IF NOT EXISTS shadow_it_usage_ts (
  account_id TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  app_name   TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ts, app_name)
);

-- Access login counts (access-audit report, daily buckets)
CREATE TABLE IF NOT EXISTS access_logins_ts (
  account_id TEXT    NOT NULL,
  ts         INTEGER NOT NULL,  -- daily bucket
  successful INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ts)
);

-- Daily active users (zt-summary report)
CREATE TABLE IF NOT EXISTS daily_active_users_ts (
  account_id   TEXT    NOT NULL,
  ts           INTEGER NOT NULL,  -- daily bucket
  unique_users INTEGER NOT NULL DEFAULT 0,
  logins       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ts)
);


-- ---------------------------------------------------------------------------
-- 5. ZONE SNAPSHOTS – Point-in-time captures (collected each run)
-- ---------------------------------------------------------------------------

-- Firewall / WAF rules with effectiveness stats (security report)
CREATE TABLE IF NOT EXISTS firewall_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id      TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  rule_id      TEXT    NOT NULL,
  rule_name    TEXT,
  description  TEXT,
  action       TEXT    NOT NULL,  -- block, challenge, managed_challenge, js_challenge, log, skip
  total_hits   INTEGER NOT NULL DEFAULT 0,
  blocks       INTEGER NOT NULL DEFAULT 0,
  challenges   INTEGER NOT NULL DEFAULT 0,
  logs         INTEGER NOT NULL DEFAULT 0,
  block_rate   REAL    -- 0.0–100.0
);

-- DNS zone records (dns report)
CREATE TABLE IF NOT EXISTS dns_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id             TEXT    NOT NULL,
  collected_at        INTEGER NOT NULL,
  record_id           TEXT    NOT NULL,
  name                TEXT    NOT NULL,
  type                TEXT    NOT NULL,  -- A, AAAA, CNAME, MX, etc.
  content             TEXT,
  ttl                 INTEGER,
  proxied             INTEGER,  -- 0 or 1
  query_count         INTEGER DEFAULT 0,
  has_nxdomain        INTEGER DEFAULT 0,
  status              TEXT,     -- active, unqueried, error
  days_since_modified INTEGER
);

-- SSL/TLS certificates (ssl report)
CREATE TABLE IF NOT EXISTS ssl_certificates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id              TEXT    NOT NULL,
  collected_at         INTEGER NOT NULL,
  cert_id              TEXT    NOT NULL,
  type                 TEXT    NOT NULL,
  hosts                TEXT    NOT NULL,  -- JSON array
  status               TEXT    NOT NULL,  -- pending, active, expired, degraded, deleted
  authority            TEXT,
  validity_days        INTEGER,
  expires_on           TEXT,
  signature_algorithms TEXT    -- JSON array
);

-- SSL/TLS zone settings (ssl report)
CREATE TABLE IF NOT EXISTS ssl_settings (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id                  TEXT    NOT NULL,
  collected_at             INTEGER NOT NULL,
  mode                     TEXT,   -- off, flexible, full, strict
  min_tls_version          TEXT,
  tls13_enabled            INTEGER,
  always_use_https         INTEGER,
  auto_https_rewrites      INTEGER,
  opportunistic_encryption INTEGER,
  zero_rtt                 INTEGER,
  http2_enabled            INTEGER,
  http3_enabled            INTEGER
);

-- Origin health checks config (origin-health report)
CREATE TABLE IF NOT EXISTS health_checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id      TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  address      TEXT,
  type         TEXT,     -- HTTPS, TCP, etc.
  interval_sec INTEGER
);

-- Origin health check events (origin-health report)
CREATE TABLE IF NOT EXISTS health_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id         TEXT    NOT NULL,
  collected_at    INTEGER NOT NULL,
  event_time      INTEGER NOT NULL,  -- unix epoch
  name            TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  origin_ip       TEXT,
  response_status INTEGER,
  rtt_ms          INTEGER,
  failure_reason  TEXT,
  region          TEXT
);

-- Origin response status breakdown (origin-health report)
CREATE TABLE IF NOT EXISTS origin_status_breakdown (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id              TEXT    NOT NULL,
  collected_at         INTEGER NOT NULL,
  status_code          INTEGER NOT NULL,
  status_group         TEXT    NOT NULL,  -- '2xx Success', '5xx Server Error', etc.
  requests             INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms INTEGER
);

-- Performance breakdown by dimension (performance report)
CREATE TABLE IF NOT EXISTS performance_breakdown (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id            TEXT    NOT NULL,
  collected_at       INTEGER NOT NULL,
  dimension          TEXT    NOT NULL,  -- 'content_type', 'country', 'colo'
  name               TEXT    NOT NULL,  -- the content type / country code / colo code
  city               TEXT,              -- for colo dimension only
  country            TEXT,              -- for colo dimension only
  requests           INTEGER NOT NULL DEFAULT 0,
  avg_ttfb_ms        INTEGER,
  avg_origin_time_ms INTEGER,
  avg_response_bytes INTEGER
);

-- API Shield managed operations (api-shield report)
CREATE TABLE IF NOT EXISTS api_operations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id      TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  operation_id TEXT    NOT NULL,
  method       TEXT    NOT NULL,
  host         TEXT,
  endpoint     TEXT    NOT NULL,
  last_updated TEXT
);

-- API Shield discovered endpoints (api-shield report)
CREATE TABLE IF NOT EXISTS api_discovered_endpoints (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id              TEXT    NOT NULL,
  collected_at         INTEGER NOT NULL,
  method               TEXT    NOT NULL,
  host                 TEXT,
  endpoint             TEXT    NOT NULL,
  state                TEXT,   -- review, production, archived
  avg_requests_per_hour REAL
);

-- L3/L4 DDoS attacks (ddos report, optional)
CREATE TABLE IF NOT EXISTS ddos_l34_attacks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id          TEXT    NOT NULL,
  collected_at     INTEGER NOT NULL,
  attack_type      TEXT,
  attack_vector    TEXT,
  ip_protocol      TEXT,
  destination_port INTEGER,
  mitigation_type  TEXT,
  packets          INTEGER,
  bits             INTEGER,
  dropped_packets  INTEGER,
  dropped_bits     INTEGER,
  start_time       INTEGER,  -- unix epoch
  end_time         INTEGER   -- unix epoch
);


-- ---------------------------------------------------------------------------
-- 6. ACCOUNT SNAPSHOTS – Zero Trust point-in-time captures
-- ---------------------------------------------------------------------------

-- Gateway DNS policy breakdown (gateway-dns report)
CREATE TABLE IF NOT EXISTS gateway_policies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  policy_name  TEXT    NOT NULL,
  allowed      INTEGER NOT NULL DEFAULT 0,
  blocked      INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0
);

-- Gateway blocked network destinations (gateway-network report)
CREATE TABLE IF NOT EXISTS gateway_blocked_destinations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  ip           TEXT    NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  country      TEXT,
  port         INTEGER,
  protocol     TEXT
);

-- Shadow IT discovered applications (shadow-it report)
CREATE TABLE IF NOT EXISTS shadow_it_apps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  app_name     TEXT    NOT NULL,
  raw_name     TEXT,
  category     TEXT,
  count        INTEGER NOT NULL DEFAULT 0
);

-- Shadow IT user-to-app mappings (shadow-it report)
CREATE TABLE IF NOT EXISTS shadow_it_user_apps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT    NOT NULL,
  collected_at    INTEGER NOT NULL,
  email           TEXT    NOT NULL,
  apps            TEXT    NOT NULL,  -- JSON array of app names
  total_requests  INTEGER NOT NULL DEFAULT 0
);

-- WARP device inventory (devices-users report)
CREATE TABLE IF NOT EXISTS zt_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  device_name  TEXT    NOT NULL,
  user_name    TEXT,
  email        TEXT,
  os           TEXT,
  os_version   TEXT,
  warp_version TEXT,
  last_seen    INTEGER,  -- unix epoch
  status       TEXT      -- active, inactive, stale
);

-- Zero Trust user inventory (devices-users report)
CREATE TABLE IF NOT EXISTS zt_users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  name         TEXT,
  email        TEXT    NOT NULL,
  access_seat  INTEGER,  -- 0 or 1
  gateway_seat INTEGER,  -- 0 or 1
  device_count INTEGER DEFAULT 0,
  last_login   INTEGER   -- unix epoch
);

-- Device posture rules (devices-users report)
CREATE TABLE IF NOT EXISTS zt_posture_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL,  -- os_version, application, disk_encryption, etc.
  description  TEXT,
  platform     TEXT,
  input_json   TEXT,   -- rule input config (complex, keep as JSON)
  scope_json   TEXT    -- device scope config (complex, keep as JSON)
);

-- Access application stats (access-audit report)
CREATE TABLE IF NOT EXISTS access_app_stats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  app_id       TEXT    NOT NULL,
  app_name     TEXT    NOT NULL,
  successful   INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  failure_rate REAL    -- 0.0–100.0
);

-- Executive recommendations + Access anomalies (computed insights)
CREATE TABLE IF NOT EXISTS recommendations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id     TEXT    NOT NULL,
  collected_at INTEGER NOT NULL,
  report_type  TEXT    NOT NULL,  -- 'executive' or 'access-audit'
  severity     TEXT    NOT NULL,  -- info, warning, critical
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL
);


-- ---------------------------------------------------------------------------
-- 7. INDEXES
-- ---------------------------------------------------------------------------

-- Collection tracking
CREATE INDEX IF NOT EXISTS idx_collection_log_run     ON collection_log(run_id);
CREATE INDEX IF NOT EXISTS idx_collection_log_scope   ON collection_log(scope_id, collected_at);

-- Shared dimensional
CREATE INDEX IF NOT EXISTS idx_top_items_lookup       ON top_items(scope_id, report_type, category, collected_at);
CREATE INDEX IF NOT EXISTS idx_aggregate_stats_scope  ON aggregate_stats(scope_id, report_type, stat_key);
CREATE INDEX IF NOT EXISTS idx_protocol_dist_lookup   ON protocol_distribution(scope_id, report_type, category, collected_at);
CREATE INDEX IF NOT EXISTS idx_bot_score_lookup       ON bot_score_distribution(scope_id, collected_at);

-- Zone time series (PRIMARY KEY already covers zone_id + ts)
-- Additional indexes for time-range queries across all zones
CREATE INDEX IF NOT EXISTS idx_http_ts_time           ON http_requests_ts(ts);
CREATE INDEX IF NOT EXISTS idx_firewall_ts_time       ON firewall_events_ts(ts);
CREATE INDEX IF NOT EXISTS idx_bot_ts_time            ON bot_traffic_ts(ts);
CREATE INDEX IF NOT EXISTS idx_ddos_ts_time           ON ddos_events_ts(ts);
CREATE INDEX IF NOT EXISTS idx_origin_health_ts_time  ON origin_health_ts(ts);
CREATE INDEX IF NOT EXISTS idx_dns_queries_ts_time    ON dns_queries_ts(ts);

-- Account time series
CREATE INDEX IF NOT EXISTS idx_gw_dns_ts_time         ON gateway_dns_ts(ts);
CREATE INDEX IF NOT EXISTS idx_gw_net_ts_time         ON gateway_network_ts(ts);
CREATE INDEX IF NOT EXISTS idx_shadow_it_ts_time      ON shadow_it_usage_ts(ts);
CREATE INDEX IF NOT EXISTS idx_access_logins_ts_time  ON access_logins_ts(ts);
CREATE INDEX IF NOT EXISTS idx_dau_ts_time            ON daily_active_users_ts(ts);

-- Snapshot tables (scope + collected_at for each)
CREATE INDEX IF NOT EXISTS idx_fw_rules_lookup        ON firewall_rules(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_dns_records_lookup      ON dns_records(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_ssl_certs_lookup        ON ssl_certificates(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_ssl_settings_lookup     ON ssl_settings(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_health_checks_lookup    ON health_checks(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_health_events_lookup    ON health_events(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_origin_status_lookup    ON origin_status_breakdown(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_perf_breakdown_lookup   ON performance_breakdown(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_api_ops_lookup          ON api_operations(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_api_discovered_lookup   ON api_discovered_endpoints(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_ddos_l34_lookup         ON ddos_l34_attacks(zone_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_gw_policies_lookup      ON gateway_policies(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_gw_blocked_lookup       ON gateway_blocked_destinations(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_shadow_apps_lookup      ON shadow_it_apps(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_shadow_users_lookup     ON shadow_it_user_apps(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_zt_devices_lookup       ON zt_devices(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_zt_users_lookup         ON zt_users(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_zt_posture_lookup       ON zt_posture_rules(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_access_apps_lookup      ON access_app_stats(account_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_lookup  ON recommendations(scope_id, report_type, collected_at);
