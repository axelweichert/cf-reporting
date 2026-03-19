"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { useAuth } from "@/lib/store";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import UsageGauge from "@/components/charts/usage-gauge";
import MonthlyUsageChart from "@/components/charts/monthly-usage-chart";
import { AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import type {
  ContractUsageMonthly,
  ContractUsageEntry,
  ContractUsageHistory,
  ContractUsageAllHistories,
  ContractUsageZoneBreakdown,
  ContractUsageHistoryMonth,
} from "@/lib/contract/types";

// =============================================================================
// View mode: single month, current year, or last 12 months
// =============================================================================

type ViewMode = { type: "month"; period: string } | { type: "year" } | { type: "12m" };

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function buildMonthOptions(): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
    options.push({ label, value });
  }
  return options;
}

/** Filter history months to match the current view mode. */
function filterMonths(months: ContractUsageHistoryMonth[], view: ViewMode): ContractUsageHistoryMonth[] {
  if (view.type === "month") {
    return months.filter((m) => m.period === view.period);
  }
  if (view.type === "year") {
    const year = String(new Date().getUTCFullYear());
    return months.filter((m) => m.period.startsWith(year));
  }
  // 12m: keep all (API already returns up to 13 months)
  return months;
}

function groupByCategory(entries: ContractUsageEntry[]): Map<string, ContractUsageEntry[]> {
  const grouped = new Map<string, ContractUsageEntry[]>();
  for (const entry of entries) {
    const items = grouped.get(entry.category) || [];
    items.push(entry);
    grouped.set(entry.category, items);
  }
  return grouped;
}

export default function ContractUsagePage() {
  const { role } = useAuth();
  const isOperator = role !== "viewer";

  const [view, setView] = useState<ViewMode>({ type: "month", period: currentPeriod() });
  const [data, setData] = useState<ContractUsageMonthly | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  const [histories, setHistories] = useState<Map<string, ContractUsageHistory>>(new Map());
  const [historiesLoading, setHistoriesLoading] = useState(false);

  const [drillDownKey, setDrillDownKey] = useState<string | null>(null);
  const [zoneBreakdown, setZoneBreakdown] = useState<ContractUsageZoneBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

  const monthOptions = useMemo(() => buildMonthOptions(), []);

  // The period for gauge/summary data (always a single month)
  const gaugePeriod = view.type === "month" ? view.period : currentPeriod();

  const fetchData = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/contract/usage?period=${p}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json() as ContractUsageMonthly);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistories = useCallback(async () => {
    setHistoriesLoading(true);
    try {
      const res = await fetch("/api/contract/usage?histories=all");
      if (res.ok) {
        const result = await res.json() as ContractUsageAllHistories;
        const map = new Map<string, ContractUsageHistory>();
        for (const h of result.histories) map.set(h.productKey, h);
        setHistories(map);
      }
    } catch { /* non-critical */ }
    finally { setHistoriesLoading(false); }
  }, []);

  useEffect(() => {
    fetchData(gaugePeriod);
    fetchHistories();
  }, [gaugePeriod, fetchData, fetchHistories]);

  const handleDrillDown = async (productKey: string) => {
    if (drillDownKey === productKey) { setDrillDownKey(null); setZoneBreakdown(null); return; }
    setDrillDownKey(productKey);
    setBreakdownLoading(true);
    try {
      const res = await fetch(`/api/contract/usage?breakdown=${productKey}&period=${gaugePeriod}`);
      if (res.ok) setZoneBreakdown(await res.json() as ContractUsageZoneBreakdown);
    } catch { setZoneBreakdown(null); }
    finally { setBreakdownLoading(false); }
  };

  const handleRecalculate = async (backfill = false) => {
    setRecalculating(true);
    try {
      await fetch("/api/contract/usage/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backfill ? { backfill: true } : { period: gaugePeriod }),
      });
      await Promise.all([fetchData(gaugePeriod), fetchHistories()]);
    } finally { setRecalculating(false); }
  };

  // Derive the select value for the combined dropdown
  const selectValue = view.type === "month" ? view.period : view.type;
  const handleViewChange = (val: string) => {
    if (val === "year") setView({ type: "year" });
    else if (val === "12m") setView({ type: "12m" });
    else setView({ type: "month", period: val });
  };

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <CardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return <div className="mx-auto max-w-7xl p-6"><ErrorMessage message={error} /></div>;
  }

  const entries = data?.entries || [];
  const summary = data?.summary || { totalItems: 0, atWarning: 0, overLimit: 0, healthPct: 100 };
  const categories = groupByCategory(entries);
  const showCharts = view.type !== "month" || (view.type === "month" && histories.size > 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      {/* Disclaimer */}
      <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 px-4 py-2.5 text-xs text-zinc-400">
        Usage estimates based on analytics data. Refer to your Cloudflare invoice for billing-accurate figures.
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={selectValue}
          onChange={(e) => handleViewChange(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:border-orange-500 focus:outline-none"
        >
          <optgroup label="Range">
            <option value="12m">Last 12 Months</option>
            <option value="year">{new Date().getUTCFullYear()} (Year to Date)</option>
          </optgroup>
          <optgroup label="Single Month">
            {monthOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </optgroup>
        </select>
        {isOperator && (
          <>
            <button
              onClick={() => handleRecalculate(false)}
              disabled={recalculating}
              className="flex items-center gap-1.5 rounded-md bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
            >
              <RefreshCw size={14} className={recalculating ? "animate-spin" : ""} />
              {recalculating ? "Calculating..." : "Recalculate"}
            </button>
            {histories.size === 0 || Array.from(histories.values()).some((h) => h.months.length < 2) ? (
              <button
                onClick={() => handleRecalculate(true)}
                disabled={recalculating}
                className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
              >
                {recalculating ? "Backfilling..." : "Backfill History"}
              </button>
            ) : null}
          </>
        )}
      </div>

      {entries.length > 0 ? (
        <>
          {/* Summary cards (always for the gauge period) */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <StatCard label="Items Tracked" value={String(summary.totalItems)} icon={<CheckCircle size={18} />} />
            <StatCard label="At Warning" value={String(summary.atWarning)} icon={<AlertTriangle size={18} />} />
            <StatCard label="Over Limit" value={String(summary.overLimit)} icon={<XCircle size={18} />} />
            <StatCard label="Health" value={`${summary.healthPct}%`} icon={<CheckCircle size={18} />} />
          </div>

          {/* Category sections with gauges */}
          {Array.from(categories.entries()).map(([category, items]) => (
            <div key={category} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="mb-4 text-sm font-semibold text-zinc-300 uppercase tracking-wider">{category}</h3>
              <div className="space-y-3">
                {items.map((entry) => (
                  <UsageGauge
                    key={entry.productKey}
                    label={entry.displayName}
                    usageValue={entry.usageValue}
                    committedAmount={entry.committedAmount}
                    unit={entry.unit}
                    usagePct={entry.usagePct}
                    warningThreshold={entry.warningThreshold}
                    dataAvailable={entry.dataAvailable}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Monthly usage charts */}
          {!historiesLoading && showCharts && (
            <div className="space-y-6">
              {entries.filter((e) => e.dataAvailable && histories.has(e.productKey)).map((entry) => {
                const history = histories.get(entry.productKey)!;
                const filteredMonths = filterMonths(history.months, view);
                if (filteredMonths.length === 0) return null;
                const isExpanded = drillDownKey === entry.productKey;
                return (
                  <div key={entry.productKey} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-zinc-300">
                        {history.displayName}
                        <span className="ml-2 text-xs font-normal text-zinc-500">({history.unit})</span>
                      </h3>
                      <button
                        onClick={() => handleDrillDown(entry.productKey)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded border border-zinc-700 hover:border-zinc-600"
                      >
                        {isExpanded ? "Hide zones" : "Show zones"}
                      </button>
                    </div>
                    <MonthlyUsageChart months={filteredMonths} unit={history.unit} />
                    {/* Zone drill-down */}
                    {isExpanded && breakdownLoading && (
                      <div className="mt-4 text-sm text-zinc-500">Loading zone breakdown...</div>
                    )}
                    {isExpanded && !breakdownLoading && zoneBreakdown && zoneBreakdown.zones.length > 0 && (
                      <div className="mt-4 border-t border-zinc-800 pt-4">
                        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                          Per-Zone Breakdown ({gaugePeriod})
                        </h4>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                                <th className="px-2 py-1.5 text-left">Zone</th>
                                <th className="px-2 py-1.5 text-right">Usage</th>
                                <th className="px-2 py-1.5 text-right">Share</th>
                              </tr>
                            </thead>
                            <tbody>
                              {zoneBreakdown.zones.map((z) => {
                                const total = zoneBreakdown.zones.reduce((sum, zz) => sum + zz.usageValue, 0);
                                const pct = total > 0 ? (z.usageValue / total * 100).toFixed(1) : "0.0";
                                return (
                                  <tr key={z.zoneId} className="border-b border-zinc-800/30">
                                    <td className="px-2 py-1.5 text-zinc-300">{z.zoneName}</td>
                                    <td className="px-2 py-1.5 text-right font-mono text-zinc-200">{z.usageValue.toFixed(2)} {z.unit}</td>
                                    <td className="px-2 py-1.5 text-right text-zinc-500">{pct}%</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {isExpanded && !breakdownLoading && zoneBreakdown && zoneBreakdown.zones.length === 0 && (
                      <div className="mt-4 text-xs text-zinc-500 italic">
                        No per-zone breakdown available (account-scoped metric or no data).
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {historiesLoading && (
            <div className="space-y-6">
              {[1, 2].map((i) => (
                <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"><CardSkeleton /></div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-zinc-400">No contract line items configured.</p>
          {isOperator && (
            <p className="mt-2 text-sm text-zinc-500">
              Go to Settings &rarr; Contract to add your Cloudflare contract entitlements.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
