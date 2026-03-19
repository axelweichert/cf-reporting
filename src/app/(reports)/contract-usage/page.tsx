"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/store";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import UsageGauge from "@/components/charts/usage-gauge";
import MonthlyUsageChart from "@/components/charts/monthly-usage-chart";
import { AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import DataTable from "@/components/charts/data-table";
import type {
  ContractUsageMonthly,
  ContractUsageEntry,
  ContractUsageHistory,
  ContractUsageAllHistories,
  ContractUsageZoneBreakdown,
} from "@/lib/contract/types";

function buildPeriodOptions(): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
    options.push({ label, value: period });
  }
  return options;
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

  const [period, setPeriod] = useState(() => buildPeriodOptions()[0]?.value || "");
  const [data, setData] = useState<ContractUsageMonthly | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  // All histories for chart rendering
  const [histories, setHistories] = useState<Map<string, ContractUsageHistory>>(new Map());
  const [historiesLoading, setHistoriesLoading] = useState(false);

  // Zone drill-down
  const [drillDownKey, setDrillDownKey] = useState<string | null>(null);
  const [zoneBreakdown, setZoneBreakdown] = useState<ContractUsageZoneBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

  const periodOptions = buildPeriodOptions();

  const fetchData = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/contract/usage?period=${p}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const result = await res.json() as ContractUsageMonthly;
      setData(result);
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
        for (const h of result.histories) {
          map.set(h.productKey, h);
        }
        setHistories(map);
      }
    } catch {
      // Non-critical – gauges still work without charts
    } finally {
      setHistoriesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period) {
      fetchData(period);
      fetchHistories();
    }
  }, [period, fetchData, fetchHistories]);

  const handleDrillDown = async (productKey: string) => {
    if (drillDownKey === productKey) {
      setDrillDownKey(null);
      setZoneBreakdown(null);
      return;
    }
    setDrillDownKey(productKey);
    setBreakdownLoading(true);
    try {
      const res = await fetch(`/api/contract/usage?breakdown=${productKey}&period=${period}`);
      if (res.ok) {
        const result = await res.json() as ContractUsageZoneBreakdown;
        setZoneBreakdown(result);
      }
    } catch {
      setZoneBreakdown(null);
    } finally {
      setBreakdownLoading(false);
    }
  };

  const handleRecalculate = async () => {
    setRecalculating(true);
    try {
      await fetch("/api/contract/usage/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      await Promise.all([fetchData(period), fetchHistories()]);
    } finally {
      setRecalculating(false);
    }
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
    return (
      <div className="mx-auto max-w-7xl p-6">
        <ErrorMessage message={error} />
      </div>
    );
  }

  const entries = data?.entries || [];
  const summary = data?.summary || { totalItems: 0, atWarning: 0, overLimit: 0, healthPct: 100 };
  const categories = groupByCategory(entries);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      {/* Disclaimer */}
      <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 px-4 py-2.5 text-xs text-zinc-400">
        Usage estimates based on analytics data. Refer to your Cloudflare invoice for billing-accurate figures.
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:border-orange-500 focus:outline-none"
        >
          {periodOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {isOperator && (
          <button
            onClick={handleRecalculate}
            disabled={recalculating}
            className="flex items-center gap-1.5 rounded-md bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
          >
            <RefreshCw size={14} className={recalculating ? "animate-spin" : ""} />
            {recalculating ? "Calculating..." : "Recalculate"}
          </button>
        )}
      </div>

      {/* Summary cards */}
      {entries.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <StatCard
              label="Items Tracked"
              value={String(summary.totalItems)}
              icon={<CheckCircle size={18} />}
            />
            <StatCard
              label="At Warning"
              value={String(summary.atWarning)}
              icon={<AlertTriangle size={18} />}
            />
            <StatCard
              label="Over Limit"
              value={String(summary.overLimit)}
              icon={<XCircle size={18} />}
            />
            <StatCard
              label="Health"
              value={`${summary.healthPct}%`}
              icon={<CheckCircle size={18} />}
            />
          </div>

          {/* Category sections with gauges */}
          {Array.from(categories.entries()).map(([category, items]) => (
            <div key={category} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="mb-4 text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                {category}
              </h3>
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

          {/* Monthly usage charts – one per line item */}
          {!historiesLoading && histories.size > 0 && (
            <div className="space-y-6">
              {entries.filter((e) => e.dataAvailable && histories.has(e.productKey)).map((entry) => {
                const history = histories.get(entry.productKey)!;
                if (history.months.length === 0) return null;
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
                    <MonthlyUsageChart
                      months={history.months}
                      unit={history.unit}
                    />
                    {/* Zone drill-down */}
                    {isExpanded && breakdownLoading && (
                      <div className="mt-4 text-sm text-zinc-500">Loading zone breakdown...</div>
                    )}
                    {isExpanded && !breakdownLoading && zoneBreakdown && zoneBreakdown.zones.length > 0 && (
                      <div className="mt-4 border-t border-zinc-800 pt-4">
                        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                          Per-Zone Breakdown ({period})
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
                                    <td className="px-2 py-1.5 text-right font-mono text-zinc-200">
                                      {z.usageValue.toFixed(2)} {z.unit}
                                    </td>
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
                <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                  <CardSkeleton />
                </div>
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
