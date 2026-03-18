import { NextRequest } from "next/server";
import { validateOrigin, getAuthenticatedSession, requireOperator } from "@/lib/auth-helpers";
import { getDb } from "@/lib/db";
import {
  calculateAllForPeriod,
  currentPeriod,
  detectNewCrossings,
} from "@/lib/contract/usage-calculator";

/** POST /api/contract/usage/recalculate – trigger usage recalculation (operator only) */
export async function POST(request: NextRequest) {
  const originErr = validateOrigin(request);
  if (originErr) return originErr;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const opErr = await requireOperator();
  if (opErr) return opErr;

  const db = getDb();
  if (!db) return Response.json({ error: "Database unavailable" }, { status: 503 });

  const body = await request.json().catch(() => ({})) as { period?: string };
  const period = body.period || currentPeriod();

  if (!/^\d{4}-\d{2}$/.test(period)) {
    return Response.json({ error: "Invalid period format (expected YYYY-MM)" }, { status: 400 });
  }

  const results = calculateAllForPeriod(db, period);
  const crossings = detectNewCrossings(db, results);

  return Response.json({
    period,
    calculated: results.length,
    crossings: crossings.length,
    items: results.map((r) => ({
      productKey: r.productKey,
      usageValue: r.usageValue,
      usagePct: r.usagePct,
      dataAvailable: r.dataAvailable,
    })),
  });
}
