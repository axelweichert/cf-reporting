"use client";

import { useFilterStore, getDateRange, getPreviousPeriod } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchDdosData, type DdosData } from "@/lib/queries/ddos";
import { pctChange, mergeComparisonTimeSeries, makeComparisonSeries } from "@/lib/compare-utils";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatBytes } from "@/components/charts/theme";
import { format } from "date-fns";
import { Info } from "lucide-react";

export default function DdosPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, selectedZone, timeRange, customStart, customEnd, compareEnabled } = useFilterStore();
  const zones = capabilities?.zones || [];
  const accounts = capabilities?.accounts || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const { start, end } = getDateRange(timeRange, customStart, customEnd);
  const prev = getPreviousPeriod(start, end);

  const { data, loading, error, errorType, refetch, prevData, prevLoading } = useReportData<DdosData>({
    reportType: "ddos",
    scopeId: zoneId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    liveFetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchDdosData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`, accountId || undefined);
    },
    prevSince: `${prev.start}T00:00:00Z`,
    prevUntil: `${prev.end}T00:00:00Z`,
    prevLiveFetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchDdosData(zoneId, `${prev.start}T00:00:00Z`, `${prev.end}T00:00:00Z`, accountId || undefined);
    },
  });

  if (!zoneId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select a zone from the filter bar to view this report.</p>
      </div>
    );
  }

  const cmpLoading = compareEnabled && prevLoading;

  const formatTime = (points: Array<{ date: string; count: number }>) =>
    points.map((p) => ({
      ...p,
      date: format(new Date(p.date), "MMM d HH:mm"),
    }));

  const ddosTime = formatTime(data?.ddosEventsOverTime || []);
  const rlTime = formatTime(data?.rateLimitEventsOverTime || []);

  // Chart overlay: DDoS Events
  const ddosSeries = [{ key: "count", label: "DDoS Events", color: "#ef4444" }];
  let ddosData: Record<string, unknown>[] = ddosTime;
  let ddosSeriesFull = ddosSeries;
  if (compareEnabled && prevData) {
    const prevDdosTime = formatTime(prevData.ddosEventsOverTime || []);
    ddosData = mergeComparisonTimeSeries(ddosTime, prevDdosTime, ["count"]);
    ddosSeriesFull = [...ddosSeries, ...makeComparisonSeries(ddosSeries, ["count"])];
  }

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

      {/* L7 DDoS Section */}
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
              <StatCard label="L7 DDoS Blocked" value={formatNumber(data?.totalDdosEvents || 0)} change={compareEnabled ? pctChange(data?.totalDdosEvents || 0, prevData?.totalDdosEvents) : undefined} compareLoading={cmpLoading} />
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
              data={ddosData}
              xKey="date"
              series={ddosSeriesFull}
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

      {/* Rate Limiting Section */}
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
              <StatCard label="Rate Limit Events" value={formatNumber(data?.totalRateLimitEvents || 0)} change={compareEnabled ? pctChange(data?.totalRateLimitEvents || 0, prevData?.totalRateLimitEvents) : undefined} compareLoading={cmpLoading} />
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

      {/* L3/L4 DDoS Section */}
      {!loading && data?.l34 && data.l34.attacks.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-white">L3/L4 DDoS Attacks</h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Network Attacks" value={data.l34.totalAttacks} />
            <StatCard label="Packets Dropped" value={formatNumber(data.l34.totalPacketsDropped)} />
            <StatCard label="Data Dropped" value={formatBytes(data.l34.totalBitsDropped / 8)} />
          </div>

          <ChartWrapper title="L3/L4 Attack Log" subtitle="Network-layer DDoS attacks detected and mitigated" loading={false}>
            <DataTable
              columns={[
                { key: "start", label: "Start", render: (v) => format(new Date(v as string), "MMM d HH:mm") },
                { key: "attackVector", label: "Vector" },
                { key: "ipProtocol", label: "Protocol", width: "80px" },
                { key: "destinationPort", label: "Port", align: "right", width: "80px" },
                { key: "mitigationType", label: "Mitigation" },
                { key: "droppedPackets", label: "Dropped Pkts", align: "right", render: (v) => formatNumber(v as number) },
              ]}
              data={data.l34.attacks}
              maxRows={15}
            />
          </ChartWrapper>
        </section>
      )}

      {!loading && data && !data.l34 && (
        <div className="flex items-start gap-2 rounded-md border border-zinc-700 bg-zinc-900/50 px-3 py-2">
          <Info size={16} className="mt-0.5 shrink-0 text-zinc-400" />
          <p className="text-xs text-zinc-400">
            L3/L4 DDoS attack data requires Advanced DDoS Protection or Magic Transit. Only L7 (HTTP) DDoS mitigation data is shown above.
          </p>
        </div>
      )}
    </div>
  );
}
