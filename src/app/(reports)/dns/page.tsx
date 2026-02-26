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
import { Zap } from "lucide-react";

export default function DnsPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<DnsData>({
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
  const activeRecords = data?.dnsRecords.filter((r) => r.status === "active").length || 0;
  const unqueriedRecords = data?.dnsRecords.filter((r) => r.status === "unqueried").length || 0;

  function fmtMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms < 0.01) return `<0.01ms`;
    return `${ms.toFixed(2)}ms`;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">DNS Analytics</h1>
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
        ) : (
          <>
            <StatCard label="Total DNS Queries" value={formatNumber(data?.totalQueries || 0)} />
            <StatCard label="DNS Records" value={`${data?.dnsRecords.length || 0} (${activeRecords} active)`} />
            <StatCard label="NXDOMAIN Queries" value={formatNumber(nxdomainCount)} />
            <StatCard label="Query Types" value={data?.queryTypes.length || 0} />
          </>
        )}
      </div>

      {/* DNS Resolution Latency */}
      {!loading && data && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="mb-3 flex items-center gap-2">
            <Zap size={16} className="text-blue-400" />
            <h3 className="text-sm font-medium text-zinc-300">DNS Resolution Time</h3>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div>
              <p className="text-xs text-zinc-500">Avg</p>
              <p className="text-lg font-semibold text-white">{fmtMs(data.latency.avg)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">P50</p>
              <p className="text-lg font-semibold text-white">{fmtMs(data.latency.p50)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">P90</p>
              <p className="text-lg font-semibold text-yellow-400">{fmtMs(data.latency.p90)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">P99</p>
              <p className="text-lg font-semibold text-red-400">{fmtMs(data.latency.p99)}</p>
            </div>
          </div>
        </div>
      )}

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
      <ChartWrapper
        title="DNS Records Inventory"
        subtitle={unqueriedRecords > 0 ? `${unqueriedRecords} records had no queries this period` : undefined}
        loading={loading}
      >
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
            {
              key: "queryCount",
              label: "Queries",
              align: "right",
              render: (v) => formatNumber(v as number),
            },
            {
              key: "status",
              label: "Health",
              align: "center",
              render: (v) => {
                const styles = {
                  active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
                  unqueried: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
                  error: "bg-red-500/10 text-red-400 border-red-500/20",
                };
                const labels = { active: "Active", unqueried: "No Queries", error: "NXDOMAIN" };
                const s = v as "active" | "unqueried" | "error";
                return (
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${styles[s]}`}>
                    {labels[s]}
                  </span>
                );
              },
            },
          ]}
          data={data?.dnsRecords || []}
        />
      </ChartWrapper>
    </div>
  );
}
