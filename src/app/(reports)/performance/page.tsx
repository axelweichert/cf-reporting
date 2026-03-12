"use client";

import { useFilterStore, getDateRange, getPreviousPeriod } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchPerformanceData, type PerformanceData } from "@/lib/queries/performance";
import { pctChange, mergeComparisonTimeSeries, makeComparisonSeries } from "@/lib/compare-utils";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatBytes } from "@/components/charts/theme";
import { format } from "date-fns";

export default function PerformancePage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd, compareEnabled } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);
  const prev = getPreviousPeriod(start, end);

  const { data, loading, error, errorType, refetch, prevData, prevLoading } = useReportData<PerformanceData>({
    reportType: "performance",
    scopeId: zoneId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    liveFetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchPerformanceData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
    prevSince: `${prev.start}T00:00:00Z`,
    prevUntil: `${prev.end}T00:00:00Z`,
    prevLiveFetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchPerformanceData(zoneId, `${prev.start}T00:00:00Z`, `${prev.end}T00:00:00Z`);
    },
  });

  if (!zoneId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select a zone from the filter bar to view this report.</p>
      </div>
    );
  }

  const tsFormatted = (data?.timeSeries || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const cmpLoading = compareEnabled && prevLoading;

  // Chart overlay: TTFB + Origin Time
  const perfSeries = [
    { key: "avgTtfb", label: "Avg TTFB (ms)", color: "#3b82f6" },
    { key: "avgOriginTime", label: "Avg Origin Time (ms)", color: "#f59e0b" },
  ];
  const perfValueKeys = ["avgTtfb", "avgOriginTime"];
  let perfData: Record<string, unknown>[] = tsFormatted;
  let perfSeriesFull = perfSeries;
  if (compareEnabled && prevData) {
    const prevFormatted = (prevData.timeSeries || []).map((p) => ({
      ...p,
      date: format(new Date(p.date), "MMM d HH:mm"),
    }));
    perfData = mergeComparisonTimeSeries(tsFormatted, prevFormatted, perfValueKeys);
    perfSeriesFull = [...perfSeries, ...makeComparisonSeries(perfSeries, perfValueKeys)];
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Performance</h1>
        <p className="mt-1 text-sm text-zinc-400">{zoneName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {!loading && !error && data && data.stats.totalRequests === 0 && (
        <ErrorMessage
          type="empty"
          message="No performance data found for this time period."
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {loading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <StatCard label="Total Requests" value={formatNumber(data?.stats.totalRequests || 0)} change={compareEnabled ? pctChange(data?.stats.totalRequests || 0, prevData?.stats.totalRequests) : undefined} compareLoading={cmpLoading} />
            <StatCard label="Avg TTFB" value={`${data?.stats.avgTtfb || 0}ms`} change={compareEnabled ? pctChange(data?.stats.avgTtfb || 0, prevData?.stats.avgTtfb) : undefined} compareLoading={cmpLoading} />
            <StatCard label="P95 TTFB" value={`${data?.stats.p95Ttfb || 0}ms`} change={compareEnabled ? pctChange(data?.stats.p95Ttfb || 0, prevData?.stats.p95Ttfb) : undefined} compareLoading={cmpLoading} />
            <StatCard label="Avg Origin Time" value={`${data?.stats.avgOriginTime || 0}ms`} change={compareEnabled ? pctChange(data?.stats.avgOriginTime || 0, prevData?.stats.avgOriginTime) : undefined} compareLoading={cmpLoading} />
            <StatCard label="P95 Origin Time" value={`${data?.stats.p95OriginTime || 0}ms`} />
            <StatCard label="Total Bandwidth" value={formatBytes(data?.stats.totalBytes || 0)} />
          </>
        )}
      </div>

      <ChartWrapper title="Response Times Over Time" subtitle="Average TTFB and Origin Response Time (ms)" loading={loading}>
        <TimeSeriesChart
          data={perfData}
          xKey="date"
          series={perfSeriesFull}
          yFormatter={(v) => `${v}ms`}
        />
      </ChartWrapper>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="HTTP Protocol Distribution" loading={loading}>
          <DonutChart
            data={(data?.protocolDistribution || []).map((p) => ({
              name: p.protocol,
              value: p.requests,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Edge Locations" subtitle="By request volume" loading={loading}>
          <DataTable
            columns={[
              { key: "colo", label: "Location" },
              { key: "country", label: "Country" },
              { key: "requests", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
              { key: "avgTtfb", label: "Avg TTFB", align: "right", render: (v) => `${v}ms` },
            ]}
            data={data?.coloPerf || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>

      <ChartWrapper title="Performance by Content Type" subtitle="Average response times and sizes per content type" loading={loading}>
        <DataTable
          columns={[
            { key: "contentType", label: "Content Type" },
            { key: "requests", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
            { key: "avgTtfb", label: "Avg TTFB", align: "right", render: (v) => `${v}ms` },
            { key: "avgOriginTime", label: "Avg Origin", align: "right", render: (v) => `${v}ms` },
            { key: "avgResponseBytes", label: "Avg Size", align: "right", render: (v) => formatBytes(v as number) },
          ]}
          data={data?.contentTypePerf || []}
          maxRows={15}
        />
      </ChartWrapper>

      <ChartWrapper title="Performance by Country" subtitle="Top countries by request volume" loading={loading}>
        <DataTable
          columns={[
            { key: "country", label: "Country" },
            { key: "requests", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
            { key: "avgTtfb", label: "Avg TTFB", align: "right", render: (v) => `${v}ms` },
            { key: "avgOriginTime", label: "Avg Origin", align: "right", render: (v) => `${v}ms` },
          ]}
          data={data?.countryPerf || []}
          maxRows={10}
        />
      </ChartWrapper>
    </div>
  );
}
