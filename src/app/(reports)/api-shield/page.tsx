"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchApiShieldData, type ApiShieldData } from "@/lib/queries/api-shield";
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

function StateBadge({ state }: { state: string }) {
  const styles = state === "saved"
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>
      {state === "saved" ? "Saved" : "In Review"}
    </span>
  );
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "text-blue-400",
    POST: "text-emerald-400",
    PUT: "text-yellow-400",
    DELETE: "text-red-400",
    PATCH: "text-purple-400",
    OPTIONS: "text-zinc-400",
    HEAD: "text-zinc-500",
  };
  return (
    <span className={`font-mono text-xs font-semibold ${colors[method] || "text-zinc-400"}`}>
      {method}
    </span>
  );
}

export default function ApiShieldPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useReportData<ApiShieldData>({
    reportType: "api-shield",
    scopeId: zoneId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    liveFetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchApiShieldData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
  });

  if (!zoneId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select a zone from the filter bar to view this report.</p>
      </div>
    );
  }

  const sessionTsFormatted = (data?.sessionTraffic || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const hasNoData = !loading && !error && data
    && data.stats.totalManaged === 0 && data.stats.totalDiscovered === 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">API Shield</h1>
        <p className="mt-1 text-sm text-zinc-400">{zoneName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {hasNoData && (
        <ErrorMessage
          type="empty"
          message="No API Shield data found. API Gateway may not be configured for this zone."
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {loading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <StatCard label="Managed Endpoints" value={formatNumber(data?.stats.totalManaged || 0)} />
            <StatCard label="Discovered Endpoints" value={formatNumber(data?.stats.totalDiscovered || 0)} />
            <StatCard label="Awaiting Review" value={formatNumber(data?.stats.discoveredInReview || 0)} />
            <StatCard label="Avg Req/Hour" value={data?.stats.avgRequestsPerHour?.toFixed(1) || "0"} />
            <StatCard label="Session ID" value={data?.stats.sessionIdentifier || "–"} />
          </>
        )}
      </div>

      {/* Session identifier info */}
      {!loading && data && data.stats.sessionIdentifier !== "Not configured" && (
        <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <Info size={16} className="mt-0.5 shrink-0 text-blue-400" />
          <p className="text-xs text-blue-300">
            API sessions are tracked using the <span className="font-medium">{data.stats.sessionIdentifier}</span> identifier.
            Requests without this identifier appear as unauthenticated.
          </p>
        </div>
      )}

      {/* Session traffic over time */}
      {sessionTsFormatted.length > 0 && (
        <ChartWrapper title="API Session Traffic" subtitle="Authenticated vs Unauthenticated requests" loading={loading}>
          <TimeSeriesChart
            data={sessionTsFormatted}
            xKey="date"
            series={[
              { key: "authenticated", label: "Authenticated", color: "#10b981" },
              { key: "unauthenticated", label: "Unauthenticated", color: "#ef4444" },
            ]}
            yFormatter={formatNumber}
          />
        </ChartWrapper>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="HTTP Method Distribution" subtitle="Across managed endpoints" loading={loading}>
          <DonutChart
            data={(data?.methodDistribution || []).map((m) => ({
              name: m.method,
              value: m.count,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Endpoint Traffic" subtitle="By total requests with status breakdown" loading={loading}>
          <DataTable
            columns={[
              { key: "endpointPath", label: "Endpoint", render: (v) => (
                <span className="font-mono text-xs">{String(v)}</span>
              )},
              { key: "requests", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
              { key: "status2xx", label: "2xx", align: "right", render: (v) => formatNumber(v as number) },
              { key: "status4xx", label: "4xx", align: "right", render: (v) => {
                const n = v as number;
                return n > 0 ? <span className="text-yellow-400">{formatNumber(n)}</span> : "0";
              }},
              { key: "status5xx", label: "5xx", align: "right", render: (v) => {
                const n = v as number;
                return n > 0 ? <span className="text-red-400">{formatNumber(n)}</span> : "0";
              }},
            ]}
            data={data?.topEndpointTraffic || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>

      {/* Discovered endpoints table */}
      <ChartWrapper
        title="Discovered Endpoints"
        subtitle={`${data?.stats.totalDiscovered || 0} endpoints discovered by ML`}
        loading={loading}
      >
        <DataTable
          columns={[
            { key: "method", label: "Method", width: "80px", render: (v) => <MethodBadge method={v as string} /> },
            { key: "host", label: "Host" },
            { key: "endpoint", label: "Endpoint" },
            { key: "avgRequestsPerHour", label: "Avg Req/h", align: "right", render: (v) => (v as number).toFixed(1) },
            { key: "state", label: "State", align: "center", render: (v) => <StateBadge state={v as string} /> },
          ]}
          data={data?.discoveredEndpoints || []}
          maxRows={15}
        />
      </ChartWrapper>

      {/* Managed operations table */}
      <ChartWrapper
        title="Managed API Operations"
        subtitle={`${data?.stats.totalManaged || 0} total operations (showing first 50)`}
        loading={loading}
      >
        <DataTable
          columns={[
            { key: "method", label: "Method", width: "80px", render: (v) => <MethodBadge method={v as string} /> },
            { key: "host", label: "Host" },
            { key: "endpoint", label: "Endpoint" },
          ]}
          data={data?.managedOperations || []}
          maxRows={15}
        />
      </ChartWrapper>
    </div>
  );
}
