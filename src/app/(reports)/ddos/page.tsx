"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchDdosData, type DdosData, type RateLimitRule } from "@/lib/queries/ddos";
import { pctChange, formatTimeSeries, buildComparisonChart } from "@/lib/compare-utils";
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

  const { data, loading, error, errorType, refetch, prevData, cmpLoading } = useReportData<DdosData>({
    reportType: "ddos",
    scopeId: zoneId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    fetcher: (s, u) => {
      if (!zoneId) throw new Error("No zone available");
      return fetchDdosData(zoneId, s, u, accountId || undefined);
    },
  });

  if (!zoneId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select a zone from the filter bar to view this report.</p>
      </div>
    );
  }

  const ddosTime = formatTimeSeries(data?.ddosEventsOverTime || []);
  const rlTime = formatTimeSeries(data?.rateLimitEventsOverTime || []);

  // Chart overlay: DDoS Events
  const ddosSeries = [{ key: "count", label: "DDoS Events", color: "#ef4444" }];
  const { data: ddosData, series: ddosSeriesFull } = buildComparisonChart({
    current: ddosTime,
    previous: prevData ? formatTimeSeries(prevData.ddosEventsOverTime || []) : undefined,
    series: ddosSeries,
    valueKeys: ["count"],
    compareEnabled,
  });

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

        {!loading && (data?.rateLimitRules || []).length > 0 && (
          <ChartWrapper title="Rate Limiting Rules" subtitle={`${data!.rateLimitRules.length} rule${data!.rateLimitRules.length !== 1 ? "s" : ""} configured`} loading={false}>
            <DataTable
              columns={[
                {
                  key: "description",
                  label: "Rule",
                },
                {
                  key: "action",
                  label: "Action",
                  width: "100px",
                  render: (v) => {
                    const action = v as string;
                    const colors: Record<string, string> = {
                      block: "bg-red-500/10 text-red-400 border-red-500/20",
                      challenge: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
                      managed_challenge: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
                      js_challenge: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
                      log: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
                    };
                    return (
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${colors[action] || colors.log}`}>
                        {action.replace(/_/g, " ")}
                      </span>
                    );
                  },
                },
                {
                  key: "triggers",
                  label: "Triggers",
                  align: "right",
                  width: "100px",
                  render: (v) => {
                    const count = v as number;
                    return count > 0
                      ? <span className="font-medium text-orange-400">{formatNumber(count)}</span>
                      : <span className="text-zinc-600">0</span>;
                  },
                },
                {
                  key: "threshold",
                  label: "Threshold",
                  align: "right",
                  width: "120px",
                  render: (v, row) => {
                    const rule = row as RateLimitRule;
                    return `${formatNumber(rule.threshold)} / ${rule.period}s`;
                  },
                },
                {
                  key: "mitigationTimeout",
                  label: "Timeout",
                  align: "right",
                  width: "90px",
                  render: (v) => {
                    const secs = v as number;
                    if (secs >= 3600) return `${Math.round(secs / 3600)}h`;
                    if (secs >= 60) return `${Math.round(secs / 60)}m`;
                    return `${secs}s`;
                  },
                },
                {
                  key: "enabled",
                  label: "Status",
                  align: "center",
                  width: "80px",
                  render: (v) => (
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${v ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-zinc-500/10 text-zinc-500 border-zinc-500/20"}`}>
                      {v ? "Active" : "Off"}
                    </span>
                  ),
                },
              ]}
              data={data!.rateLimitRules}
            />
          </ChartWrapper>
        )}
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
