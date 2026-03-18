import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  toPeriod,
  periodStart,
  periodEnd,
  currentPeriod,
  pastPeriods,
  calculateLineItem,
  calculateAllForPeriod,
  detectNewCrossings,
  getUsageForPeriod,
  getUsageHistory,
} from "@/lib/contract/usage-calculator";
import type { ContractLineItemRow } from "@/lib/contract/types";

// =============================================================================
// In-memory SQLite for testing
// =============================================================================

let db: Database.Database;

function setupSchema() {
  db.exec(`
    CREATE TABLE contract_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      committed_amount REAL NOT NULL,
      warning_threshold REAL NOT NULL DEFAULT 0.8,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE contract_usage_monthly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_item_id INTEGER NOT NULL REFERENCES contract_line_items(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      usage_value REAL NOT NULL,
      committed_amount REAL NOT NULL,
      usage_pct REAL NOT NULL,
      calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(line_item_id, period)
    );

    CREATE TABLE contract_usage_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_item_id INTEGER NOT NULL REFERENCES contract_line_items(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(line_item_id, period, alert_type)
    );

    -- Raw data tables needed by calculators
    CREATE TABLE raw_http_hourly (
      zone_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      cached_requests INTEGER NOT NULL DEFAULT 0,
      cached_bytes INTEGER NOT NULL DEFAULT 0,
      encrypted_requests INTEGER NOT NULL DEFAULT 0,
      status_1xx INTEGER NOT NULL DEFAULT 0,
      status_2xx INTEGER NOT NULL DEFAULT 0,
      status_3xx INTEGER NOT NULL DEFAULT 0,
      status_4xx INTEGER NOT NULL DEFAULT 0,
      status_5xx INTEGER NOT NULL DEFAULT 0,
      ttfb_avg REAL,
      ttfb_p50 REAL,
      ttfb_p95 REAL,
      ttfb_p99 REAL,
      origin_time_avg REAL,
      origin_time_p50 REAL,
      origin_time_p95 REAL,
      origin_time_p99 REAL,
      PRIMARY KEY (zone_id, ts)
    );

    CREATE TABLE raw_dns_hourly (
      zone_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      queries INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (zone_id, ts)
    );

    CREATE TABLE raw_ext_ts (
      scope_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      dataset TEXT NOT NULL,
      ts INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (scope_id, dataset, ts, metric)
    );

    CREATE TABLE raw_ext_dim (
      scope_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      dataset TEXT NOT NULL,
      ts INTEGER NOT NULL,
      dim TEXT NOT NULL,
      key TEXT NOT NULL,
      metric TEXT NOT NULL DEFAULT 'count',
      value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (scope_id, dataset, ts, dim, key, metric)
    );

    CREATE TABLE raw_gw_dns_hourly (
      account_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      allowed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, ts)
    );

    CREATE TABLE dns_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT NOT NULL,
      collected_at INTEGER NOT NULL,
      record_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      ttl INTEGER,
      proxied INTEGER,
      query_count INTEGER DEFAULT 0,
      has_nxdomain INTEGER DEFAULT 0,
      status TEXT,
      days_since_modified INTEGER
    );

    CREATE TABLE ssl_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT NOT NULL,
      collected_at INTEGER NOT NULL,
      cert_id TEXT NOT NULL,
      type TEXT NOT NULL,
      hosts TEXT NOT NULL,
      status TEXT NOT NULL,
      authority TEXT,
      validity_days INTEGER,
      expires_on TEXT,
      signature_algorithms TEXT
    );
  `);
}

beforeEach(() => {
  db = new Database(":memory:");
  setupSchema();
});

afterEach(() => {
  db.close();
});

// =============================================================================
// Period helpers
// =============================================================================

describe("period helpers", () => {
  it("toPeriod formats a date as YYYY-MM", () => {
    expect(toPeriod(new Date("2026-03-15T12:00:00Z"))).toBe("2026-03");
    expect(toPeriod(new Date("2025-01-01T00:00:00Z"))).toBe("2025-01");
  });

  it("periodStart returns epoch for first day of month", () => {
    const ts = periodStart("2026-03");
    expect(new Date(ts * 1000).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("periodEnd returns epoch for first day of next month", () => {
    const ts = periodEnd("2026-03");
    expect(new Date(ts * 1000).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("periodEnd handles December correctly", () => {
    const ts = periodEnd("2026-12");
    expect(new Date(ts * 1000).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("currentPeriod returns current month", () => {
    const now = new Date();
    const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(currentPeriod()).toBe(expected);
  });

  it("pastPeriods returns correct sequence", () => {
    const periods = pastPeriods("2026-03", 3);
    expect(periods).toEqual(["2026-03", "2026-02", "2026-01"]);
  });

  it("pastPeriods handles year boundary", () => {
    const periods = pastPeriods("2026-02", 4);
    expect(periods).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});

// =============================================================================
// CDN Data Transfer calculator
// =============================================================================

describe("CDN data transfer calculator", () => {
  const PERIOD = "2026-03";
  const START = periodStart(PERIOD);
  const END = periodEnd(PERIOD);

  function insertHttpData(zoneId: string, ts: number, requests: number, bytes: number) {
    db.prepare(
      `INSERT INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests,
        status_1xx, status_2xx, status_3xx, status_4xx, status_5xx)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
    ).run(zoneId, ts, requests, bytes);
  }

  function addLineItem(key: string, committed: number, threshold = 0.8): ContractLineItemRow {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount, warning_threshold)
       VALUES (?, ?, 'CDN', 'TB', ?, ?)`,
    ).run(key, key, committed, threshold);
    return db.prepare("SELECT * FROM contract_line_items WHERE product_key = ?").get(key) as ContractLineItemRow;
  }

  it("calculates data transfer across multiple zones", () => {
    const item = addLineItem("cdn-data-transfer", 40);

    // Insert 10 TB across two zones
    const bytesPerHour = 5e12 / 24; // ~5 TB per zone per day
    for (let h = 0; h < 24; h++) {
      insertHttpData("zone1", START + h * 3600, 1000, bytesPerHour);
      insertHttpData("zone2", START + h * 3600, 500, bytesPerHour);
    }

    const result = calculateLineItem(db, item, PERIOD);
    expect(result.dataAvailable).toBe(true);
    // 2 zones * 5 TB / day * 1 day = ~10 TB
    expect(result.usageValue).toBeCloseTo(10, 0);
    expect(result.usagePct).toBeCloseTo(25, 0); // 10/40 = 25%
  });

  it("returns noData when no rows exist", () => {
    const item = addLineItem("cdn-data-transfer", 40);
    const result = calculateLineItem(db, item, PERIOD);
    expect(result.dataAvailable).toBe(false);
    expect(result.usageValue).toBe(0);
  });

  it("returns noData for unknown product key", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount)
       VALUES ('unknown-product', 'Unknown', 'Other', 'units', 100)`,
    ).run();
    const item = db.prepare("SELECT * FROM contract_line_items WHERE product_key = 'unknown-product'").get() as ContractLineItemRow;

    const result = calculateLineItem(db, item, PERIOD);
    expect(result.dataAvailable).toBe(false);
  });
});

// =============================================================================
// DNS queries calculator
// =============================================================================

describe("DNS queries calculator", () => {
  const PERIOD = "2026-03";
  const START = periodStart(PERIOD);

  it("sums queries across zones", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount)
       VALUES ('dns-queries', 'DNS Queries', 'DNS', 'MM', 60)`,
    ).run();
    const item = db.prepare("SELECT * FROM contract_line_items WHERE product_key = 'dns-queries'").get() as ContractLineItemRow;

    // Insert 10M queries
    db.prepare("INSERT INTO raw_dns_hourly (zone_id, ts, queries) VALUES (?, ?, ?)").run("z1", START, 5_000_000);
    db.prepare("INSERT INTO raw_dns_hourly (zone_id, ts, queries) VALUES (?, ?, ?)").run("z2", START, 5_000_000);

    const result = calculateLineItem(db, item, PERIOD);
    expect(result.dataAvailable).toBe(true);
    expect(result.usageValue).toBeCloseTo(10, 0); // 10 MM
    expect(result.usagePct).toBeCloseTo(16.67, 0); // 10/60
  });
});

// =============================================================================
// Workers calculator (ext_ts)
// =============================================================================

describe("Workers requests calculator", () => {
  const PERIOD = "2026-03";
  const START = periodStart(PERIOD);

  it("sums worker invocations from ext_ts", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount)
       VALUES ('workers-requests', 'Workers', 'Workers', 'MM', 600)`,
    ).run();
    const item = db.prepare("SELECT * FROM contract_line_items WHERE product_key = 'workers-requests'").get() as ContractLineItemRow;

    // 100M requests
    db.prepare(
      "INSERT INTO raw_ext_ts (scope_id, scope_type, dataset, ts, metric, value) VALUES (?, 'account', 'ext:workers', ?, 'sum.requests', ?)",
    ).run("acct1", START, 100_000_000);

    const result = calculateLineItem(db, item, PERIOD);
    expect(result.dataAvailable).toBe(true);
    expect(result.usageValue).toBeCloseTo(100, 0); // 100 MM
    expect(result.usagePct).toBeCloseTo(16.67, 0);
  });
});

// =============================================================================
// calculateAllForPeriod
// =============================================================================

describe("calculateAllForPeriod", () => {
  const PERIOD = "2026-03";
  const START = periodStart(PERIOD);

  it("calculates all enabled items and stores results", () => {
    // Add two items
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount)
       VALUES ('cdn-requests', 'CDN Requests', 'CDN', 'MM', 600)`,
    ).run();
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount, enabled)
       VALUES ('dns-queries', 'DNS Queries', 'DNS', 'MM', 60, 0)`,
    ).run(); // disabled

    // Insert HTTP data
    db.prepare(
      "INSERT INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    ).run("z1", START, 300_000_000);

    const results = calculateAllForPeriod(db, PERIOD);
    expect(results.length).toBe(1); // Only enabled items

    // Verify stored in DB
    const stored = getUsageForPeriod(db, PERIOD);
    expect(stored.length).toBe(1);
    expect(stored[0].usage_value).toBeCloseTo(300, 0);
  });

  it("is idempotent (recalculation overwrites)", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount)
       VALUES ('cdn-requests', 'CDN Requests', 'CDN', 'MM', 600)`,
    ).run();

    db.prepare(
      "INSERT INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    ).run("z1", START, 100_000_000);

    calculateAllForPeriod(db, PERIOD);
    let stored = getUsageForPeriod(db, PERIOD);
    expect(stored[0].usage_value).toBeCloseTo(100, 0);

    // Add more data and recalculate
    db.prepare(
      "INSERT OR REPLACE INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    ).run("z1", START, 200_000_000);

    calculateAllForPeriod(db, PERIOD);
    stored = getUsageForPeriod(db, PERIOD);
    expect(stored[0].usage_value).toBeCloseTo(200, 0);
  });
});

// =============================================================================
// Alert detection
// =============================================================================

describe("detectNewCrossings", () => {
  const PERIOD = "2026-03";
  const START = periodStart(PERIOD);

  it("detects warning threshold crossing", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount, warning_threshold)
       VALUES ('cdn-requests', 'CDN Requests', 'CDN', 'MM', 100, 0.8)`,
    ).run();

    // Insert 85M requests (85% > 80% threshold)
    db.prepare(
      "INSERT INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    ).run("z1", START, 85_000_000);

    const results = calculateAllForPeriod(db, PERIOD);
    const crossings = detectNewCrossings(db, results);

    expect(crossings.length).toBe(1);
    expect(crossings[0].alertType).toBe("warning");
    expect(crossings[0].productKey).toBe("cdn-requests");
  });

  it("detects exceeded crossing", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount, warning_threshold)
       VALUES ('cdn-requests', 'CDN Requests', 'CDN', 'MM', 100, 0.8)`,
    ).run();

    // Insert 120M requests (120% > 100%)
    db.prepare(
      "INSERT INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    ).run("z1", START, 120_000_000);

    const results = calculateAllForPeriod(db, PERIOD);
    const crossings = detectNewCrossings(db, results);

    // Both warning AND exceeded
    expect(crossings.length).toBe(2);
    expect(crossings.map((c) => c.alertType).sort()).toEqual(["exceeded", "warning"]);
  });

  it("does not re-alert for the same period", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount, warning_threshold)
       VALUES ('cdn-requests', 'CDN Requests', 'CDN', 'MM', 100, 0.8)`,
    ).run();

    db.prepare(
      "INSERT INTO raw_http_hourly (zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    ).run("z1", START, 85_000_000);

    const results = calculateAllForPeriod(db, PERIOD);
    const crossings1 = detectNewCrossings(db, results);
    expect(crossings1.length).toBe(1);

    // Run again – should not re-alert
    const crossings2 = detectNewCrossings(db, results);
    expect(crossings2.length).toBe(0);
  });
});

// =============================================================================
// Usage history
// =============================================================================

describe("getUsageHistory", () => {
  it("returns history for a line item", () => {
    db.prepare(
      `INSERT INTO contract_line_items (product_key, display_name, category, unit, committed_amount)
       VALUES ('cdn-requests', 'CDN Requests', 'CDN', 'MM', 600)`,
    ).run();
    const item = db.prepare("SELECT * FROM contract_line_items WHERE product_key = 'cdn-requests'").get() as ContractLineItemRow;

    // Insert historical usage records
    db.prepare(
      "INSERT INTO contract_usage_monthly (line_item_id, period, usage_value, committed_amount, usage_pct) VALUES (?, ?, ?, ?, ?)",
    ).run(item.id, "2026-01", 100, 600, 16.67);
    db.prepare(
      "INSERT INTO contract_usage_monthly (line_item_id, period, usage_value, committed_amount, usage_pct) VALUES (?, ?, ?, ?, ?)",
    ).run(item.id, "2026-02", 200, 600, 33.33);
    db.prepare(
      "INSERT INTO contract_usage_monthly (line_item_id, period, usage_value, committed_amount, usage_pct) VALUES (?, ?, ?, ?, ?)",
    ).run(item.id, "2026-03", 300, 600, 50);

    const history = getUsageHistory(db, item.id, 12);
    expect(history.length).toBe(3);
    // Ordered by period DESC
    expect(history[0].period).toBe("2026-03");
    expect(history[2].period).toBe("2026-01");
  });
});
