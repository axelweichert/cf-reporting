/**
 * Generic extension dataset fetcher – builds GQL queries from registry
 * definitions, executes them, and stores results into EAV tables.
 *
 * Supports batched queries: multiple datasets combined into a single GQL
 * request (CF counts as 1 query against the 300/5min GQL rate limit).
 * Falls back to individual queries if a batch fails.
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
// Batched GQL query builder
// =============================================================================

/** Max datasets per batch – keeps query complexity reasonable */
const BATCH_SIZE = 10;

/**
 * Build a single GQL query that fetches multiple datasets in one request.
 * Uses GQL aliases to disambiguate datasets under the same scope node.
 *
 * All datasets in a batch MUST share the same scope type (zone or account)
 * and the same scopeId. Returns null if defs is empty.
 */
function buildBatchQuery(
  defs: ExtDatasetDef[],
  scopeId: string,
  since: string,
  until: string,
): string | null {
  if (defs.length === 0) return null;

  const first = defs[0];
  const fragments: string[] = [];

  for (const def of defs) {
    const filterSince = formatFilterValue(def.timeDim, since);
    const filterUntil = formatFilterValue(def.timeDim, until);
    const aggSelection = buildAggregateSelection(def.metrics);
    // Skip datasets with no metrics and no dimensions
    if (def.metrics.length === 0 && def.dimensions.length === 0) continue;

    // Use gqlNode as alias prefix for disambiguation
    const alias = `ts_${def.key.replace(/[^a-zA-Z0-9]/g, "_")}`;
    fragments.push(`
      ${alias}: ${def.gqlNode}(
        filter: { ${def.timeDim}_geq: "${filterSince}", ${def.timeDim}_lt: "${filterUntil}" }
        limit: ${def.limit}
        orderBy: [${def.timeDim}_ASC]
      ) {
        ${def.hasCount ? "count" : ""}
        dimensions { ${def.timeDim} }
        ${aggSelection}
      }`);

    // Dimension breakdowns
    const dimOrder = getDimOrderInfo(def);
    if (dimOrder) {
      for (const d of def.dimensions) {
        const dimAlias = `dim_${def.key.replace(/[^a-zA-Z0-9]/g, "_")}_${d.field}`;
        fragments.push(`
      ${dimAlias}: ${def.gqlNode}(
        filter: { ${def.timeDim}_geq: "${filterSince}", ${def.timeDim}_lt: "${filterUntil}" }
        limit: ${d.limit}
        orderBy: [${dimOrder.orderBy}]
      ) {
        ${dimOrder.selection}
        dimensions { ${def.timeDim} ${d.field} }
      }`);
      }
    }
  }

  if (fragments.length === 0) return null;

  return `{
    viewer {
      ${first.parentNode}(filter: { ${first.scopeFilter}: "${scopeId}" }) {${fragments.join("")}
      }
    }
  }`;
}

/**
 * Parse a batched response for multiple datasets.
 */
function parseBatchResponse(
  defs: ExtDatasetDef[],
  scopeId: string,
  data: Record<string, unknown>,
): Map<string, { ts: ExtTsRow[]; dims: ExtDimRow[] }> {
  const results = new Map<string, { ts: ExtTsRow[]; dims: ExtDimRow[] }>();

  const viewer = data.viewer as Record<string, unknown> | undefined;
  if (!viewer) return results;

  const first = defs[0];
  const scopeArr = viewer[first.parentNode] as Array<Record<string, unknown>> | undefined;
  if (!scopeArr || scopeArr.length === 0) return results;
  const scopeData = scopeArr[0];

  for (const def of defs) {
    const tsRows: ExtTsRow[] = [];
    const dimRows: ExtDimRow[] = [];
    const scopeType = def.scope;
    const dataset = def.gqlNode;

    // Parse main time series
    const alias = `ts_${def.key.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const mainRows = scopeData[alias] as Array<Record<string, unknown>> | undefined;
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
        const dimAlias = `dim_${def.key.replace(/[^a-zA-Z0-9]/g, "_")}_${dimDef.field}`;
        const breakdownRows = scopeData[dimAlias] as Array<Record<string, unknown>> | undefined;
        if (!breakdownRows) continue;

        for (const row of breakdownRows) {
          const dims = row.dimensions as Record<string, string> | undefined;
          if (!dims?.[def.timeDim]) continue;
          const ts = parseTimestamp(dims[def.timeDim], def.timeBucket);
          const key = String(dims[dimDef.field] ?? "unknown");
          const value = extractValue(row, dimOrder.extract) ?? 0;

          dimRows.push({
            scope_id: scopeId, scope_type: scopeType, dataset,
            ts, dim: dimDef.dimName, key, metric: dimOrder.metricName, value,
          });
        }
      }
    }

    results.set(def.key, { ts: tsRows, dims: dimRows });
  }

  return results;
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

/**
 * Fetch a batch of extension datasets in a single GQL request.
 * Returns per-dataset results. If the batch fails, returns null
 * so the caller can fall back to individual queries.
 */
export async function fetchBatchExtDatasets(
  client: CloudflareClient,
  defs: ExtDatasetDef[],
  scopeId: string,
  since: string,
  until: string,
): Promise<Map<string, { tsRows: number; dimRows: number }> | null> {
  const query = buildBatchQuery(defs, scopeId, since, until);
  if (!query) return new Map();

  try {
    const res = await client.graphql<Record<string, unknown>>(query);
    if (res.errors?.length) {
      // If the batch fails, return null to signal fallback
      return null;
    }

    const parsed = parseBatchResponse(defs, scopeId, res.data);
    const results = new Map<string, { tsRows: number; dimRows: number }>();

    for (const [key, { ts, dims }] of parsed) {
      storeExtTsRows(ts);
      storeExtDimRows(dims);
      results.set(key, { tsRows: ts.length, dimRows: dims.length });
    }

    return results;
  } catch {
    // Batch failed – caller should retry individually
    return null;
  }
}

export { BATCH_SIZE };

// =============================================================================
// Settings discovery – notOlderThan / maxDuration per dataset
// =============================================================================

export interface DatasetLimits {
  /** Max age in seconds (0 = no access / no data) */
  notOlderThan: number;
  /** Max query time span in seconds (0 = no access / no data) */
  maxDuration: number;
}

/**
 * Query the CF GraphQL settings node to discover per-dataset retention
 * limits (notOlderThan) and max query durations. Returns a map keyed
 * by gqlNode name. One GQL request per scope.
 *
 * Datasets not present in the response (no access) get { 0, 0 }.
 */
export async function discoverDatasetLimits(
  client: CloudflareClient,
  defs: ExtDatasetDef[],
  scopeId: string,
): Promise<Map<string, DatasetLimits>> {
  const results = new Map<string, DatasetLimits>();
  if (defs.length === 0) return results;

  const first = defs[0];
  // Build settings sub-selections for each dataset
  const settingsFields = defs.map((d) =>
    `${d.gqlNode} { notOlderThan maxDuration }`
  ).join("\n        ");

  const query = `{
    viewer {
      ${first.parentNode}(filter: { ${first.scopeFilter}: "${scopeId}" }) {
        settings {
          ${settingsFields}
        }
      }
    }
  }`;

  try {
    const res = await client.graphql<Record<string, unknown>>(query);
    if (res.errors?.length) {
      // If discovery fails, return empty map – caller will use defaults
      return results;
    }

    const viewer = res.data.viewer as Record<string, unknown> | undefined;
    if (!viewer) return results;
    const scopeArr = viewer[first.parentNode] as Array<Record<string, unknown>> | undefined;
    if (!scopeArr?.[0]) return results;
    const settings = scopeArr[0].settings as Record<string, { notOlderThan: number; maxDuration: number }> | undefined;
    if (!settings) return results;

    for (const def of defs) {
      const s = settings[def.gqlNode];
      if (s && (s.notOlderThan > 0 || s.maxDuration > 0)) {
        results.set(def.gqlNode, { notOlderThan: s.notOlderThan, maxDuration: s.maxDuration });
      }
    }
  } catch {
    // Discovery failed – not fatal, caller uses defaults
  }

  return results;
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
