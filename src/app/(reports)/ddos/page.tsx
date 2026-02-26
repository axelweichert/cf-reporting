"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchDdosData, type DdosData } from "@/lib/queries/ddos";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { format } from "date-fns";

export default function DdosPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<DdosData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchDdosData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const formatTime = (points: Array<{ date: string; count: number }>) =>
    points.map((p) => ({
      ...p,
      date: format(new Date(p.date), "MMM d HH:mm"),
    }));

  const ddosTime = formatTime(data?.ddosEventsOverTime || []);
  const rlTime = formatTime(data?.rateLimitEventsOverTime || []);

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">DDoS & Rate Limiting</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {zoneName} – {start} to {end}
        </p>
      </div>

      {error && !loading && (
        <ErrorMessage type={errorType} message={error} onRetry={refetch} />
      )}

      {/* ── L7 DDoS Section ── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">L7 DDoS Mitigation</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {loading ? (
            <>
              <CardSkeleton />
              <CardSkeleton />
            </>
          ) : (
            <>
              <StatCard label="L7 DDoS Blocked" value={formatNumber(data?.totalDdosEvents || 0)} />
              <StatCard
                label="Attack Methods"
                value={formatNumber((data?.ddosAttackVectors || []).length)}
              />
            </>
          )}
        </div>

        <ChartWrapper
          title="L7 DDoS Events Over Time"
          subtitle="Blocked requests from L7 DDoS mitigation"
          loading={loading}
        >
          {ddosTime.length > 0 ? (
            <TimeSeriesChart
              data={ddosTime}
              xKey="date"
              series={[{ key: "count", label: "DDoS Events", color: "#ef4444" }]}
              yFormatter={formatNumber}
            />
          ) : (
            <p className="py-12 text-center text-sm text-zinc-500">
              No L7 DDoS events detected in this period
            </p>
          )}
        </ChartWrapper>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartWrapper title="DDoS Attack Methods" loading={loading}>
            {(data?.ddosAttackVectors || []).length > 0 ? (
              <HorizontalBarChart
                data={(data?.ddosAttackVectors || []).map((v) => ({
                  name: v.method,
                  value: v.count,
                }))}
                valueFormatter={formatNumber}
                barColor="#ef4444"
              />
            ) : (
              <p className="py-12 text-center text-sm text-zinc-500">
                No DDoS attack methods detected
              </p>
            )}
          </ChartWrapper>

          <ChartWrapper title="Top DDoS Targeted Paths" loading={loading}>
            <DataTable
              columns={[
                { key: "path", label: "Path" },
                { key: "count", label: "Events", align: "right" as const, render: (v) => formatNumber(v as number) },
              ]}
              data={data?.ddosTopPaths || []}
              maxRows={10}
            />
          </ChartWrapper>
        </div>
      </section>

      {/* ── Rate Limiting Section ── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Rate Limiting</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {loading ? (
            <>
              <CardSkeleton />
              <CardSkeleton />
            </>
          ) : (
            <>
              <StatCard label="Rate Limit Events" value={formatNumber(data?.totalRateLimitEvents || 0)} />
              <StatCard
                label="Targeted Paths"
                value={formatNumber((data?.rateLimitTopPaths || []).length)}
              />
            </>
          )}
        </div>

        <ChartWrapper title="Rate Limiting Events Over Time" loading={loading}>
          {rlTime.length > 0 ? (
            <TimeSeriesChart
              data={rlTime}
              xKey="date"
              series={[{ key: "count", label: "Rate Limit Events", color: "#eab308" }]}
              yFormatter={formatNumber}
            />
          ) : (
            <p className="py-12 text-center text-sm text-zinc-500">
              No rate limiting events detected in this period
            </p>
          )}
        </ChartWrapper>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartWrapper title="Rate Limited Methods" loading={loading}>
            {(data?.rateLimitMethods || []).length > 0 ? (
              <HorizontalBarChart
                data={(data?.rateLimitMethods || []).map((v) => ({
                  name: v.method,
                  value: v.count,
                }))}
                valueFormatter={formatNumber}
                barColor="#eab308"
              />
            ) : (
              <p className="py-12 text-center text-sm text-zinc-500">
                No rate limited methods detected
              </p>
            )}
          </ChartWrapper>

          <ChartWrapper title="Top Rate Limited Paths" loading={loading}>
            <DataTable
              columns={[
                { key: "path", label: "Path" },
                { key: "count", label: "Events", align: "right" as const, render: (v) => formatNumber(v as number) },
              ]}
              data={data?.rateLimitTopPaths || []}
              maxRows={10}
            />
          </ChartWrapper>
        </div>
      </section>
    </div>
  );
}
