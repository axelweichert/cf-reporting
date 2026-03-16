import { NextResponse } from "next/server";
import { requireAuth, requireOperator } from "@/lib/auth-helpers";
import { getCollectorStatus } from "@/lib/collector";
import {
  getRecentCollectionRuns,
  getOverallStats,
} from "@/lib/data-store";

export async function GET() {
  const auth = await requireAuth();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  const status = getCollectorStatus();
  const recentRuns = getRecentCollectionRuns(10);
  const stats = getOverallStats();

  return NextResponse.json({
    ...status,
    ...stats,
    recentRuns,
  });
}
