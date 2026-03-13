/**
 * Generic extension dataset fetcher – builds GQL queries from registry
 * definitions, executes them, and stores results into EAV tables.
 *
 * One GQL call per dataset. Permission errors are caught and reported
 * as "skipped" (not "error") by the caller.
 */

import { CloudflareClient } from "@/lib/cf-client";
import { getDb } from "@/lib/db";
import type { ExtDatasetDef, ExtMetricDef } from "./ext-datasets";

// =============================================================================
// Row types for the EAV tables
// =============================================================================

export interface ExtTsRow {
  scope_id: string;
  scope_type: string;
  dataset: string;
  ts: number;
  metric: string;
  value: number;
}

export interface ExtDimRow {
  scope_id: string;
  scope_type: string;
  dataset: string;
  ts: number;
  dim: string;
  key: string;
  metric: string;
  value: number;
}

// =============================================================================
// GQL query builder
// =============================================================================

/**
 * Format a since/until value for the GQL filter based on the time dimension.
 * - "date" → "YYYY-MM-DD"
 * - "datetimeHour" / "datetime" → ISO string
 */
function formatFilterValue(timeDim: string, isoDate: string): string {
  if (timeDim === "date") {
    return isoDate.slice(0, 10);
  }
  return isoDate;
}

/**
 * Group metrics by their aggregate block (sum, avg, max) to build the
 * GQL selection for aggregate fields.
 */
function buildAggregateSelection(metrics: ExtMetricDef[]): string {
  const groups: Record<string, string[]> = {};

  for (const m of metrics) {
    if (m.path === "count") continue;
    const dotIdx = m.path.indexOf(".");
    if (dotIdx === -1) continue;
    const block = m.path.slice(0, dotIdx);
    const field = m.path.slice(dotIdx + 1);
    if (!groups[block]) groups[block] = [];
    groups[block].push(field);
  }

  return Object.entries(groups)
    .map(([block, fields]) => `${block} { ${fields.join(" ")} }`)
    .join("\n            ");
}

/**
 * Determine the best orderBy and value metric for dimension breakdowns.
 * If count is available, use count_DESC. Otherwise use first sum/max field.
 */
function getDimOrderInfo(def: ExtDatasetDef): { orderBy: string; selection: string; metricName: string; extract: string } | null {
  if (def.hasCount) {
    return { orderBy: "count_DESC", selection: "count", metricName: "count", extract: "count" };
  }
  // Find first sum or max metric for ordering
  for (const m of def.metrics) {
    if (m.path === "count") continue;
    const dotIdx = m.path.indexOf(".");
    if (dotIdx === -1) continue;
    const block = m.path.slice(0, dotIdx); // "sum" | "max" | "avg"
    const field = m.path.slice(dotIdx + 1);
    return {
      orderBy: `${block}_${field}_DESC`,
      selection: `${block} { ${field} }`,
      metricName: m.name,
      extract: m.path,
    };
  }
  return null; // No suitable metric – skip dim breakdowns
}

/**
 * Build the full GQL query for a dataset.
 */
function buildQuery(
  def: ExtDatasetDef,
  scopeId: string,
  since: string,
  until: string,
): string {
  const filterSince = formatFilterValue(def.timeDim, since);
  const filterUntil = formatFilterValue(def.timeDim, until);
  const aggSelection = buildAggregateSelection(def.metrics);

  // Main time series query
  const mainQuery = `
      ts: ${def.gqlNode}(
        filter: { ${def.timeDim}_geq: "${filterSince}", ${def.timeDim}_lt: "${filterUntil}" }
        limit: ${def.limit}
        orderBy: [${def.timeDim}_ASC]
      ) {
        ${def.hasCount ? "count" : ""}
        dimensions { ${def.timeDim} }
        ${aggSelection}
      }`;

  // Dimension breakdown queries (aliases) – need a viable orderBy metric
  const dimOrder = getDimOrderInfo(def);
  const dimQueries = dimOrder ? def.dimensions.map((d) => `
      ${d.alias}: ${def.gqlNode}(
        filter: { ${def.timeDim}_geq: "${filterSince}", ${def.timeDim}_lt: "${filterUntil}" }
        limit: ${d.limit}
        orderBy: [${dimOrder.orderBy}]
      ) {
        ${dimOrder.selection}
        dimensions { ${def.timeDim} ${d.field} }
      }`).join("") : "";

  return `{
    viewer {
      ${def.parentNode}(filter: { ${def.scopeFilter}: "${scopeId}" }) {${mainQuery}${dimQueries}
      }
    }
  }`;
}

// =============================================================================
// Response parsing
// =============================================================================

/** Convert a GQL time dimension value to a unix epoch, bucketed appropriately. */
function parseTimestamp(value: string, timeBucket: "hour" | "day"): number {
  if (timeBucket === "day") {
    // "2024-01-15" or "2024-01-15T00:00:00Z"
    const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  // Hour bucket: round down to the hour
  const epoch = Math.floor(new Date(value).getTime() / 1000);
  return epoch - (epoch % 3600);
}

/** Extract a nested value from a GQL row using a dot-path like "sum.requests" */
function extractValue(row: Record<string, unknown>, path: string): number | null {
  if (path === "count") {
    return typeof row.count === "number" ? row.count : null;
  }
  const dotIdx = path.indexOf(".");
  if (dotIdx === -1) return null;
  const block = path.slice(0, dotIdx);
  const field = path.slice(dotIdx + 1);
  const obj = row[block] as Record<string, unknown> | null | undefined;
  if (!obj) return null;
  const val = obj[field];
  return typeof val === "number" ? val : null;
}

/**
 * Parse the GQL response for a dataset into EAV rows.
 */
function parseResponse(
  def: ExtDatasetDef,
  scopeId: string,
  data: Record<string, unknown>,
): { ts: ExtTsRow[]; dims: ExtDimRow[] } {
  const tsRows: ExtTsRow[] = [];
  const dimRows: ExtDimRow[] = [];

  const scopeType = def.scope;
  const dataset = def.gqlNode;

  // Navigate to the scope data
  const viewer = data.viewer as Record<string, unknown> | undefined;
  if (!viewer) return { ts: tsRows, dims: dimRows };
  const scopeArr = viewer[def.parentNode] as Array<Record<string, unknown>> | undefined;
  if (!scopeArr || scopeArr.length === 0) return { ts: tsRows, dims: dimRows };
  const scopeData = scopeArr[0];

  // Parse main time series
  const mainRows = scopeData.ts as Array<Record<string, unknown>> | undefined;
  if (mainRows) {
    for (const row of mainRows) {
      const dims = row.dimensions as Record<string, string> | undefined;
      if (!dims?.[def.timeDim]) continue;
      const ts = parseTimestamp(dims[def.timeDim], def.timeBucket);

      for (const metric of def.metrics) {
        const value = extractValue(row, metric.path);
        if (value !== null) {
          tsRows.push({ scope_id: scopeId, scope_type: scopeType, dataset, ts, metric: metric.name, value });
        }
      }
    }
  }

  // Parse dimension breakdowns
  const dimOrder = getDimOrderInfo(def);
  if (dimOrder) {
    for (const dimDef of def.dimensions) {
      const breakdownRows = scopeData[dimDef.alias] as Array<Record<string, unknown>> | undefined;
      if (!breakdownRows) continue;

      for (const row of breakdownRows) {
        const dims = row.dimensions as Record<string, string> | undefined;
        if (!dims?.[def.timeDim]) continue;
        const ts = parseTimestamp(dims[def.timeDim], def.timeBucket);
        const key = String(dims[dimDef.field] ?? "unknown");
        const value = extractValue(row, dimOrder.extract) ?? 0;

        dimRows.push({
          scope_id: scopeId,
          scope_type: scopeType,
          dataset,
          ts,
          dim: dimDef.dimName,
          key,
          metric: dimOrder.metricName,
          value,
        });
      }
    }
  }

  return { ts: tsRows, dims: dimRows };
}

// =============================================================================
// Fetch + store
// =============================================================================

/**
 * Fetch a single extension dataset and store results into EAV tables.
 * Returns the number of rows stored.
 */
export async function fetchAndStoreExtDataset(
  client: CloudflareClient,
  def: ExtDatasetDef,
  scopeId: string,
  since: string,
  until: string,
): Promise<{ tsRows: number; dimRows: number }> {
  // Skip datasets with no metrics defined (nothing useful to store)
  if (def.metrics.length === 0 && def.dimensions.length === 0) {
    return { tsRows: 0, dimRows: 0 };
  }

  const query = buildQuery(def, scopeId, since, until);

  const res = await client.graphql<Record<string, unknown>>(query);
  if (res.errors?.length) {
    throw new Error(res.errors[0].message);
  }

  const { ts, dims } = parseResponse(def, scopeId, res.data);

  storeExtTsRows(ts);
  storeExtDimRows(dims);

  return { tsRows: ts.length, dimRows: dims.length };
}

// =============================================================================
// Store functions
// =============================================================================

function storeExtTsRows(rows: ExtTsRow[]): void {
  const db = getDb();
  if (!db || rows.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_ext_ts (scope_id, scope_type, dataset, ts, metric, value)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.scope_id, r.scope_type, r.dataset, r.ts, r.metric, r.value);
    }
  })();
}

function storeExtDimRows(rows: ExtDimRow[]): void {
  const db = getDb();
  if (!db || rows.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_ext_dim (scope_id, scope_type, dataset, ts, dim, key, metric, value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.scope_id, r.scope_type, r.dataset, r.ts, r.dim, r.key, r.metric, r.value);
    }
  })();
}

// =============================================================================
// Last timestamp query (independent per dataset)
// =============================================================================

/**
 * Get the most recent timestamp for an extension dataset.
 * Each ext dataset has its own cursor – independent of core datasets.
 */
export function getExtLastTimestamp(scopeId: string, dataset: string): number | null {
  const db = getDb();
  if (!db) return null;

  const row = db.prepare(
    "SELECT MAX(ts) as max_ts FROM raw_ext_ts WHERE scope_id = ? AND dataset = ?",
  ).get(scopeId, dataset) as { max_ts: number | null } | undefined;

  return row?.max_ts ?? null;
}
