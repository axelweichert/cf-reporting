import { NextRequest } from "next/server";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getDb } from "@/lib/db";
import { getContractLineItems } from "@/lib/data-store";
import { CATALOG_BY_KEY } from "@/lib/contract/catalog";
import {
  currentPeriod,
  getUsageForPeriod,
  getUsageHistory,
  getZoneBreakdown,
} from "@/lib/contract/usage-calculator";
import type { ContractUsageEntry, ContractUsageMonthly, ContractUsageHistory, ContractUsageAllHistories, ContractUsageHistoryMonth, ContractUsageZoneBreakdown } from "@/lib/contract/types";

/** GET /api/contract/usage?period=2026-03&history=cdn-data-transfer */
export async function GET(request: NextRequest) {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  if (!db) return Response.json({ error: "Database unavailable" }, { status: 503 });

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || currentPeriod();

  // Validate period format
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return Response.json({ error: "Invalid period format (expected YYYY-MM)" }, { status: 400 });
  }

  // If requesting zone breakdown for a specific line item
  const breakdownKey = searchParams.get("breakdown");
  if (breakdownKey) {
    const lineItems = getContractLineItems();
    const item = lineItems.find((li) => li.productKey === breakdownKey);
    if (!item) return Response.json({ error: "Line item not found" }, { status: 404 });

    const catalog = CATALOG_BY_KEY.get(breakdownKey);
    const zones = getZoneBreakdown(db, item.id, period);
    const result: ContractUsageZoneBreakdown = {
      lineItemId: item.id,
      productKey: breakdownKey,
      period,
      zones: zones.map((z) => ({
        zoneId: z.zone_id,
        zoneName: z.zone_name,
        usageValue: z.usage_value,
        unit: catalog?.unit ?? item.unit,
      })),
    };
    return Response.json(result);
  }

  // If requesting all histories (for chart view)
  const historiesParam = searchParams.get("histories");
  if (historiesParam === "all") {
    const lineItems = getContractLineItems().filter((li) => li.enabled);
    const now = new Date();
    const currentMonth = currentPeriod();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();

    const histories: ContractUsageHistory[] = lineItems.map((li) => {
      const rows = getUsageHistory(db, li.id, 13);
      const catalog = CATALOG_BY_KEY.get(li.productKey);

      const months: ContractUsageHistoryMonth[] = rows.map((r) => {
        const month: ContractUsageHistoryMonth = {
          period: r.period,
          usageValue: r.usage_value,
          committedAmount: r.committed_amount,
          usagePct: r.usage_pct,
        };
        // Add projected value for current partial month
        if (r.period === currentMonth && dayOfMonth < daysInMonth && dayOfMonth > 0) {
          month.projected = Math.round(
            (r.usage_value / dayOfMonth) * daysInMonth * 100,
          ) / 100;
        }
        return month;
      });

      return {
        productKey: li.productKey,
        displayName: catalog?.displayName ?? li.displayName,
        unit: catalog?.unit ?? li.unit,
        months,
      };
    });

    const result: ContractUsageAllHistories = { histories };
    return Response.json(result);
  }

  // If requesting history for a specific product
  const historyKey = searchParams.get("history");
  if (historyKey) {
    const lineItems = getContractLineItems();
    const item = lineItems.find((li) => li.productKey === historyKey);
    if (!item) return Response.json({ error: "Line item not found" }, { status: 404 });

    const rows = getUsageHistory(db, item.id, 13);
    const catalog = CATALOG_BY_KEY.get(historyKey);
    const now = new Date();
    const currentMonth = currentPeriod();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();

    const history: ContractUsageHistory = {
      productKey: historyKey,
      displayName: catalog?.displayName ?? item.displayName,
      unit: catalog?.unit ?? item.unit,
      months: rows.map((r) => {
        const month: ContractUsageHistoryMonth = {
          period: r.period,
          usageValue: r.usage_value,
          committedAmount: r.committed_amount,
          usagePct: r.usage_pct,
        };
        if (r.period === currentMonth && dayOfMonth < daysInMonth && dayOfMonth > 0) {
          month.projected = Math.round(
            (r.usage_value / dayOfMonth) * daysInMonth * 100,
          ) / 100;
        }
        return month;
      }),
    };
    return Response.json(history);
  }

  // Get all usage for the requested period
  const lineItems = getContractLineItems();
  const usageRows = getUsageForPeriod(db, period);

  // Build a map of line_item_id -> usage row
  const usageMap = new Map(usageRows.map((r) => [r.line_item_id, r]));

  const entries: ContractUsageEntry[] = lineItems
    .filter((li) => li.enabled)
    .map((li) => {
      const usage = usageMap.get(li.id);
      const catalog = CATALOG_BY_KEY.get(li.productKey);
      return {
        lineItemId: li.id,
        productKey: li.productKey,
        displayName: catalog?.displayName ?? li.displayName,
        category: catalog?.category ?? li.category,
        unit: catalog?.unit ?? li.unit,
        committedAmount: usage?.committed_amount ?? li.committedAmount,
        warningThreshold: li.warningThreshold,
        usageValue: usage?.usage_value ?? 0,
        usagePct: usage?.usage_pct ?? 0,
        dataAvailable: usage !== undefined,
        calculatedAt: usage?.calculated_at ?? "",
      };
    });

  const atWarning = entries.filter(
    (e) => e.dataAvailable && e.usagePct >= e.warningThreshold * 100 && e.usagePct < 100,
  ).length;
  const overLimit = entries.filter((e) => e.dataAvailable && e.usagePct >= 100).length;
  const healthyCount = entries.filter(
    (e) => e.dataAvailable && e.usagePct < e.warningThreshold * 100,
  ).length;
  const totalWithData = entries.filter((e) => e.dataAvailable).length;

  const result: ContractUsageMonthly = {
    period,
    entries,
    summary: {
      totalItems: entries.length,
      atWarning,
      overLimit,
      healthPct: totalWithData > 0 ? Math.round((healthyCount / totalWithData) * 100) : 100,
    },
  };

  return Response.json(result);
}
