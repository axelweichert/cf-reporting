/**
 * Contract Usage / License Tracking – Type Definitions
 */

import type Database from "better-sqlite3";

// =============================================================================
// Database row types
// =============================================================================

export interface ContractLineItemRow {
  id: number;
  product_key: string;
  display_name: string;
  category: string;
  unit: string;
  committed_amount: number;
  warning_threshold: number;
  enabled: number; // SQLite boolean (0/1)
  sort_order: number;
  account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractUsageMonthlyRow {
  id: number;
  line_item_id: number;
  period: string; // "YYYY-MM"
  usage_value: number;
  committed_amount: number;
  usage_pct: number;
  calculated_at: string;
}

export interface ContractUsageAlertRow {
  id: number;
  line_item_id: number;
  period: string;
  alert_type: "warning" | "exceeded";
  sent_at: string;
}

// =============================================================================
// API / UI types
// =============================================================================

export interface ContractLineItem {
  id: number;
  productKey: string;
  displayName: string;
  category: string;
  unit: string;
  committedAmount: number;
  warningThreshold: number;
  enabled: boolean;
  sortOrder: number;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractUsageEntry {
  lineItemId: number;
  productKey: string;
  displayName: string;
  category: string;
  unit: string;
  committedAmount: number;
  warningThreshold: number;
  usageValue: number;
  usagePct: number;
  dataAvailable: boolean;
  calculatedAt: string;
  /** True for point-in-time counts (seats, zones) – display as integers, no projection */
  snapshot?: boolean;
}

export interface ContractUsageMonthly {
  period: string;
  entries: ContractUsageEntry[];
  summary: {
    totalItems: number;
    atWarning: number;
    overLimit: number;
    healthPct: number; // % of items under their warning threshold
  };
}

export interface ContractUsageHistoryMonth {
  period: string;
  usageValue: number;
  committedAmount: number;
  usagePct: number;
  projected?: number; // Extrapolated full-month value for the current partial month
}

export interface ContractUsageHistory {
  productKey: string;
  displayName: string;
  unit: string;
  snapshot?: boolean;
  months: ContractUsageHistoryMonth[];
}

/** All histories in one response (for the chart view). */
export interface ContractUsageAllHistories {
  histories: ContractUsageHistory[];
}

// =============================================================================
// Product catalog types
// =============================================================================

export interface UsageResult {
  /** Usage value in the display unit (e.g., 23.5 = 23.5 TB) */
  value: number;
  /** Raw value before unit conversion (e.g., bytes) */
  rawValue: number;
  /** Whether raw data exists for this product in the given period */
  dataAvailable: boolean;
}

export type UsageCalculatorFn = (
  db: Database.Database,
  monthStart: number, // unix epoch seconds (UTC month start)
  monthEnd: number,   // unix epoch seconds (UTC month end, exclusive)
  accountId?: string, // Filter to this account (null = all)
) => UsageResult;

/** Per-zone breakdown of usage for a single line item. */
export type ZoneBreakdownFn = (
  db: Database.Database,
  monthStart: number,
  monthEnd: number,
  accountId?: string,
) => Array<{ zoneId: string; zoneName: string; usageValue: number }>;

export interface ContractUsageZoneBreakdown {
  lineItemId: number;
  productKey: string;
  period: string;
  zones: Array<{ zoneId: string; zoneName: string; usageValue: number; unit: string }>;
}

export interface ProductCatalogEntry {
  /** Stable identifier, e.g. "cdn-data-transfer" */
  key: string;
  /** Default display name, e.g. "CDN \u2013 Data Transfer" */
  displayName: string;
  /** Product category, e.g. "CDN", "Workers", "R2" */
  category: string;
  /** Display unit, e.g. "TB", "MM requests" */
  unit: string;
  /** Short description of what this metric measures */
  description: string;
  /** Data source key(s) for auto-detection probing */
  probeTable: ProbeTarget;
  /** Whether this is zone-scoped (true) or account-scoped (false, e.g. Workers, R2, ZT) */
  zoneScoped: boolean;
  /** True for point-in-time counts (seats, zones, records) – shown as integers, no projection */
  snapshot?: boolean;
  /** Function to calculate usage from raw SQLite data */
  calculator: UsageCalculatorFn;
  /** Optional: per-zone breakdown for zone-scoped products */
  zoneBreakdown?: ZoneBreakdownFn;
}

export type ProbeTarget =
  | { type: "raw_http" }
  | { type: "raw_dns" }
  | { type: "raw_gw_dns" }
  | { type: "dns_records" }
  | { type: "ext"; dataset: string }
  | { type: "ext_dim"; dataset: string }
  | { type: "zones" }
  | { type: "ssl_certs" }
  | { type: "zt_users" }
  | { type: "always" }; // Always available (e.g., WAF = same as CDN)

// =============================================================================
// API request/response types
// =============================================================================

export interface CreateLineItemRequest {
  productKey: string;
  committedAmount: number;
  warningThreshold?: number;
  accountId?: string;
}

export interface UpdateLineItemRequest {
  id: number;
  committedAmount?: number;
  warningThreshold?: number;
  enabled?: boolean;
  sortOrder?: number;
}

export interface DetectResult {
  key: string;
  displayName: string;
  category: string;
  unit: string;
  description: string;
  detected: boolean;
}
