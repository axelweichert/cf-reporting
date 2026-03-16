import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAuth, validateOrigin, requireOperator } from "@/lib/auth-helpers";
import {
  exportConfigAsJson,
  getDbFilePath,
  uploadBackupToR2,
  getR2Config,
} from "@/lib/backup";
import fs from "fs";

/**
 * GET /api/backup?type=config|database
 *
 * Downloads a backup file:
 *   - config: JSON with schedules + metadata
 *   - database: raw SQLite file
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  const type = request.nextUrl.searchParams.get("type") || "config";

  if (type === "config") {
    const data = exportConfigAsJson();
    const json = JSON.stringify(data, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new NextResponse(json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cf-reporting-config-${timestamp}.json"`,
      },
    });
  }

  if (type === "database") {
    const dbPath = getDbFilePath();
    if (!dbPath) {
      return NextResponse.json({ error: "Database file not available" }, { status: 404 });
    }

    // Force WAL checkpoint before serving
    try {
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      if (db) db.pragma("wal_checkpoint(TRUNCATE)");
    } catch { /* ignore */ }

    const dbBuffer = fs.readFileSync(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new NextResponse(dbBuffer, {
      headers: {
        "Content-Type": "application/x-sqlite3",
        "Content-Disposition": `attachment; filename="cf-reporting-${timestamp}.db"`,
      },
    });
  }

  return NextResponse.json({ error: "Invalid type – use 'config' or 'database'" }, { status: 400 });
}

/**
 * POST /api/backup { action: "r2", type: "config"|"database" }
 *
 * Uploads a backup to Cloudflare R2.
 */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  const body = await request.json();
  const { action, type = "config" } = body as { action: string; type?: string };

  if (action === "r2") {
    if (!getR2Config()) {
      return NextResponse.json({
        error: "R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.",
      }, { status: 400 });
    }

    if (type !== "config" && type !== "database") {
      return NextResponse.json({ error: "Invalid type – use 'config' or 'database'" }, { status: 400 });
    }

    try {
      const result = await uploadBackupToR2(type);
      return NextResponse.json({ success: true, key: result.key });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  if (action === "status") {
    const r2 = getR2Config();
    const dbPath = getDbFilePath();
    let dbSizeMb: number | null = null;
    if (dbPath) {
      try {
        const stats = fs.statSync(dbPath);
        dbSizeMb = Math.round((stats.size / (1024 * 1024)) * 100) / 100;
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      r2Configured: !!r2,
      r2Bucket: r2?.bucketName ?? null,
      databaseAvailable: !!dbPath,
      databaseSizeMb: dbSizeMb,
    });
  }

  if (action === "wipe") {
    const dbPath = getDbFilePath();
    if (!dbPath) {
      return NextResponse.json({ error: "Database not available" }, { status: 404 });
    }

    try {
      // Close current connection, delete the file, re-initialize
      const { closeDb, getDb: reopenDb } = await import("@/lib/db");
      closeDb();
      fs.unlinkSync(dbPath);
      // Remove WAL/SHM files if present
      try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
      // Re-open triggers migration from scratch
      reopenDb();
      // Reload scheduler cron tasks (schedules are gone)
      try {
        const { reloadSchedules } = await import("@/lib/scheduler");
        reloadSchedules();
      } catch { /* ignore */ }
      return NextResponse.json({ success: true, message: "Database wiped and re-initialized" });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action – use 'r2', 'status', or 'wipe'" }, { status: 400 });
}
