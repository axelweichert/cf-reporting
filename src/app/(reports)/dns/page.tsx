"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchDnsData, type DnsData } from "@/lib/queries/dns";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, SERIES_COLORS } from "@/components/charts/theme";
import { format } from "date-fns";

export default function DnsPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<DnsData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchDnsData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const timeSeriesFormatted = (data?.queryVolumeByType || []).map((p) => ({
    ...p,
    date: format(new Date(p.date as string), "MMM d HH:mm"),
  }));

  const responseCodeColors: Record<string, string> = {
    NOERROR: "#10b981",
    NXDOMAIN: "#ef4444",
    SERVFAIL: "#eab308",
    REFUSED: "#f97316",
    FORMERR: "#a855f7",
  };

  const nxdomainCount = data?.responseCodeBreakdown.find((r) => r.name === "NXDOMAIN")?.value || 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">DNS Analytics</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {zoneName} – {start} to {end}
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
        ) : (
          <>
            <StatCard label="Total DNS Queries" value={formatNumber(data?.totalQueries || 0)} />
            <StatCard label="DNS Records" value={data?.dnsRecords.length || 0} />
            <StatCard label="NXDOMAIN Queries" value={formatNumber(nxdomainCount)} />
            <StatCard label="Query Types" value={data?.queryTypes.length || 0} />
          </>
        )}
      </div>

      {/* Query Volume by Type */}
      <ChartWrapper title="DNS Query Volume Over Time" subtitle="By record type" loading={loading}>
        <TimeSeriesChart
          data={timeSeriesFormatted}
          xKey="date"
          series={(data?.queryTypes || []).slice(0, 6).map((type, i) => ({
            key: type,
            label: type,
            color: SERIES_COLORS[i % SERIES_COLORS.length],
          }))}
          stacked
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* Two columns: Response Codes + NXDOMAIN */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Response Code Breakdown" loading={loading}>
          <DonutChart
            data={(data?.responseCodeBreakdown || []).map((r) => ({
              name: r.name,
              value: r.value,
              color: responseCodeColors[r.name] || "#6b7280",
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="NXDOMAIN Hotspots" subtitle="Potential misconfigurations" loading={loading}>
          {(data?.nxdomainHotspots || []).length > 0 ? (
            <HorizontalBarChart
              data={data!.nxdomainHotspots.map((n) => ({
                name: n.name.length > 30 ? n.name.slice(0, 30) + "..." : n.name,
                value: n.count,
              }))}
              valueFormatter={formatNumber}
              barColor="#ef4444"
            />
          ) : (
            <p className="py-8 text-center text-sm text-zinc-500">No NXDOMAIN queries detected</p>
          )}
        </ChartWrapper>
      </div>

      {/* Top Queried Records */}
      <ChartWrapper title="Top Queried Records" loading={loading}>
        <HorizontalBarChart
          data={(data?.topQueriedRecords || []).slice(0, 15).map((r) => ({
            name: r.name.length > 40 ? r.name.slice(0, 40) + "..." : r.name,
            value: r.count,
          }))}
          valueFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* DNS Records Inventory */}
      <ChartWrapper title="DNS Records Inventory" loading={loading}>
        <DataTable
          columns={[
            { key: "type", label: "Type", width: "80px" },
            { key: "name", label: "Name" },
            { key: "content", label: "Value" },
            { key: "ttl", label: "TTL", align: "right", render: (v) => (v as number) === 1 ? "Auto" : `${v}s` },
            {
              key: "proxied",
              label: "Proxied",
              align: "center",
              render: (v) => (
                <span className={v ? "text-orange-400" : "text-zinc-600"}>
                  {v ? "Yes" : "No"}
                </span>
              ),
            },
          ]}
          data={data?.dnsRecords || []}
        />
      </ChartWrapper>
    </div>
  );
}
