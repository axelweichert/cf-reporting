"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/store";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import UsageGauge from "@/components/charts/usage-gauge";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import { AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import type { ContractUsageMonthly, ContractUsageEntry, ContractUsageHistory } from "@/lib/contract/types";

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
  const [selectedHistory, setSelectedHistory] = useState<ContractUsageHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

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

  useEffect(() => {
    if (period) fetchData(period);
  }, [period, fetchData]);

  const handleRecalculate = async () => {
    setRecalculating(true);
    try {
      await fetch("/api/contract/usage/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      await fetchData(period);
    } finally {
      setRecalculating(false);
    }
  };

  const handleHistoryClick = async (productKey: string) => {
    if (selectedHistory?.productKey === productKey) {
      setSelectedHistory(null);
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/contract/usage?history=${productKey}`);
      if (res.ok) {
        const result = await res.json() as ContractUsageHistory;
        setSelectedHistory(result);
      }
    } finally {
      setHistoryLoading(false);
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

          {/* Category sections */}
          {Array.from(categories.entries()).map(([category, items]) => (
            <div key={category} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="mb-4 text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                {category}
              </h3>
              <div className="space-y-3">
                {items.map((entry) => (
                  <div
                    key={entry.productKey}
                    className="cursor-pointer hover:opacity-90"
                    onClick={() => handleHistoryClick(entry.productKey)}
                  >
                    <UsageGauge
                      label={entry.displayName}
                      usageValue={entry.usageValue}
                      committedAmount={entry.committedAmount}
                      unit={entry.unit}
                      usagePct={entry.usagePct}
                      warningThreshold={entry.warningThreshold}
                      dataAvailable={entry.dataAvailable}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Historical chart (shown when a line item is clicked) */}
          {historyLoading && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <CardSkeleton />
            </div>
          )}
          {selectedHistory && !historyLoading && selectedHistory.months.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="mb-4 text-sm font-semibold text-zinc-300">
                Monthly Usage History: {entries.find((e) => e.productKey === selectedHistory.productKey)?.displayName || selectedHistory.productKey}
              </h3>
              <HorizontalBarChart
                data={[...selectedHistory.months].reverse().map((m) => ({
                  name: m.period,
                  value: Math.round(m.usagePct * 10) / 10,
                }))}
                valueFormatter={(v) => `${v}%`}
                barColor="#f97316"
              />
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
