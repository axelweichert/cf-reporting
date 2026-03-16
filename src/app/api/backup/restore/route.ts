import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAuth, validateOrigin, requireOperator } from "@/lib/auth-helpers";
import { restoreConfigFromJson } from "@/lib/backup";
import type { BackupData } from "@/lib/backup";

/**
 * POST /api/backup/restore { data: BackupData, merge?: boolean }
 *
 * Restores schedules from a previously exported JSON backup.
 *   - merge=false (default): replaces all existing schedules
 *   - merge=true: skips schedules whose ID already exists
 */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  let body: { data?: BackupData; merge?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.data || typeof body.data !== "object") {
    return NextResponse.json({ error: "Missing 'data' field with backup contents" }, { status: 400 });
  }

  const result = restoreConfigFromJson(body.data, body.merge ?? false);

  // Reload scheduler cron tasks after restore
  try {
    const { reloadSchedules } = await import("@/lib/scheduler");
    reloadSchedules();
  } catch { /* ignore */ }

  return NextResponse.json(result);
}
