"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchExecutiveData, type ExecutiveData } from "@/lib/queries/executive";
import ChartWrapper from "@/components/charts/chart-wrapper";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatBytes, formatPercent, STATUS_COLORS } from "@/components/charts/theme";
import { AlertTriangle, Info, AlertCircle } from "lucide-react";

export default function ExecutivePage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<ExecutiveData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchExecutiveData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const severityIcons = {
    info: <Info size={16} className="text-blue-400" />,
    warning: <AlertTriangle size={16} className="text-yellow-400" />,
    critical: <AlertCircle size={16} className="text-red-400" />,
  };

  const severityColors = {
    info: "border-blue-500/20 bg-blue-500/10",
    warning: "border-yellow-500/20 bg-yellow-500/10",
    critical: "border-red-500/20 bg-red-500/10",
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 print:space-y-4 print:text-black">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white print:text-black">Executive Report</h1>
        <p className="mt-1 text-sm text-zinc-400 print:text-gray-600">
          {zoneName} – {start} to {end}
        </p>
      </div>

      {error && !loading && (
        <ErrorMessage type="generic" message={error} onRetry={refetch} />
      )}

      {/* Key Metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 print:grid-cols-4">
        {loading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : (
          <>
            <StatCard label="Total Requests" value={formatNumber(data?.traffic.totalRequests || 0)} />
            <StatCard label="Total Bandwidth" value={formatBytes(data?.traffic.totalBandwidth || 0)} />
            <StatCard label="Cache Hit Ratio" value={formatPercent(data?.traffic.cacheHitRatio || 0)} />
            <StatCard label="Threats Blocked" value={formatNumber(data?.security.totalThreatsBlocked || 0)} />
          </>
        )}
      </div>

      {/* Security Summary */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 print:grid-cols-2">
        <ChartWrapper title="Response Status Codes" loading={loading}>
          <DonutChart
            data={(data?.statusCodeBreakdown || []).map((s) => ({
              name: s.name,
              value: s.value,
              color: STATUS_COLORS[s.name] || "#6b7280",
            }))}
            valueFormatter={formatNumber}
            height={200}
            innerRadius={45}
            outerRadius={70}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Traffic Sources" subtitle="By country" loading={loading}>
          <HorizontalBarChart
            data={(data?.topCountries || []).slice(0, 8).map((c) => ({
              name: c.name,
              value: c.value,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* Threat Vectors */}
      {(data?.security.topThreatVectors || []).length > 0 && (
        <ChartWrapper title="Top Threat Vectors" loading={loading}>
          <DataTable
            columns={[
              { key: "name", label: "Source" },
              { key: "count", label: "Events", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.security.topThreatVectors || []}
          />
        </ChartWrapper>
      )}

      {/* Recommendations */}
      {(data?.recommendations || []).length > 0 && (
        <div className="space-y-3 print:break-before-page">
          <h2 className="text-lg font-semibold text-white print:text-black">Recommendations</h2>
          {data!.recommendations.map((rec, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 rounded-lg border p-4 ${severityColors[rec.severity]}`}
            >
              <div className="mt-0.5 shrink-0">{severityIcons[rec.severity]}</div>
              <div>
                <h3 className="text-sm font-medium text-white print:text-black">{rec.title}</h3>
                <p className="mt-0.5 text-sm text-zinc-400 print:text-gray-600">{rec.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
