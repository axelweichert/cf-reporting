/**
 * CRUD operations for report snapshots and collection logs.
 * All functions return empty/null when getDb() returns null (graceful degradation).
 */

import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

export type ReportType = "executive" | "security" | "traffic" | "performance" | "dns";

export interface SnapshotRow {
  id: number;
  zone_id: string;
  zone_name: string;
  report_type: ReportType;
  period_start: string;
  period_end: string;
  data_json: string;
  collected_at: string;
}

export interface SnapshotMeta {
  id: number;
  zone_id: string;
  zone_name: string;
  report_type: ReportType;
  period_start: string;
  period_end: string;
  collected_at: string;
}

export interface CollectionLogEntry {
  id: number;
  run_id: string;
  zone_id: string;
  zone_name: string;
  report_type: string;
  status: "success" | "error" | "skipped";
  error_message: string | null;
  duration_ms: number | null;
  started_at: string;
}

// --- Snapshots ---

export function upsertSnapshot(
  zoneId: string,
  zoneName: string,
  reportType: ReportType,
  periodStart: string,
  periodEnd: string,
  data: unknown,
): boolean {
  const db = getDb();
  if (!db) return false;

  const stmt = db.prepare(`
    INSERT INTO report_snapshots (zone_id, zone_name, report_type, period_start, period_end, data_json, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(zone_id, report_type, period_start, period_end)
    DO UPDATE SET
      zone_name = excluded.zone_name,
      data_json = excluded.data_json,
      collected_at = datetime('now')
  `);

  stmt.run(zoneId, zoneName, reportType, periodStart, periodEnd, JSON.stringify(data));
  return true;
}

export function getLatestSnapshot(
  zoneId: string,
  reportType: ReportType,
): SnapshotRow | null {
  const db = getDb();
  if (!db) return null;

  return db.prepare(`
    SELECT * FROM report_snapshots
    WHERE zone_id = ? AND report_type = ?
    ORDER BY collected_at DESC
    LIMIT 1
  `).get(zoneId, reportType) as SnapshotRow | undefined ?? null;
}

export function listSnapshots(opts?: {
  zoneId?: string;
  reportType?: ReportType;
  limit?: number;
}): SnapshotMeta[] {
  const db = getDb();
  if (!db) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.zoneId) {
    conditions.push("zone_id = ?");
    params.push(opts.zoneId);
  }
  if (opts?.reportType) {
    conditions.push("report_type = ?");
    params.push(opts.reportType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;

  return db.prepare(`
    SELECT id, zone_id, zone_name, report_type, period_start, period_end, collected_at
    FROM report_snapshots
    ${where}
    ORDER BY collected_at DESC
    LIMIT ?
  `).all(...params, limit) as SnapshotMeta[];
}

export function getSnapshotById(id: number): SnapshotRow | null {
  const db = getDb();
  if (!db) return null;

  return db.prepare("SELECT * FROM report_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined ?? null;
}

// --- Collection Log ---

export function generateRunId(): string {
  return randomUUID();
}

export function logCollection(
  runId: string,
  zoneId: string,
  zoneName: string,
  reportType: string,
  status: "success" | "error" | "skipped",
  durationMs?: number,
  errorMessage?: string,
): void {
  const db = getDb();
  if (!db) return;

  db.prepare(`
    INSERT INTO collection_log (run_id, zone_id, zone_name, report_type, status, error_message, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, zoneId, zoneName, reportType, status, errorMessage ?? null, durationMs ?? null);
}

export interface CollectionRunSummary {
  run_id: string;
  started_at: string;
  total: number;
  success: number;
  errors: number;
  skipped: number;
  total_duration_ms: number;
}

export function getRecentCollectionRuns(limit = 10): CollectionRunSummary[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT
      run_id,
      MIN(started_at) as started_at,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(COALESCE(duration_ms, 0)) as total_duration_ms
    FROM collection_log
    GROUP BY run_id
    ORDER BY MIN(started_at) DESC
    LIMIT ?
  `).all(limit) as CollectionRunSummary[];
}

// --- Cleanup ---

export function cleanupOldData(retentionDays: number): { deletedSnapshots: number; deletedLogs: number } {
  const db = getDb();
  if (!db) return { deletedSnapshots: 0, deletedLogs: 0 };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString();

  const snapResult = db.prepare("DELETE FROM report_snapshots WHERE collected_at < ?").run(cutoffStr);
  const logResult = db.prepare("DELETE FROM collection_log WHERE started_at < ?").run(cutoffStr);

  return {
    deletedSnapshots: snapResult.changes,
    deletedLogs: logResult.changes,
  };
}

export function getSnapshotCount(): number {
  const db = getDb();
  if (!db) return 0;

  const row = db.prepare("SELECT COUNT(*) as count FROM report_snapshots").get() as { count: number };
  return row.count;
}
