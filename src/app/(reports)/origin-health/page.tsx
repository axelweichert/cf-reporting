"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchOriginHealthData, type OriginHealthData } from "@/lib/queries/origin-health";
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

function HealthBadge({ status }: { status: string }) {
  const styles = status === "healthy"
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    : status === "degraded"
    ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
    : "bg-red-500/10 text-red-400 border-red-500/20";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>
      {status}
    </span>
  );
}

function StatusGroupBadge({ group }: { group: string }) {
  let color = "text-zinc-400";
  if (group.startsWith("2xx")) color = "text-emerald-400";
  else if (group.startsWith("3xx")) color = "text-blue-400";
  else if (group.startsWith("4xx")) color = "text-yellow-400";
  else if (group.startsWith("5xx")) color = "text-red-400";
  else if (group.startsWith("No")) color = "text-zinc-500";
  return <span className={`text-xs font-medium ${color}`}>{group}</span>;
}

export default function OriginHealthPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<OriginHealthData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchOriginHealthData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const tsFormatted = (data?.timeSeries || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  // Aggregate status groups for donut chart
  const statusGroups = new Map<string, number>();
  for (const s of data?.statusBreakdown || []) {
    statusGroups.set(s.statusGroup, (statusGroups.get(s.statusGroup) || 0) + s.requests);
  }
  const statusGroupData = Array.from(statusGroups.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Origin Health</h1>
        <p className="mt-1 text-sm text-zinc-400">{zoneName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <StatCard label="Total Requests" value={formatNumber(data?.stats.totalRequests || 0)} />
            <StatCard label="Avg Origin Response" value={`${data?.stats.avgResponseTime || 0}ms`} />
            <StatCard label="P95 Origin Response" value={`${data?.stats.p95ResponseTime || 0}ms`} />
            <StatCard label="5xx Error Rate" value={`${data?.stats.errorRate5xx || 0}%`} />
          </>
        )}
      </div>

      {/* Health checks info */}
      {!loading && data && !data.hasHealthChecks && (
        <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <Info size={16} className="mt-0.5 shrink-0 text-blue-400" />
          <p className="text-xs text-blue-300">
            No standalone health checks are configured for this zone. Origin metrics below are derived from
            actual traffic data. Configure health checks in the Cloudflare dashboard for proactive origin monitoring.
          </p>
        </div>
      )}

      {/* Health check monitors */}
      {!loading && data && data.hasHealthChecks && data.healthChecks.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Health Check Monitors</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.healthChecks.map((hc) => (
              <div key={hc.name} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-white">{hc.name}</p>
                  <HealthBadge status={hc.status} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                  <div><span className="text-zinc-500">Address:</span> <span className="text-zinc-300">{hc.address}</span></div>
                  <div><span className="text-zinc-500">Type:</span> <span className="text-zinc-300">{hc.type}</span></div>
                  <div><span className="text-zinc-500">Interval:</span> <span className="text-zinc-300">{hc.interval}s</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Origin response time over time */}
      <ChartWrapper title="Origin Response Time" subtitle="Average response time and 5xx error rate" loading={loading}>
        <TimeSeriesChart
          data={tsFormatted}
          xKey="date"
          series={[
            { key: "avgResponseTime", label: "Avg Response (ms)", color: "#3b82f6" },
            { key: "errorRate", label: "5xx Error Rate (%)", color: "#ef4444", yAxisId: "right" },
          ]}
          yFormatter={(v) => `${v}ms`}
        />
      </ChartWrapper>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Origin Response Status Groups" loading={loading}>
          <DonutChart
            data={statusGroupData}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Origin Status Breakdown" subtitle="By HTTP status code" loading={loading}>
          <DataTable
            columns={[
              { key: "status", label: "Status", render: (v) => (v as number) === 0 ? "—" : String(v) },
              { key: "statusGroup", label: "Group", render: (v) => <StatusGroupBadge group={v as string} /> },
              { key: "requests", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
              { key: "avgResponseTime", label: "Avg Response", align: "right", render: (v) => `${v}ms` },
            ]}
            data={data?.statusBreakdown || []}
            maxRows={15}
          />
        </ChartWrapper>
      </div>

      {/* Health check events (if any) */}
      {!loading && data && data.healthEvents.length > 0 && (
        <ChartWrapper title="Recent Health Check Events" loading={loading}>
          <DataTable
            columns={[
              { key: "datetime", label: "Time", render: (v) => {
                try { return format(new Date(v as string), "MMM d HH:mm:ss"); }
                catch { return v as string; }
              }},
              { key: "name", label: "Check" },
              { key: "status", label: "Status", render: (v) => <HealthBadge status={v as string} /> },
              { key: "originIp", label: "Origin IP" },
              { key: "rttMs", label: "RTT", align: "right", render: (v) => `${v}ms` },
              { key: "region", label: "Region" },
              { key: "failureReason", label: "Failure Reason" },
            ]}
            data={data.healthEvents}
            maxRows={20}
          />
        </ChartWrapper>
      )}
    </div>
  );
}
