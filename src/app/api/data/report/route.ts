import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-helpers";
import { readReportData } from "@/lib/data-store-readers";

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
  const reportType = searchParams.get("reportType");
  const scopeId = searchParams.get("scopeId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!reportType || !VALID_REPORT_TYPES.has(reportType)) {
    return NextResponse.json({ error: "Invalid or missing reportType" }, { status: 400 });
  }

  if (!scopeId) {
    return NextResponse.json({ error: "Missing scopeId" }, { status: 400 });
  }

  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : 0;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000);

  const data = readReportData(reportType, scopeId, fromTs, toTs);

  if (data === null) {
    return NextResponse.json({ error: "No historic data available" }, { status: 404 });
  }

  return NextResponse.json(data);
}
