"use client";

import { useFilterStore, getDateRange, getPreviousPeriod } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { useReportData } from "@/lib/use-report-data";
import { fetchTrafficData, fetchTrafficSummaryStats, type TrafficData, type TrafficSummaryStats } from "@/lib/queries/traffic";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatBytes, formatPercent, STATUS_COLORS } from "@/components/charts/theme";
import { format } from "date-fns";

export default function TrafficPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd, compareEnabled } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);
  const prev = getPreviousPeriod(start, end);

  const { data, loading, error, errorType, refetch } = useReportData<TrafficData>({
    reportType: "traffic",
    scopeId: zoneId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    liveFetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchTrafficData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
  });

  // Period-over-period comparison (E2, T8)
  const { data: prevStats } = useCfData<TrafficSummaryStats>({
    fetcher: () => {
      if (!zoneId || !compareEnabled) throw new Error("skip");
      return fetchTrafficSummaryStats(zoneId, `${prev.start}T00:00:00Z`, `${prev.end}T00:00:00Z`);
    },
    deps: [zoneId, prev.start, prev.end, compareEnabled],
  });

  if (!zoneId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select a zone from the filter bar to view this report.</p>
      </div>
    );
  }

  // Format time series for display
  const timeSeriesFormatted = (data?.timeSeries || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const statusCodeData = (data?.statusCodes || []).map((s) => ({
    ...s,
    color: STATUS_COLORS[s.name] || "#6b7280",
  }));

  // Compute period-over-period changes
  function pctChange(current: number, previous: number | undefined): number | undefined {
    if (previous === undefined || previous === 0) return undefined;
    return ((current - previous) / previous) * 100;
  }

  const reqChange = compareEnabled && prevStats ? pctChange(data?.totalRequests || 0, prevStats.totalRequests) : undefined;
  const bwChange = compareEnabled && prevStats ? pctChange(data?.totalBandwidth || 0, prevStats.totalBandwidth) : undefined;
  const cacheChange = compareEnabled && prevStats ? pctChange(data?.cache.ratio || 0, prevStats.cacheRatio) : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Traffic Overview</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {zoneName} – {start} to {end}
        </p>
      </div>

      {error && !loading && (
        <ErrorMessage type={errorType} message={error} onRetry={refetch} />
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : data ? (
          <>
            <StatCard label="Total Requests" value={formatNumber(data.totalRequests)} change={reqChange} />
            <StatCard label="Total Bandwidth" value={formatBytes(data.totalBandwidth)} change={bwChange} />
            <StatCard label="Cache Hit Ratio" value={formatPercent(data.cache.ratio)} change={cacheChange} />
            <StatCard label="Cached Requests" value={formatNumber(data.cache.hit)} />
          </>
        ) : null}
      </div>

      {/* Requests Over Time */}
      <ChartWrapper title="Requests Over Time" loading={loading}>
        <TimeSeriesChart
          data={timeSeriesFormatted}
          xKey="date"
          series={[
            { key: "requests", label: "Requests", color: "#f97316" },
          ]}
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* Bandwidth: Cached vs Uncached */}
      <ChartWrapper title="Bandwidth Over Time" subtitle="Cached vs origin" loading={loading}>
        <TimeSeriesChart
          data={(data?.bandwidthByCache || []).map((p) => ({
            ...p,
            date: format(new Date(p.date), "MMM d HH:mm"),
          }))}
          xKey="date"
          series={[
            { key: "cached", label: "Cached (CDN)", color: "#10b981" },
            { key: "uncached", label: "Origin", color: "#f97316" },
          ]}
          stacked
          yFormatter={formatBytes}
        />
      </ChartWrapper>

      {/* Error Rate Trend */}
      <ChartWrapper title="Error Rate Over Time" subtitle="4xx and 5xx responses" loading={loading}>
        {(data?.errorTrend || []).length > 0 ? (
          <TimeSeriesChart
            data={(data?.errorTrend || []).map((p) => ({
              ...p,
              date: format(new Date(p.date), "MMM d HH:mm"),
            }))}
            xKey="date"
            series={[
              { key: "4xx", label: "4xx Client Errors", color: "#eab308" },
              { key: "5xx", label: "5xx Server Errors", color: "#ef4444" },
            ]}
            yFormatter={formatNumber}
          />
        ) : (
          <p className="py-12 text-center text-sm text-zinc-500">No errors detected in this period</p>
        )}
      </ChartWrapper>

      {/* Two-column layout: Cache + Status Codes */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Cache Hit Ratio" loading={loading}>
          <DonutChart
            data={[
              { name: "Hit", value: data?.cache.hit || 0, color: "#10b981" },
              { name: "Miss", value: data?.cache.miss || 0, color: "#ef4444" },
            ]}
            centerValue={data ? formatPercent(data.cache.ratio) : "–"}
            centerLabel="Hit Ratio"
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Response Status Codes" loading={loading}>
          <DonutChart
            data={statusCodeData}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* Content Type Breakdown */}
      <ChartWrapper title="Content Type Distribution" subtitle="By response content type" loading={loading}>
        <HorizontalBarChart
          data={(data?.contentTypes || []).slice(0, 10)}
          valueFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* Two-column: Top Paths + Top Countries */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Top Pages / URIs" subtitle="By request count" loading={loading}>
          <HorizontalBarChart
            data={(data?.topPaths || []).slice(0, 10)}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Geographic Distribution" subtitle="Top countries by request count" loading={loading}>
          <DataTable
            columns={[
              { key: "name", label: "Country" },
              {
                key: "value",
                label: "Requests",
                align: "right" as const,
                render: (v) => formatNumber(v as number),
              },
            ]}
            data={data?.topCountries || []}
            maxRows={15}
          />
        </ChartWrapper>
      </div>
    </div>
  );
}
