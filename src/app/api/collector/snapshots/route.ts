import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-helpers";
import {
  listSnapshots,
  getLatestSnapshot,
  getSnapshotById,
  type ReportType,
} from "@/lib/snapshots";

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

  const { searchParams } = request.nextUrl;
  const zoneId = searchParams.get("zoneId") || undefined;
  const reportType = searchParams.get("reportType") || undefined;
  const id = searchParams.get("id");
  const latest = searchParams.get("latest") === "true";

  if (reportType && !VALID_REPORT_TYPES.has(reportType)) {
    return NextResponse.json({ error: "Invalid reportType" }, { status: 400 });
  }

  // Get single snapshot by ID (includes data_json)
  if (id) {
    const snapshot = getSnapshotById(parseInt(id, 10));
    if (!snapshot) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }
    return NextResponse.json({
      ...snapshot,
      data: JSON.parse(snapshot.data_json),
      data_json: undefined,
    });
  }

  // Get latest snapshot for zone + report type (includes data_json)
  if (latest && zoneId && reportType) {
    const snapshot = getLatestSnapshot(zoneId, reportType as ReportType);
    if (!snapshot) {
      return NextResponse.json({ error: "No snapshot found" }, { status: 404 });
    }
    return NextResponse.json({
      ...snapshot,
      data: JSON.parse(snapshot.data_json),
      data_json: undefined,
    });
  }

  // List snapshots (metadata only, no data_json)
  const limit = parseInt(searchParams.get("limit") || "100", 10);
  const snapshots = listSnapshots({
    zoneId,
    reportType: reportType as ReportType | undefined,
    limit: Math.min(limit, 500),
  });

  return NextResponse.json({ snapshots });
}
