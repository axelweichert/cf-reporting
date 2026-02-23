"use client";

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
import { format } from "date-fns";

export default function GatewayDnsPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<GatewayDnsData>({
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
    .filter((d) => d.decision.includes("blocked"))
    .reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Gateway DNS & HTTP</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} — {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type="generic" message={error} onRetry={refetch} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? <><CardSkeleton /><CardSkeleton /><CardSkeleton /></> : (
          <>
            <StatCard label="Total DNS Queries" value={formatNumber(totalQueries)} />
            <StatCard label="Blocked Queries" value={formatNumber(totalBlocked)} />
            <StatCard label="Blocked Domains" value={data?.topBlockedDomains.length || 0} />
          </>
        )}
      </div>

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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Top Blocked Domains" loading={loading}>
          <DataTable
            columns={[
              { key: "domain", label: "Domain" },
              { key: "count", label: "Blocks", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topBlockedDomains || []}
            maxRows={15}
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
