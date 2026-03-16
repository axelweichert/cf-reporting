import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireOperator } from "@/lib/auth-helpers";
import {
  getDataAvailability,
  getAggregateStats,
  getTimeSeriesData,
  getCollectionHistory,
  getCollectionLogs,
} from "@/lib/data-store";

const VALID_REPORT_TYPES = new Set([
  "executive", "security", "traffic", "performance", "dns",
  "origin-health", "ssl", "bots", "api-shield", "ddos",
  "gateway-dns", "gateway-network", "shadow-it", "devices-users", "zt-summary", "access-audit",
]);

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  const { searchParams } = request.nextUrl;
  const scopeId = searchParams.get("scopeId");
  const reportType = searchParams.get("reportType");
  const runId = searchParams.get("runId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (reportType && !VALID_REPORT_TYPES.has(reportType)) {
    return NextResponse.json({ error: "Invalid reportType" }, { status: 400 });
  }

  // Get collection log for a specific run
  if (runId) {
    const logs = getCollectionLogs(runId);
    return NextResponse.json({ logs });
  }

  // Get detailed data for a specific scope + report type
  if (scopeId && reportType) {
    const fromTs = from ? parseInt(from, 10) : undefined;
    const toTs = to ? parseInt(to, 10) : undefined;

    const aggregateStats = getAggregateStats(scopeId, reportType, fromTs, toTs);
    const timeSeries = getTimeSeriesData(scopeId, reportType, fromTs, toTs);
    const collectionHistory = getCollectionHistory(scopeId, reportType, 20);

    return NextResponse.json({
      scopeId,
      reportType,
      aggregateStats,
      timeSeries,
      collectionHistory,
    });
  }

  // Default: return data availability overview
  const availability = getDataAvailability();
  return NextResponse.json({ availability });
}
