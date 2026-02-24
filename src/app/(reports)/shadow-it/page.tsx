"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchShadowItData, type ShadowItData } from "@/lib/queries/shadow-it";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, SERIES_COLORS } from "@/components/charts/theme";
import { Info } from "lucide-react";
import { format } from "date-fns";

export default function ShadowItPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<ShadowItData>({
    fetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchShadowItData(accountId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const trendFormatted = (data?.usageTrends || []).map((p) => ({
    ...p,
    date: format(new Date(p.date as string), "MMM d HH:mm"),
  }));

  const totalDiscovered = data?.discoveredApplications.length || 0;
  const totalRequests = (data?.discoveredApplications || []).reduce((s, a) => s + a.count, 0);

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
            <StatCard label="Discovered Apps" value={totalDiscovered} />
            <StatCard label="App Requests" value={formatNumber(totalRequests)} />
            <StatCard label="Unidentified Categories" value={data?.categoryBreakdown.length || 0} />
            <StatCard label="Unidentified Requests" value={formatNumber((data?.categoryBreakdown || []).reduce((s, c) => s + c.count, 0))} />
          </>
        )}
      </div>

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

      {/* Discovered Applications - full width with category column */}
      <ChartWrapper title="Discovered Applications" loading={loading}>
        <DataTable
          columns={[
            { key: "name", label: "Application" },
            { key: "category", label: "Category" },
            { key: "count", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
          ]}
          data={data?.discoveredApplications || []}
          maxRows={20}
        />
      </ChartWrapper>

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
