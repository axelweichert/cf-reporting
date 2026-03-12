"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchTrafficData, type TrafficData } from "@/lib/queries/traffic";
import { pctChange, buildComparisonChart, formatTimeSeries } from "@/lib/compare-utils";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatBytes, formatPercent, STATUS_COLORS } from "@/components/charts/theme";

export default function TrafficPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd, compareEnabled } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch, prevData, cmpLoading } = useReportData<TrafficData>({
    reportType: "traffic",
    scopeId: zoneId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    fetcher: (s, u) => {
      if (!zoneId) throw new Error("No zone available");
      return fetchTrafficData(zoneId, s, u);
    },
  });

  if (!zoneId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select a zone from the filter bar to view this report.</p>
      </div>
    );
  }

  // Format time series for display
  const timeSeriesFormatted = formatTimeSeries(data?.timeSeries || []);

  const statusCodeData = (data?.statusCodes || []).map((s) => ({
    ...s,
    color: STATUS_COLORS[s.name] || "#6b7280",
  }));

  // Compute period-over-period changes
  const reqChange = compareEnabled && prevData ? pctChange(data?.totalRequests || 0, prevData.totalRequests) : undefined;
  const bwChange = compareEnabled && prevData ? pctChange(data?.totalBandwidth || 0, prevData.totalBandwidth) : undefined;
  const cacheChange = compareEnabled && prevData ? pctChange(data?.cache.ratio || 0, prevData.cache.ratio) : undefined;

  // Chart overlay: Requests Over Time
  const requestsSeries = [{ key: "requests", label: "Requests", color: "#f97316" }];
  const { data: requestsData, series: requestsSeriesFull } = buildComparisonChart({
    current: timeSeriesFormatted,
    previous: prevData ? formatTimeSeries(prevData.timeSeries || []) : undefined,
    series: requestsSeries,
    valueKeys: ["requests"],
    compareEnabled,
  });

  // Chart overlay: Error Rate
  const errorSeries = [
    { key: "4xx", label: "4xx Client Errors", color: "#eab308" },
    { key: "5xx", label: "5xx Server Errors", color: "#ef4444" },
  ];
  const errorFormatted = formatTimeSeries(data?.errorTrend || []);
  const { data: errorData, series: errorSeriesFull } = buildComparisonChart({
    current: errorFormatted,
    previous: prevData ? formatTimeSeries(prevData.errorTrend || []) : undefined,
    series: errorSeries,
    valueKeys: ["4xx", "5xx"],
    compareEnabled,
  });

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
            <StatCard label="Total Requests" value={formatNumber(data.totalRequests)} change={reqChange} compareLoading={cmpLoading} />
            <StatCard label="Total Bandwidth" value={formatBytes(data.totalBandwidth)} change={bwChange} compareLoading={cmpLoading} />
            <StatCard label="Cache Hit Ratio" value={formatPercent(data.cache.ratio)} change={cacheChange} compareLoading={cmpLoading} />
            <StatCard label="Cached Requests" value={formatNumber(data.cache.hit)} />
          </>
        ) : null}
      </div>

      {/* Requests Over Time */}
      <ChartWrapper title="Requests Over Time" loading={loading}>
        <TimeSeriesChart
          data={requestsData}
          xKey="date"
          series={requestsSeriesFull}
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* Bandwidth: Cached vs Uncached */}
      <ChartWrapper title="Bandwidth Over Time" subtitle="Cached vs origin" loading={loading}>
        <TimeSeriesChart
          data={formatTimeSeries(data?.bandwidthByCache || [])}
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
            data={errorData}
            xKey="date"
            series={errorSeriesFull}
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
