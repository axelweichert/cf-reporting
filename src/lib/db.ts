/**
 * SQLite singleton with lazy initialization and graceful degradation.
 *
 * Opens /app/data/cf-reporting.db on first call to getDb().
 * If the directory is unwritable (no volume mounted), returns null –
 * the app works identically to today without persistent storage.
 */

import type Database from "better-sqlite3";

let _db: Database.Database | null = null;
let _initFailed = false;

const DB_PATH = process.env.DB_PATH || "/app/data/cf-reporting.db";
const SCHEMA_VERSION = 8;

export function getDb(): Database.Database | null {
  if (_initFailed) return null;
  if (_db) return _db;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require("better-sqlite3") as (filename: string) => Database.Database;
    _db = BetterSqlite3(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");

    runMigrations(_db);

    console.log("[db] SQLite initialized at", DB_PATH);
    return _db;
  } catch (err) {
    _initFailed = true;
    console.warn("[db] SQLite unavailable – running without persistent storage:", (err as Error).message);
    return null;
  }
}

export function isDbAvailable(): boolean {
  return getDb() !== null;
}

function runMigrations(db: Database.Database): void {
  // Create migrations table if it doesn't exist
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);

  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  const currentVersion = row?.version || 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id TEXT NOT NULL,
        zone_name TEXT NOT NULL,
        report_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        data_json TEXT NOT NULL,
        collected_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(zone_id, report_type, period_start, period_end)
      );

      CREATE TABLE IF NOT EXISTS collection_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        zone_name TEXT NOT NULL,
        report_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
        error_message TEXT,
        duration_ms INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_zone_type
        ON report_snapshots(zone_id, report_type);
      CREATE INDEX IF NOT EXISTS idx_snapshots_collected
        ON report_snapshots(collected_at);
      CREATE INDEX IF NOT EXISTS idx_collection_log_run
        ON collection_log(run_id);
    `);
  }

  if (currentVersion < 2) {
    // v2: Clear old overlapping snapshots from the 7-day-window era.
    // The collector now fetches incrementally (only new data since last run),
    // so old overlapping snapshots are redundant and waste space.
    db.exec(`DELETE FROM report_snapshots`);
    console.log("[db] Migration v2: cleared old overlapping snapshots – collector will refill incrementally");
  }

  if (currentVersion < 3) {
    // v3: Replace JSON blob snapshots with normalized tables.
    // Drop the old tables – their data will be re-collected into the new schema.
    db.exec(`
      DROP TABLE IF EXISTS report_snapshots;
      DROP TABLE IF EXISTS collection_log;

      -- 1. CORE – Collection tracking
      CREATE TABLE IF NOT EXISTS collection_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT    NOT NULL UNIQUE,
        started_at   INTEGER NOT NULL,
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
        scope_id      TEXT    NOT NULL,
        scope_name    TEXT    NOT NULL,
        report_type   TEXT    NOT NULL,
        status        TEXT    NOT NULL CHECK(status IN ('success','error','skipped')),
        error_message TEXT,
        duration_ms   INTEGER,
        collected_at  INTEGER NOT NULL
      );

      -- 2. SHARED DIMENSIONAL
      CREATE TABLE IF NOT EXISTS top_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id     TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        report_type  TEXT    NOT NULL,
        category     TEXT    NOT NULL,
        rank         INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        value        INTEGER NOT NULL DEFAULT 0,
        value2       INTEGER,
        value_pct    REAL,
        detail       TEXT
      );

      CREATE TABLE IF NOT EXISTS aggregate_stats (
        scope_id     TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        report_type  TEXT    NOT NULL,
        stat_key     TEXT    NOT NULL,
        stat_value   REAL    NOT NULL,
        PRIMARY KEY (scope_id, collected_at, report_type, stat_key)
      );

      CREATE TABLE IF NOT EXISTS protocol_distribution (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id     TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        report_type  TEXT    NOT NULL,
        category     TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        requests     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS bot_score_distribution (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id     TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        report_type  TEXT    NOT NULL,
        range_start  INTEGER NOT NULL,
        range_end    INTEGER NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0
      );

      -- 3. ZONE TIME SERIES
      CREATE TABLE IF NOT EXISTS http_requests_ts (
        zone_id            TEXT    NOT NULL,
        ts                 INTEGER NOT NULL,
        requests           INTEGER NOT NULL DEFAULT 0,
        bandwidth          INTEGER NOT NULL DEFAULT 0,
        cached_requests    INTEGER NOT NULL DEFAULT 0,
        cached_bandwidth   INTEGER NOT NULL DEFAULT 0,
        encrypted_requests INTEGER NOT NULL DEFAULT 0,
        status_1xx         INTEGER NOT NULL DEFAULT 0,
        status_2xx         INTEGER NOT NULL DEFAULT 0,
        status_3xx         INTEGER NOT NULL DEFAULT 0,
        status_4xx         INTEGER NOT NULL DEFAULT 0,
        status_5xx         INTEGER NOT NULL DEFAULT 0,
        avg_ttfb_ms        INTEGER,
        p95_ttfb_ms        INTEGER,
        avg_origin_time_ms INTEGER,
        p95_origin_time_ms INTEGER,
        PRIMARY KEY (zone_id, ts)
      );

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

      CREATE TABLE IF NOT EXISTS ddos_events_ts (
        zone_id          TEXT    NOT NULL,
        ts               INTEGER NOT NULL,
        l7_ddos_count    INTEGER NOT NULL DEFAULT 0,
        rate_limit_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts)
      );

      CREATE TABLE IF NOT EXISTS origin_health_ts (
        zone_id             TEXT    NOT NULL,
        ts                  INTEGER NOT NULL,
        requests            INTEGER NOT NULL DEFAULT 0,
        avg_response_time_ms INTEGER,
        error_rate          REAL,
        PRIMARY KEY (zone_id, ts)
      );

      CREATE TABLE IF NOT EXISTS api_session_ts (
        zone_id          TEXT    NOT NULL,
        ts               INTEGER NOT NULL,
        authenticated    INTEGER NOT NULL DEFAULT 0,
        unauthenticated  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts)
      );

      CREATE TABLE IF NOT EXISTS dns_queries_ts (
        zone_id    TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        query_type TEXT    NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts, query_type)
      );

      -- 4. ACCOUNT TIME SERIES
      CREATE TABLE IF NOT EXISTS gateway_dns_ts (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      CREATE TABLE IF NOT EXISTS gateway_network_ts (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        allowed    INTEGER NOT NULL DEFAULT 0,
        blocked    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      CREATE TABLE IF NOT EXISTS gateway_http_ts (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      CREATE TABLE IF NOT EXISTS shadow_it_usage_ts (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        app_name   TEXT    NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts, app_name)
      );

      CREATE TABLE IF NOT EXISTS access_logins_ts (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        successful INTEGER NOT NULL DEFAULT 0,
        failed     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      CREATE TABLE IF NOT EXISTS daily_active_users_ts (
        account_id   TEXT    NOT NULL,
        ts           INTEGER NOT NULL,
        unique_users INTEGER NOT NULL DEFAULT 0,
        logins       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      -- 5. ZONE SNAPSHOTS
      CREATE TABLE IF NOT EXISTS firewall_rules (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id      TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        rule_id      TEXT    NOT NULL,
        rule_name    TEXT,
        description  TEXT,
        action       TEXT    NOT NULL,
        total_hits   INTEGER NOT NULL DEFAULT 0,
        blocks       INTEGER NOT NULL DEFAULT 0,
        challenges   INTEGER NOT NULL DEFAULT 0,
        logs         INTEGER NOT NULL DEFAULT 0,
        block_rate   REAL
      );

      CREATE TABLE IF NOT EXISTS dns_records (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id             TEXT    NOT NULL,
        collected_at        INTEGER NOT NULL,
        record_id           TEXT    NOT NULL,
        name                TEXT    NOT NULL,
        type                TEXT    NOT NULL,
        content             TEXT,
        ttl                 INTEGER,
        proxied             INTEGER,
        query_count         INTEGER DEFAULT 0,
        has_nxdomain        INTEGER DEFAULT 0,
        status              TEXT,
        days_since_modified INTEGER
      );

      CREATE TABLE IF NOT EXISTS ssl_certificates (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id              TEXT    NOT NULL,
        collected_at         INTEGER NOT NULL,
        cert_id              TEXT    NOT NULL,
        type                 TEXT    NOT NULL,
        hosts                TEXT    NOT NULL,
        status               TEXT    NOT NULL,
        authority            TEXT,
        validity_days        INTEGER,
        expires_on           TEXT,
        signature_algorithms TEXT
      );

      CREATE TABLE IF NOT EXISTS ssl_settings (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id                  TEXT    NOT NULL,
        collected_at             INTEGER NOT NULL,
        mode                     TEXT,
        min_tls_version          TEXT,
        tls13_enabled            INTEGER,
        always_use_https         INTEGER,
        auto_https_rewrites      INTEGER,
        opportunistic_encryption INTEGER,
        zero_rtt                 INTEGER,
        http2_enabled            INTEGER,
        http3_enabled            INTEGER
      );

      CREATE TABLE IF NOT EXISTS health_checks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id      TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        status       TEXT    NOT NULL,
        address      TEXT,
        type         TEXT,
        interval_sec INTEGER
      );

      CREATE TABLE IF NOT EXISTS health_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id         TEXT    NOT NULL,
        collected_at    INTEGER NOT NULL,
        event_time      INTEGER NOT NULL,
        name            TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        origin_ip       TEXT,
        response_status INTEGER,
        rtt_ms          INTEGER,
        failure_reason  TEXT,
        region          TEXT
      );

      CREATE TABLE IF NOT EXISTS origin_status_breakdown (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id              TEXT    NOT NULL,
        collected_at         INTEGER NOT NULL,
        status_code          INTEGER NOT NULL,
        status_group         TEXT    NOT NULL,
        requests             INTEGER NOT NULL DEFAULT 0,
        avg_response_time_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS performance_breakdown (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id            TEXT    NOT NULL,
        collected_at       INTEGER NOT NULL,
        dimension          TEXT    NOT NULL,
        name               TEXT    NOT NULL,
        city               TEXT,
        country            TEXT,
        requests           INTEGER NOT NULL DEFAULT 0,
        avg_ttfb_ms        INTEGER,
        avg_origin_time_ms INTEGER,
        avg_response_bytes INTEGER
      );

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

      CREATE TABLE IF NOT EXISTS api_discovered_endpoints (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id              TEXT    NOT NULL,
        collected_at         INTEGER NOT NULL,
        method               TEXT    NOT NULL,
        host                 TEXT,
        endpoint             TEXT    NOT NULL,
        state                TEXT,
        avg_requests_per_hour REAL
      );

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
        start_time       INTEGER,
        end_time         INTEGER
      );

      -- 6. ACCOUNT SNAPSHOTS
      CREATE TABLE IF NOT EXISTS gateway_policies (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        policy_name  TEXT    NOT NULL,
        allowed      INTEGER NOT NULL DEFAULT 0,
        blocked      INTEGER NOT NULL DEFAULT 0,
        total        INTEGER NOT NULL DEFAULT 0
      );

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

      CREATE TABLE IF NOT EXISTS shadow_it_apps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        app_name     TEXT    NOT NULL,
        raw_name     TEXT,
        category     TEXT,
        count        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS shadow_it_user_apps (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT    NOT NULL,
        collected_at    INTEGER NOT NULL,
        email           TEXT    NOT NULL,
        apps            TEXT    NOT NULL,
        total_requests  INTEGER NOT NULL DEFAULT 0
      );

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
        last_seen    INTEGER,
        status       TEXT
      );

      CREATE TABLE IF NOT EXISTS zt_users (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        name         TEXT,
        email        TEXT    NOT NULL,
        access_seat  INTEGER,
        gateway_seat INTEGER,
        device_count INTEGER DEFAULT 0,
        last_login   INTEGER
      );

      CREATE TABLE IF NOT EXISTS zt_posture_rules (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        type         TEXT    NOT NULL,
        description  TEXT,
        platform     TEXT,
        input_json   TEXT,
        scope_json   TEXT
      );

      CREATE TABLE IF NOT EXISTS access_app_stats (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        app_id       TEXT    NOT NULL,
        app_name     TEXT    NOT NULL,
        successful   INTEGER NOT NULL DEFAULT 0,
        failed       INTEGER NOT NULL DEFAULT 0,
        total        INTEGER NOT NULL DEFAULT 0,
        failure_rate REAL
      );

      CREATE TABLE IF NOT EXISTS recommendations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id     TEXT    NOT NULL,
        collected_at INTEGER NOT NULL,
        report_type  TEXT    NOT NULL,
        severity     TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        description  TEXT    NOT NULL
      );

      -- 7. INDEXES
      CREATE INDEX IF NOT EXISTS idx_collection_log_run     ON collection_log(run_id);
      CREATE INDEX IF NOT EXISTS idx_collection_log_scope   ON collection_log(scope_id, collected_at);

      CREATE INDEX IF NOT EXISTS idx_top_items_lookup       ON top_items(scope_id, report_type, category, collected_at);
      CREATE INDEX IF NOT EXISTS idx_aggregate_stats_scope  ON aggregate_stats(scope_id, report_type, stat_key);
      CREATE INDEX IF NOT EXISTS idx_protocol_dist_lookup   ON protocol_distribution(scope_id, report_type, category, collected_at);
      CREATE INDEX IF NOT EXISTS idx_bot_score_lookup       ON bot_score_distribution(scope_id, collected_at);

      CREATE INDEX IF NOT EXISTS idx_http_ts_time           ON http_requests_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_firewall_ts_time       ON firewall_events_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_bot_ts_time            ON bot_traffic_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_ddos_ts_time           ON ddos_events_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_origin_health_ts_time  ON origin_health_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_dns_queries_ts_time    ON dns_queries_ts(ts);

      CREATE INDEX IF NOT EXISTS idx_gw_dns_ts_time         ON gateway_dns_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_gw_net_ts_time         ON gateway_network_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_shadow_it_ts_time      ON shadow_it_usage_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_access_logins_ts_time  ON access_logins_ts(ts);
      CREATE INDEX IF NOT EXISTS idx_dau_ts_time            ON daily_active_users_ts(ts);

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
    `);
    console.log("[db] Migration v3: created normalized schema (33 tables)");
  }

  if (currentVersion < 4) {
    // v4: Add skipped_count column to collection_runs for permission-error tracking.
    db.exec(`
      ALTER TABLE collection_runs ADD COLUMN skipped_count INTEGER DEFAULT 0;
    `);
    console.log("[db] Migration v4: added skipped_count to collection_runs");
  }

  if (currentVersion < 5) {
    // v5: Raw data lake – replace report-oriented tables with dataset-oriented raw tables.
    // Drop old redundant tables (data will be re-collected into raw schema).
    db.exec(`
      -- Drop v3 tables made redundant by raw tables
      DROP TABLE IF EXISTS top_items;
      DROP TABLE IF EXISTS aggregate_stats;
      DROP TABLE IF EXISTS protocol_distribution;
      DROP TABLE IF EXISTS bot_score_distribution;
      DROP TABLE IF EXISTS http_requests_ts;
      DROP TABLE IF EXISTS firewall_events_ts;
      DROP TABLE IF EXISTS bot_traffic_ts;
      DROP TABLE IF EXISTS ddos_events_ts;
      DROP TABLE IF EXISTS origin_health_ts;
      DROP TABLE IF EXISTS api_session_ts;
      DROP TABLE IF EXISTS dns_queries_ts;
      DROP TABLE IF EXISTS gateway_dns_ts;
      DROP TABLE IF EXISTS gateway_network_ts;
      DROP TABLE IF EXISTS gateway_http_ts;
      DROP TABLE IF EXISTS shadow_it_usage_ts;
      DROP TABLE IF EXISTS access_logins_ts;
      DROP TABLE IF EXISTS daily_active_users_ts;
      DROP TABLE IF EXISTS firewall_rules;
      DROP TABLE IF EXISTS origin_status_breakdown;
      DROP TABLE IF EXISTS performance_breakdown;
      DROP TABLE IF EXISTS gateway_policies;
      DROP TABLE IF EXISTS gateway_blocked_destinations;
      DROP TABLE IF EXISTS shadow_it_apps;
      DROP TABLE IF EXISTS shadow_it_user_apps;
      DROP TABLE IF EXISTS recommendations;

      -- ================================================================
      -- RAW ZONE-SCOPED TABLES
      -- ================================================================

      -- Hourly HTTP totals with all scalar metrics
      CREATE TABLE IF NOT EXISTS raw_http_hourly (
        zone_id              TEXT    NOT NULL,
        ts                   INTEGER NOT NULL,
        requests             INTEGER NOT NULL DEFAULT 0,
        bytes                INTEGER NOT NULL DEFAULT 0,
        cached_requests      INTEGER NOT NULL DEFAULT 0,
        cached_bytes         INTEGER NOT NULL DEFAULT 0,
        encrypted_requests   INTEGER NOT NULL DEFAULT 0,
        status_1xx           INTEGER NOT NULL DEFAULT 0,
        status_2xx           INTEGER NOT NULL DEFAULT 0,
        status_3xx           INTEGER NOT NULL DEFAULT 0,
        status_4xx           INTEGER NOT NULL DEFAULT 0,
        status_5xx           INTEGER NOT NULL DEFAULT 0,
        ttfb_avg             REAL,
        ttfb_p50             REAL,
        ttfb_p95             REAL,
        ttfb_p99             REAL,
        origin_time_avg      REAL,
        origin_time_p50      REAL,
        origin_time_p95      REAL,
        origin_time_p99      REAL,
        PRIMARY KEY (zone_id, ts)
      );

      -- Flexible HTTP dimension breakdowns: one row per zone/hour/dim/key
      CREATE TABLE IF NOT EXISTS raw_http_dim (
        zone_id    TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        dim        TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        requests   INTEGER NOT NULL DEFAULT 0,
        bytes      INTEGER NOT NULL DEFAULT 0,
        ttfb_avg   REAL,
        origin_avg REAL,
        PRIMARY KEY (zone_id, ts, dim, key)
      );

      -- Encryption ratio time series (httpRequestsOverviewAdaptiveGroups)
      CREATE TABLE IF NOT EXISTS raw_http_overview_hourly (
        zone_id            TEXT    NOT NULL,
        ts                 INTEGER NOT NULL,
        requests           INTEGER NOT NULL DEFAULT 0,
        encrypted_requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts)
      );

      -- Firewall hourly totals by action
      CREATE TABLE IF NOT EXISTS raw_fw_hourly (
        zone_id             TEXT    NOT NULL,
        ts                  INTEGER NOT NULL,
        total               INTEGER NOT NULL DEFAULT 0,
        blocked             INTEGER NOT NULL DEFAULT 0,
        challenged          INTEGER NOT NULL DEFAULT 0,
        managed_challenged  INTEGER NOT NULL DEFAULT 0,
        js_challenged       INTEGER NOT NULL DEFAULT 0,
        challenge_solved    INTEGER NOT NULL DEFAULT 0,
        logged              INTEGER NOT NULL DEFAULT 0,
        skipped             INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts)
      );

      -- Firewall dimension breakdowns
      CREATE TABLE IF NOT EXISTS raw_fw_dim (
        zone_id  TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        dim      TEXT    NOT NULL,
        key      TEXT    NOT NULL,
        events   INTEGER NOT NULL DEFAULT 0,
        detail   TEXT,
        PRIMARY KEY (zone_id, ts, dim, key)
      );

      -- DNS hourly
      CREATE TABLE IF NOT EXISTS raw_dns_hourly (
        zone_id  TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        queries  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts)
      );

      -- DNS dimensions
      CREATE TABLE IF NOT EXISTS raw_dns_dim (
        zone_id  TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        dim      TEXT    NOT NULL,
        key      TEXT    NOT NULL,
        queries  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (zone_id, ts, dim, key)
      );

      -- Health check events
      CREATE TABLE IF NOT EXISTS raw_health_events (
        zone_id          TEXT    NOT NULL,
        ts               INTEGER NOT NULL,
        name             TEXT    NOT NULL,
        origin_ip        TEXT    NOT NULL DEFAULT '',
        status           TEXT,
        response_status  INTEGER,
        rtt_ms           INTEGER,
        failure_reason   TEXT,
        region           TEXT,
        PRIMARY KEY (zone_id, ts, name, origin_ip)
      );

      -- ================================================================
      -- RAW ACCOUNT-SCOPED TABLES
      -- ================================================================

      -- Gateway DNS hourly
      CREATE TABLE IF NOT EXISTS raw_gw_dns_hourly (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        total      INTEGER NOT NULL DEFAULT 0,
        blocked    INTEGER NOT NULL DEFAULT 0,
        allowed    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      -- Gateway DNS dimensions
      CREATE TABLE IF NOT EXISTS raw_gw_dns_dim (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        dim        TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        queries    INTEGER NOT NULL DEFAULT 0,
        detail     TEXT,
        PRIMARY KEY (account_id, ts, dim, key)
      );

      -- Gateway Network hourly
      CREATE TABLE IF NOT EXISTS raw_gw_net_hourly (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        allowed    INTEGER NOT NULL DEFAULT 0,
        blocked    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      -- Gateway Network dimensions
      CREATE TABLE IF NOT EXISTS raw_gw_net_dim (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        dim        TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        sessions   INTEGER NOT NULL DEFAULT 0,
        detail     TEXT,
        PRIMARY KEY (account_id, ts, dim, key)
      );

      -- Gateway HTTP hourly
      CREATE TABLE IF NOT EXISTS raw_gw_http_hourly (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        total      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      -- Gateway HTTP dimensions
      CREATE TABLE IF NOT EXISTS raw_gw_http_dim (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        dim        TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        requests   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts, dim, key)
      );

      -- Access login daily
      CREATE TABLE IF NOT EXISTS raw_access_daily (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        successful INTEGER NOT NULL DEFAULT 0,
        failed     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ts)
      );

      -- Access login dimensions
      CREATE TABLE IF NOT EXISTS raw_access_dim (
        account_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        dim        TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        logins     INTEGER NOT NULL DEFAULT 0,
        detail     TEXT,
        PRIMARY KEY (account_id, ts, dim, key)
      );

      -- DDoS attack events (account-scoped, L3/L4)
      CREATE TABLE IF NOT EXISTS raw_dosd_attacks (
        account_id       TEXT    NOT NULL,
        attack_id        TEXT    NOT NULL,
        attack_type      TEXT,
        attack_vector    TEXT,
        ip_protocol      TEXT,
        destination_port INTEGER,
        mitigation_type  TEXT,
        packets          INTEGER,
        bits             INTEGER,
        dropped_packets  INTEGER,
        dropped_bits     INTEGER,
        start_time       INTEGER,
        end_time         INTEGER,
        PRIMARY KEY (account_id, attack_id)
      );

      -- ================================================================
      -- INDEXES for raw tables
      -- ================================================================
      CREATE INDEX IF NOT EXISTS idx_raw_http_hourly_ts      ON raw_http_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_http_dim_lookup     ON raw_http_dim(zone_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_http_overview_ts    ON raw_http_overview_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_fw_hourly_ts        ON raw_fw_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_fw_dim_lookup       ON raw_fw_dim(zone_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_dns_hourly_ts       ON raw_dns_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_dns_dim_lookup      ON raw_dns_dim(zone_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_health_events_ts    ON raw_health_events(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_gw_dns_hourly_ts    ON raw_gw_dns_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_gw_dns_dim_lookup   ON raw_gw_dns_dim(account_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_gw_net_hourly_ts    ON raw_gw_net_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_gw_net_dim_lookup   ON raw_gw_net_dim(account_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_gw_http_hourly_ts   ON raw_gw_http_hourly(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_gw_http_dim_lookup  ON raw_gw_http_dim(account_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_access_daily_ts     ON raw_access_daily(ts);
      CREATE INDEX IF NOT EXISTS idx_raw_access_dim_lookup   ON raw_access_dim(account_id, dim, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_dosd_attacks_acct   ON raw_dosd_attacks(account_id);

      -- Drop old indexes that referenced dropped tables
      DROP INDEX IF EXISTS idx_top_items_lookup;
      DROP INDEX IF EXISTS idx_aggregate_stats_scope;
      DROP INDEX IF EXISTS idx_protocol_dist_lookup;
      DROP INDEX IF EXISTS idx_bot_score_lookup;
      DROP INDEX IF EXISTS idx_http_ts_time;
      DROP INDEX IF EXISTS idx_firewall_ts_time;
      DROP INDEX IF EXISTS idx_bot_ts_time;
      DROP INDEX IF EXISTS idx_ddos_ts_time;
      DROP INDEX IF EXISTS idx_origin_health_ts_time;
      DROP INDEX IF EXISTS idx_dns_queries_ts_time;
      DROP INDEX IF EXISTS idx_gw_dns_ts_time;
      DROP INDEX IF EXISTS idx_gw_net_ts_time;
      DROP INDEX IF EXISTS idx_shadow_it_ts_time;
      DROP INDEX IF EXISTS idx_access_logins_ts_time;
      DROP INDEX IF EXISTS idx_dau_ts_time;
      DROP INDEX IF EXISTS idx_fw_rules_lookup;
      DROP INDEX IF EXISTS idx_origin_status_lookup;
      DROP INDEX IF EXISTS idx_perf_breakdown_lookup;
      DROP INDEX IF EXISTS idx_gw_policies_lookup;
      DROP INDEX IF EXISTS idx_gw_blocked_lookup;
      DROP INDEX IF EXISTS idx_shadow_apps_lookup;
      DROP INDEX IF EXISTS idx_shadow_users_lookup;
    `);
    console.log("[db] Migration v5: raw data lake schema (17 raw tables, dropped 25 old tables)");
  }

  if (currentVersion < 6) {
    // v6: Extension dataset EAV tables – generic storage for 35+ additional GQL datasets.
    db.exec(`
      -- Time-bucketed numeric data (EAV pattern)
      CREATE TABLE IF NOT EXISTS raw_ext_ts (
        scope_id   TEXT    NOT NULL,
        scope_type TEXT    NOT NULL,
        dataset    TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        metric     TEXT    NOT NULL,
        value      REAL    NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, dataset, ts, metric)
      );

      -- Dimension breakdowns (EAV pattern)
      CREATE TABLE IF NOT EXISTS raw_ext_dim (
        scope_id   TEXT    NOT NULL,
        scope_type TEXT    NOT NULL,
        dataset    TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        dim        TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        metric     TEXT    NOT NULL DEFAULT 'count',
        value      REAL    NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, dataset, ts, dim, key, metric)
      );

      -- Indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_raw_ext_ts_scope_ds    ON raw_ext_ts(scope_id, dataset, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_ext_ts_ds_ts       ON raw_ext_ts(dataset, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_ext_dim_scope_ds   ON raw_ext_dim(scope_id, dataset, ts);
      CREATE INDEX IF NOT EXISTS idx_raw_ext_dim_ds_dim     ON raw_ext_dim(dataset, dim, ts);
    `);
    console.log("[db] Migration v6: extension dataset EAV tables (raw_ext_ts, raw_ext_dim)");
  }

  if (currentVersion < 7) {
    // v7: Persistent email schedules – survive container restarts.
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_schedules (
        id              TEXT PRIMARY KEY,
        enabled         INTEGER NOT NULL DEFAULT 1,
        report_type     TEXT NOT NULL,
        frequency       TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        hour            INTEGER NOT NULL,
        day_of_week     INTEGER,
        day_of_month    INTEGER,
        recipients      TEXT NOT NULL,
        zone_id         TEXT NOT NULL,
        zone_name       TEXT NOT NULL,
        time_range      TEXT NOT NULL DEFAULT '7d',
        subject         TEXT,
        created_at      TEXT NOT NULL,
        last_run_at     TEXT,
        last_run_status TEXT,
        last_run_error  TEXT
      );
    `);
    console.log("[db] Migration v7: email_schedules table for persistent schedule storage");
  }

  if (currentVersion < 8) {
    // v8: Add account_id/account_name for account-scoped report scheduling (ZT reports).
    db.exec(`ALTER TABLE email_schedules ADD COLUMN account_id TEXT`);
    db.exec(`ALTER TABLE email_schedules ADD COLUMN account_name TEXT`);
    console.log("[db] Migration v8: added account_id/account_name to email_schedules");
  }

  // Upsert schema version
  if (currentVersion === 0) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (currentVersion < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }
}

/** Gracefully close the database connection (for tests / shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
