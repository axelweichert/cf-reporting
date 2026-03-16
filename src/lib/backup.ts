/**
 * Config backup and restore utilities.
 *
 * Supports:
 *   - JSON export/import of schedules + metadata
 *   - Raw SQLite database file download
 *   - Optional upload to Cloudflare R2 (S3-compatible)
 */

import fs from "fs";
import path from "path";
import { getDb } from "@/lib/db";
import { getSchedulesFromDb, saveScheduleToDb, deleteScheduleFromDb } from "@/lib/data-store";
import type { ScheduleConfig } from "@/types/email";
import { VALID_REPORT_TYPES } from "@/types/email";

// =============================================================================
// Types
// =============================================================================

export interface BackupData {
  version: 1;
  exportedAt: string;
  schedules: ScheduleConfig[];
  metadata: {
    schemaVersion: number;
    dbPath: string;
    nodeEnv: string | undefined;
  };
}

export interface RestoreResult {
  schedulesRestored: number;
  schedulesSkipped: number;
  errors: string[];
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

// =============================================================================
// Export
// =============================================================================

export function exportConfigAsJson(): BackupData {
  const db = getDb();
  const schedules = getSchedulesFromDb();

  let schemaVersion = 0;
  if (db) {
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
    schemaVersion = row?.version ?? 0;
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    schedules,
    metadata: {
      schemaVersion,
      dbPath: process.env.DB_PATH || "/app/data/cf-reporting.db",
      nodeEnv: process.env.NODE_ENV,
    },
  };
}

/**
 * Returns the path to the SQLite database file, or null if unavailable.
 */
export function getDbFilePath(): string | null {
  const dbPath = process.env.DB_PATH || "/app/data/cf-reporting.db";
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
    return dbPath;
  } catch {
    return null;
  }
}

// =============================================================================
// Restore
// =============================================================================

export function restoreConfigFromJson(data: BackupData, merge: boolean = false): RestoreResult {
  const result: RestoreResult = { schedulesRestored: 0, schedulesSkipped: 0, errors: [] };

  if (data.version !== 1) {
    result.errors.push(`Unsupported backup version: ${data.version}`);
    return result;
  }

  if (!Array.isArray(data.schedules)) {
    result.errors.push("Invalid backup: missing schedules array");
    return result;
  }

  const db = getDb();
  if (!db) {
    result.errors.push("Database not available – cannot restore");
    return result;
  }

  // If not merging, delete all existing schedules first
  if (!merge) {
    const existing = getSchedulesFromDb();
    for (const s of existing) {
      deleteScheduleFromDb(s.id);
    }
  }

  const existingIds = new Set(merge ? getSchedulesFromDb().map((s) => s.id) : []);

  for (const schedule of data.schedules) {
    try {
      if (merge && existingIds.has(schedule.id)) {
        result.schedulesSkipped++;
        continue;
      }
      validateSchedule(schedule);
      saveScheduleToDb(schedule);
      result.schedulesRestored++;
    } catch (err) {
      result.errors.push(`Schedule ${schedule.id}: ${(err as Error).message}`);
    }
  }

  return result;
}

function validateSchedule(s: ScheduleConfig): void {
  if (!s.id || typeof s.id !== "string") throw new Error("missing or invalid id");
  if (!s.reportType || typeof s.reportType !== "string") throw new Error("missing reportType");
  if (!VALID_REPORT_TYPES.has(s.reportType)) throw new Error(`invalid reportType: ${s.reportType}`);
  if (s.reportTypes) {
    if (!Array.isArray(s.reportTypes)) throw new Error("reportTypes must be an array");
    for (const rt of s.reportTypes) {
      if (!VALID_REPORT_TYPES.has(rt)) throw new Error(`invalid reportType in reportTypes: ${rt}`);
    }
  }
  if (!s.cronExpression || typeof s.cronExpression !== "string") throw new Error("missing cronExpression");
  if (!Array.isArray(s.recipients) || s.recipients.length === 0) throw new Error("missing recipients");
  if (!s.zoneId || typeof s.zoneId !== "string") throw new Error("missing zoneId");
}

// =============================================================================
// R2 upload
// =============================================================================

export function getR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) return null;

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

export async function uploadToR2(
  r2: R2Config,
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });

  await client.send(new PutObjectCommand({
    Bucket: r2.bucketName,
    Key: key,
    Body: typeof body === "string" ? Buffer.from(body) : body,
    ContentType: contentType,
  }));
}

export async function uploadBackupToR2(
  type: "config" | "database",
): Promise<{ key: string }> {
  const r2 = getR2Config();
  if (!r2) throw new Error("R2 not configured – set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (type === "config") {
    const data = exportConfigAsJson();
    const key = `cf-reporting/backups/config-${timestamp}.json`;
    await uploadToR2(r2, key, JSON.stringify(data, null, 2), "application/json");
    return { key };
  } else {
    const dbPath = getDbFilePath();
    if (!dbPath) throw new Error("Database file not available");

    // Force WAL checkpoint to ensure all data is in the main file
    const db = getDb();
    if (db) {
      db.pragma("wal_checkpoint(TRUNCATE)");
    }

    const dbBuffer = fs.readFileSync(dbPath);
    const key = `cf-reporting/backups/database-${timestamp}.db`;
    await uploadToR2(r2, key, dbBuffer, "application/x-sqlite3");
    return { key };
  }
}
