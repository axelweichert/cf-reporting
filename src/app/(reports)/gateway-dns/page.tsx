"use client";

import { useState } from "react";
import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchGatewayDnsData, type GatewayDnsData } from "@/lib/queries/gateway-dns";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { Info } from "lucide-react";
import { format } from "date-fns";

const BLOCKED_DECISIONS = new Set(["Blocked by Policy", "Blocked (Already Resolved)"]);

export default function GatewayDnsPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const [showAllBlocked, setShowAllBlocked] = useState(false);

  const { data, loading, error, errorType, refetch } = useCfData<GatewayDnsData>({
    fetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchGatewayDnsData(accountId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
    deps: [accountId, start, end],
  });

  if (!accountId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select an account from the filter bar to view this report.</p>
      </div>
    );
  }

  const queryVolumeFormatted = (data?.queryVolume || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const totalQueries = (data?.queryVolume || []).reduce((sum, p) => sum + p.count, 0);
  const totalBlocked = (data?.resolverDecisions || [])
    .filter((d) => BLOCKED_DECISIONS.has(d.decision))
    .reduce((sum, d) => sum + d.count, 0);

  // Detect if only blocked queries are logged
  const onlyBlockedLogged = totalQueries > 0
    && totalBlocked === totalQueries
    && (data?.resolverDecisions || []).length === 1;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Gateway DNS & HTTP</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {!loading && !error && data && totalQueries === 0 && (
        <ErrorMessage
          type={capabilities?.permissions.includes("gateway") ? "empty" : "permission"}
          message={capabilities?.permissions.includes("gateway")
            ? "No Gateway DNS data found for this time period. This may mean no DNS queries were routed through Gateway, or the service hasn't been configured yet."
            : "Your API token doesn't have Gateway permissions. Add the Gateway permission to see this report."}
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? <><CardSkeleton /><CardSkeleton /><CardSkeleton /></> : (
          <>
            <StatCard label="Total DNS Queries" value={formatNumber(totalQueries)} />
            <StatCard label="Blocked Queries" value={formatNumber(totalBlocked)} />
            <StatCard label="Blocked Domains" value={data?.topBlockedDomains.length || 0} />
          </>
        )}
      </div>

      {onlyBlockedLogged && (
        <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <Info size={16} className="mt-0.5 shrink-0 text-blue-400" />
          <p className="text-xs text-blue-300">
            Only blocked queries appear in the analytics. Your Gateway activity logging may be set to &quot;Capture only blocked&quot;.
            To see all DNS queries, change the setting under{" "}
            <span className="font-medium">Traffic policies &gt; Traffic settings &gt; Traffic logging &gt; Log traffic activity</span> to &quot;Capture all&quot;.
          </p>
        </div>
      )}

      <ChartWrapper title="DNS Query Volume Over Time" loading={loading}>
        <TimeSeriesChart
          data={queryVolumeFormatted}
          xKey="date"
          series={[{ key: "count", label: "Queries", color: "#3b82f6" }]}
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Resolver Decisions" loading={loading}>
          <DonutChart
            data={(data?.resolverDecisions || []).map((d) => ({
              name: d.decision,
              value: d.count,
              color: d.decision.includes("blocked") ? "#ef4444" : "#10b981",
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Blocked Categories" loading={loading}>
          <DonutChart
            data={(data?.blockedCategories || []).map((c) => ({
              name: c.category || "Unknown",
              value: c.count,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* GD6: Policy and Location breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="DNS Policies" subtitle="Queries by policy with block counts" loading={loading}>
          <DataTable
            columns={[
              { key: "policyName", label: "Policy" },
              { key: "total", label: "Total", align: "right", render: (v) => formatNumber(v as number) },
              { key: "blocked", label: "Blocked", align: "right", render: (v) => {
                const n = v as number;
                return <span className={n > 0 ? "text-red-400" : "text-zinc-600"}>{formatNumber(n)}</span>;
              }},
            ]}
            data={data?.policyBreakdown || []}
            maxRows={10}
          />
        </ChartWrapper>

        <ChartWrapper title="Queries by Location" subtitle="WARP locations / network profiles" loading={loading}>
          <DataTable
            columns={[
              { key: "location", label: "Location" },
              { key: "total", label: "Total", align: "right", render: (v) => formatNumber(v as number) },
              { key: "blocked", label: "Blocked", align: "right", render: (v) => {
                const n = v as number;
                return <span className={n > 0 ? "text-red-400" : "text-zinc-600"}>{formatNumber(n)}</span>;
              }},
            ]}
            data={data?.locationBreakdown || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper
          title="Top Blocked Domains"
          loading={loading}
          actions={
            (data?.topBlockedDomains.length || 0) > 10 && (
              <button
                onClick={() => setShowAllBlocked((v) => !v)}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {showAllBlocked ? "Show less" : `Show all (${data?.topBlockedDomains.length})`}
              </button>
            )
          }
        >
          <DataTable
            columns={[
              { key: "domain", label: "Domain" },
              { key: "category", label: "Category" },
              { key: "count", label: "Blocks", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={showAllBlocked ? (data?.topBlockedDomains || []) : (data?.topBlockedDomains || []).slice(0, 10)}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Blocked Locations" loading={loading}>
          <DataTable
            columns={[
              { key: "location", label: "Location" },
              { key: "count", label: "Blocks", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topBlockedLocations || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>
    </div>
  );
}
