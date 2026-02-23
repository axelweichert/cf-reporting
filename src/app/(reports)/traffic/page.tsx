"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchTrafficData, type TrafficData } from "@/lib/queries/traffic";
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
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<TrafficData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchTrafficData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
    deps: [zoneId, start, end],
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

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Traffic Overview</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {zoneName} — {start} to {end}
        </p>
      </div>

      {error && !loading && (
        <ErrorMessage type="generic" message={error} onRetry={refetch} />
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
            <StatCard label="Total Requests" value={formatNumber(data.totalRequests)} />
            <StatCard label="Total Bandwidth" value={formatBytes(data.totalBandwidth)} />
            <StatCard label="Cache Hit Ratio" value={formatPercent(data.cache.ratio)} />
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

      {/* Bandwidth Over Time */}
      <ChartWrapper title="Bandwidth Over Time" loading={loading}>
        <TimeSeriesChart
          data={timeSeriesFormatted}
          xKey="date"
          series={[
            { key: "bandwidth", label: "Bandwidth", color: "#3b82f6" },
          ]}
          yFormatter={formatBytes}
        />
      </ChartWrapper>

      {/* Two-column layout: Cache + Status Codes */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Cache Hit Ratio" loading={loading}>
          <DonutChart
            data={[
              { name: "Hit", value: data?.cache.hit || 0, color: "#10b981" },
              { name: "Miss", value: data?.cache.miss || 0, color: "#ef4444" },
            ]}
            centerValue={data ? formatPercent(data.cache.ratio) : "—"}
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
