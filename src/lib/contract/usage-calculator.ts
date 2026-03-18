/**
 * Contract Usage – Calculation Engine
 *
 * Runs after each collector cycle (and on-demand) to compute monthly usage
 * for all enabled contract line items. Results are stored in
 * contract_usage_monthly as permanent historical records.
 */

import type Database from "better-sqlite3";
import { CATALOG_BY_KEY } from "./catalog";
import type { ContractLineItemRow, ContractUsageMonthlyRow } from "./types";

// =============================================================================
// Period helpers
// =============================================================================

/** Returns "YYYY-MM" for the given date (UTC). */
export function toPeriod(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Returns UTC epoch seconds for the start of a month period "YYYY-MM". */
export function periodStart(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m - 1, 1)).getTime() / 1000);
}

/** Returns UTC epoch seconds for the start of the NEXT month (exclusive end). */
export function periodEnd(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return Math.floor(new Date(Date.UTC(y, m, 1)).getTime() / 1000);
}

/** Returns current period "YYYY-MM" in UTC. */
export function currentPeriod(): string {
  return toPeriod(new Date());
}

/** Returns an array of period strings going back `months` from the given period. */
export function pastPeriods(fromPeriod: string, months: number): string[] {
  const [y, m] = fromPeriod.split("-").map(Number);
  const periods: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    periods.push(toPeriod(d));
  }
  return periods;
}

// =============================================================================
// Core calculation
// =============================================================================

interface CalculationResult {
  lineItemId: number;
  productKey: string;
  period: string;
  usageValue: number;
  committedAmount: number;
  usagePct: number;
  dataAvailable: boolean;
}

/**
 * Calculate usage for a single line item in a single period.
 */
export function calculateLineItem(
  db: Database.Database,
  item: ContractLineItemRow,
  period: string,
): CalculationResult {
  const catalog = CATALOG_BY_KEY.get(item.product_key);
  if (!catalog) {
    return {
      lineItemId: item.id,
      productKey: item.product_key,
      period,
      usageValue: 0,
      committedAmount: item.committed_amount,
      usagePct: 0,
      dataAvailable: false,
    };
  }

  const start = periodStart(period);
  const end = periodEnd(period);
  const result = catalog.calculator(db, start, end);

  const pct = item.committed_amount > 0
    ? Math.round((result.value / item.committed_amount) * 10000) / 100
    : 0;

  return {
    lineItemId: item.id,
    productKey: item.product_key,
    period,
    usageValue: result.value,
    committedAmount: item.committed_amount,
    usagePct: pct,
    dataAvailable: result.dataAvailable,
  };
}

/**
 * Calculate usage for all enabled line items for a given period.
 * Stores results in contract_usage_monthly.
 * Returns results for post-calculation alert processing.
 */
export function calculateAllForPeriod(
  db: Database.Database,
  period: string,
): CalculationResult[] {
  const items = db.prepare(
    `SELECT * FROM contract_line_items WHERE enabled = 1`,
  ).all() as ContractLineItemRow[];

  if (items.length === 0) return [];

  const results: CalculationResult[] = [];
  const upsert = db.prepare(
    `INSERT INTO contract_usage_monthly (line_item_id, period, usage_value, committed_amount, usage_pct, calculated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(line_item_id, period) DO UPDATE SET
       usage_value = excluded.usage_value,
       committed_amount = excluded.committed_amount,
       usage_pct = excluded.usage_pct,
       calculated_at = excluded.calculated_at`,
  );

  const tx = db.transaction(() => {
    for (const item of items) {
      const calc = calculateLineItem(db, item, period);
      results.push(calc);

      if (calc.dataAvailable) {
        upsert.run(
          calc.lineItemId,
          calc.period,
          calc.usageValue,
          calc.committedAmount,
          calc.usagePct,
        );
      }
    }
  });

  tx();
  return results;
}

/**
 * Back-calculate historical months where raw data exists (up to 12 months).
 * Called when a line item is first added.
 */
export function backCalculateHistory(
  db: Database.Database,
  months = 12,
): void {
  const current = currentPeriod();
  const periods = pastPeriods(current, months);

  for (const period of periods) {
    calculateAllForPeriod(db, period);
  }
}

// =============================================================================
// Alert detection
// =============================================================================

export interface ThresholdCrossing {
  lineItemId: number;
  productKey: string;
  displayName: string;
  category: string;
  unit: string;
  usageValue: number;
  committedAmount: number;
  usagePct: number;
  alertType: "warning" | "exceeded";
  period: string;
}

/**
 * Check calculation results for new threshold crossings.
 * Returns crossings that haven't been alerted yet (and records them).
 */
export function detectNewCrossings(
  db: Database.Database,
  results: CalculationResult[],
): ThresholdCrossing[] {
  const items = new Map<number, ContractLineItemRow>();
  const allItems = db.prepare(
    `SELECT * FROM contract_line_items WHERE enabled = 1`,
  ).all() as ContractLineItemRow[];
  for (const item of allItems) items.set(item.id, item);

  const crossings: ThresholdCrossing[] = [];

  const checkAlert = db.prepare(
    `SELECT 1 FROM contract_usage_alerts
     WHERE line_item_id = ? AND period = ? AND alert_type = ?`,
  );
  const insertAlert = db.prepare(
    `INSERT OR IGNORE INTO contract_usage_alerts (line_item_id, period, alert_type)
     VALUES (?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const calc of results) {
      if (!calc.dataAvailable) continue;
      const item = items.get(calc.lineItemId);
      if (!item) continue;

      const catalog = CATALOG_BY_KEY.get(calc.productKey);
      if (!catalog) continue;

      // Check exceeded (100%) first, then warning
      const alertTypes: Array<{ type: "warning" | "exceeded"; threshold: number }> = [];

      if (calc.usagePct >= 100) {
        alertTypes.push({ type: "exceeded", threshold: 100 });
      }
      if (calc.usagePct >= item.warning_threshold * 100) {
        alertTypes.push({ type: "warning", threshold: item.warning_threshold * 100 });
      }

      for (const { type } of alertTypes) {
        const existing = checkAlert.get(calc.lineItemId, calc.period, type);
        if (!existing) {
          insertAlert.run(calc.lineItemId, calc.period, type);
          crossings.push({
            lineItemId: calc.lineItemId,
            productKey: calc.productKey,
            displayName: catalog.displayName,
            category: catalog.category,
            unit: catalog.unit,
            usageValue: calc.usageValue,
            committedAmount: calc.committedAmount,
            usagePct: calc.usagePct,
            alertType: type,
            period: calc.period,
          });
        }
      }
    }
  });

  tx();
  return crossings;
}

// =============================================================================
// Read helpers (for report page)
// =============================================================================

/**
 * Get usage data for a specific period (from contract_usage_monthly cache).
 */
export function getUsageForPeriod(
  db: Database.Database,
  period: string,
): ContractUsageMonthlyRow[] {
  return db.prepare(
    `SELECT * FROM contract_usage_monthly WHERE period = ? ORDER BY line_item_id`,
  ).all(period) as ContractUsageMonthlyRow[];
}

/**
 * Get usage history for a specific line item (last N months).
 */
export function getUsageHistory(
  db: Database.Database,
  lineItemId: number,
  months = 12,
): ContractUsageMonthlyRow[] {
  return db.prepare(
    `SELECT * FROM contract_usage_monthly
     WHERE line_item_id = ?
     ORDER BY period DESC
     LIMIT ?`,
  ).all(lineItemId, months) as ContractUsageMonthlyRow[];
}
