"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchGatewayNetworkData, type GatewayNetworkData } from "@/lib/queries/gateway-network";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { format } from "date-fns";

export default function GatewayNetworkPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<GatewayNetworkData>({
    fetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchGatewayNetworkData(accountId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const sessionsFormatted = (data?.sessionsOverTime || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const totalAllowed = (data?.sessionsOverTime || []).reduce((sum, p) => sum + p.allowed, 0);
  const totalBlocked = (data?.sessionsOverTime || []).reduce((sum, p) => sum + p.blocked, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Gateway L4 / Network</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {!loading && !error && data && totalAllowed === 0 && totalBlocked === 0 && (
        <ErrorMessage
          type={capabilities?.permissions.includes("gateway") ? "empty" : "permission"}
          message={capabilities?.permissions.includes("gateway")
            ? "No Gateway Network data found for this time period. This may mean no L4 sessions were routed through Gateway, or the service hasn't been configured yet."
            : "Your API token doesn't have Gateway permissions. Add the Gateway permission to see this report."}
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? <><CardSkeleton /><CardSkeleton /><CardSkeleton /></> : (
          <>
            <StatCard label="Allowed Sessions" value={formatNumber(totalAllowed)} />
            <StatCard label="Blocked Sessions" value={formatNumber(totalBlocked)} />
            <StatCard label="Blocked Destinations" value={data?.blockedDestinations.length || 0} />
          </>
        )}
      </div>

      <ChartWrapper title="L4 Sessions Over Time" subtitle="Allowed vs Blocked" loading={loading}>
        <TimeSeriesChart
          data={sessionsFormatted}
          xKey="date"
          series={[
            { key: "allowed", label: "Allowed", color: "#10b981" },
            { key: "blocked", label: "Blocked", color: "#ef4444" },
          ]}
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Transport Protocols" loading={loading}>
          <DonutChart
            data={(data?.transportProtocols || []).map((p) => ({
              name: p.protocol || "Unknown",
              value: p.count,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Source Countries" loading={loading}>
          <DataTable
            columns={[
              { key: "country", label: "Country" },
              { key: "count", label: "Sessions", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topSourceCountries || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>

      <ChartWrapper title="Blocked Destinations" loading={loading}>
        <DataTable
          columns={[
            { key: "ip", label: "Destination IP" },
            { key: "count", label: "Blocks", align: "right", render: (v) => formatNumber(v as number) },
          ]}
          data={data?.blockedDestinations || []}
          maxRows={10}
        />
      </ChartWrapper>
    </div>
  );
}
