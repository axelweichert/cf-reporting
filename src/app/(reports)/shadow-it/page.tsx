"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchShadowItData, computeRiskLevel, type ShadowItData, type AppTag, type RiskLevel } from "@/lib/queries/shadow-it";
import { pctChange, formatTimeSeries } from "@/lib/compare-utils";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, SERIES_COLORS } from "@/components/charts/theme";
import { Info, Shield, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

// --- App tag persistence (localStorage) ---
const STORAGE_KEY = "cf-reporting-app-tags";

function loadAppTags(): Record<string, AppTag> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch { return {}; }
}

function saveAppTags(tags: Record<string, AppTag>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
}

const RISK_STYLES: Record<RiskLevel, { bg: string; text: string; label: string }> = {
  critical: { bg: "bg-red-500/10 border-red-500/20", text: "text-red-400", label: "Critical" },
  high: { bg: "bg-orange-500/10 border-orange-500/20", text: "text-orange-400", label: "High" },
  medium: { bg: "bg-yellow-500/10 border-yellow-500/20", text: "text-yellow-400", label: "Medium" },
  low: { bg: "bg-emerald-500/10 border-emerald-500/20", text: "text-emerald-400", label: "Low" },
};

const TAG_STYLES: Record<AppTag, { bg: string; text: string; label: string }> = {
  sanctioned: { bg: "bg-emerald-500/10 border-emerald-500/20", text: "text-emerald-400", label: "Sanctioned" },
  unsanctioned: { bg: "bg-red-500/10 border-red-500/20", text: "text-red-400", label: "Unsanctioned" },
  unclassified: { bg: "bg-zinc-500/10 border-zinc-500/20", text: "text-zinc-400", label: "Unclassified" },
};

const TAG_CYCLE: AppTag[] = ["unclassified", "sanctioned", "unsanctioned"];

export default function ShadowItPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd, compareEnabled } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const [appTags, setAppTags] = useState<Record<string, AppTag>>({});

  // Load tags from localStorage on mount
  useEffect(() => { setAppTags(loadAppTags()); }, []);

  const cycleTag = useCallback((appName: string) => {
    setAppTags((prev) => {
      const current = prev[appName] || "unclassified";
      const nextIdx = (TAG_CYCLE.indexOf(current) + 1) % TAG_CYCLE.length;
      const next = { ...prev, [appName]: TAG_CYCLE[nextIdx] };
      saveAppTags(next);
      return next;
    });
  }, []);

  const { data, loading, error, errorType, refetch, prevData, cmpLoading } = useReportData<ShadowItData>({
    reportType: "shadow-it",
    scopeId: accountId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    fetcher: (s, u) => {
      if (!accountId) throw new Error("No account available");
      return fetchShadowItData(accountId, s, u);
    },
  });

  if (!accountId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select an account from the filter bar to view this report.</p>
      </div>
    );
  }

  const trendFormatted = formatTimeSeries(data?.usageTrends || []);

  const apps = data?.discoveredApplications || [];
  const totalDiscovered = apps.length;
  const totalRequests = apps.reduce((s, a) => s + a.count, 0);
  const maxCount = apps.length > 0 ? apps[0].count : 0;

  const prevApps = prevData?.discoveredApplications || [];
  const prevTotalDiscovered = prevApps.length;

  // Compute risk stats
  const unsanctionedCount = apps.filter((a) => appTags[a.name] === "unsanctioned").length;
  const sanctionedCount = apps.filter((a) => appTags[a.name] === "sanctioned").length;
  const riskCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const app of apps) {
    const tag = appTags[app.name] || "unclassified";
    const risk = computeRiskLevel(app.category, tag, app.count, maxCount);
    riskCounts[risk]++;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Shadow IT / SaaS Discovery</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></> : (
          <>
            <StatCard label="Discovered Apps" value={totalDiscovered} change={compareEnabled ? pctChange(totalDiscovered, prevTotalDiscovered || undefined) : undefined} compareLoading={cmpLoading} />
            <StatCard label="App Requests" value={formatNumber(totalRequests)} />
            <StatCard
              label="Sanctioned"
              value={sanctionedCount}
              icon={<ShieldCheck size={16} className="text-emerald-400" />}
            />
            <StatCard
              label="Unsanctioned"
              value={unsanctionedCount}
              icon={<ShieldAlert size={16} className="text-red-400" />}
            />
          </>
        )}
      </div>

      {/* Risk summary bar */}
      {!loading && totalDiscovered > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-3">
          <Shield size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Risk Summary:</span>
          {(["critical", "high", "medium", "low"] as RiskLevel[]).map((level) => (
            <span key={level} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${RISK_STYLES[level].bg} ${RISK_STYLES[level].text}`}>
              {RISK_STYLES[level].label}: {riskCounts[level]}
            </span>
          ))}
        </div>
      )}

      {data?.onlyBlockedLogged && (
        <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <Info size={16} className="mt-0.5 shrink-0 text-blue-400" />
          <p className="text-xs text-blue-300">
            Only blocked queries appear in the analytics. SaaS discovery results may be incomplete because your Gateway activity logging may be set to &quot;Capture only blocked&quot;.
            To discover all SaaS applications, change the setting under{" "}
            <span className="font-medium">Traffic policies &gt; Traffic settings &gt; Traffic logging &gt; Log traffic activity</span> to &quot;Capture all&quot;.
          </p>
        </div>
      )}

      {/* Usage Trends */}
      {(data?.trendAppNames || []).length > 0 && (
        <ChartWrapper title="Top App Usage Trends" loading={loading}>
          <TimeSeriesChart
            data={trendFormatted}
            xKey="date"
            series={(data?.trendAppNames || []).map((name, i) => ({
              key: name,
              label: name,
              color: SERIES_COLORS[i % SERIES_COLORS.length],
            }))}
            yFormatter={formatNumber}
          />
        </ChartWrapper>
      )}

      {/* Discovered Applications with tag + risk columns */}
      <ChartWrapper title="Discovered Applications" subtitle="Click tag to cycle: Unclassified → Sanctioned → Unsanctioned" loading={loading}>
        <DataTable
          columns={[
            { key: "name", label: "Application" },
            { key: "category", label: "Category" },
            {
              key: "tag",
              label: "Status",
              align: "center",
              render: (_v, row: any) => {
                const tag = appTags[row.name] || "unclassified";
                const style = TAG_STYLES[tag];
                return (
                  <button
                    onClick={() => cycleTag(row.name)}
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium transition-colors hover:opacity-80 ${style.bg} ${style.text}`}
                  >
                    {style.label}
                  </button>
                );
              },
            },
            {
              key: "risk",
              label: "Risk",
              align: "center",
              render: (_v, row: any) => {
                const tag = appTags[row.name] || "unclassified";
                const risk = computeRiskLevel(row.category, tag, row.count, maxCount);
                const style = RISK_STYLES[risk];
                return (
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                );
              },
            },
            { key: "count", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
          ]}
          data={apps}
          maxRows={20}
        />
      </ChartWrapper>

      {/* User-App Mapping */}
      {!loading && (data?.userAppMappings || []).length > 0 && (
        <ChartWrapper
          title="User-Application Mapping"
          subtitle="Users and the SaaS applications they access (via HTTP inspection)"
          loading={false}
        >
          <DataTable
            columns={[
              { key: "email", label: "User" },
              {
                key: "apps",
                label: "Applications",
                render: (v) => {
                  const apps = v as string[];
                  if (apps.length === 0) return <span className="text-zinc-500">No identified apps</span>;
                  return (
                    <div className="flex flex-wrap gap-1">
                      {apps.slice(0, 5).map((app) => {
                        const tag = appTags[app] || "unclassified";
                        const color = tag === "sanctioned" ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
                          : tag === "unsanctioned" ? "text-red-400 border-red-500/20 bg-red-500/10"
                          : "text-zinc-300 border-zinc-700 bg-zinc-800";
                        return (
                          <span key={app} className={`inline-flex rounded border px-1.5 py-0.5 text-xs ${color}`}>
                            {app}
                          </span>
                        );
                      })}
                      {apps.length > 5 && (
                        <span className="text-xs text-zinc-500">+{apps.length - 5} more</span>
                      )}
                    </div>
                  );
                },
              },
              {
                key: "totalRequests",
                label: "Total Requests",
                align: "right",
                render: (v) => formatNumber(v as number),
              },
            ]}
            data={data?.userAppMappings || []}
            maxRows={15}
          />
        </ChartWrapper>
      )}

      {!loading && (data?.userAppMappings || []).length === 0 && data && (
        <div className="flex items-start gap-2 rounded-md border border-zinc-700 bg-zinc-900/50 px-3 py-2">
          <Users size={16} className="mt-0.5 shrink-0 text-zinc-400" />
          <p className="text-xs text-zinc-400">
            No user-level data available. User-app mapping requires WARP client enrollment with identity enabled.
          </p>
        </div>
      )}

      {/* Unidentified traffic categories */}
      <ChartWrapper
        title="Unidentified Traffic by Category"
        subtitle="DNS requests not matched to a known SaaS application"
        loading={loading}
      >
        <DonutChart
          data={(data?.categoryBreakdown || []).map((c) => ({
            name: c.category || "Unknown",
            value: c.count,
          }))}
          valueFormatter={formatNumber}
        />
      </ChartWrapper>
    </div>
  );
}
