"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchBotData, type BotData } from "@/lib/queries/bots";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatPercent } from "@/components/charts/theme";
import { format } from "date-fns";

export default function BotsPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<BotData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchBotData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const automatedTrafficFormatted = (data?.automatedTrafficOverTime || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const totalAutomated = (data?.automatedTrafficOverTime || []).reduce((sum, p) => sum + p.automated, 0);
  const totalAll = (data?.automatedTrafficOverTime || []).reduce((sum, p) => sum + p.total, 0);
  const automatedPct = totalAll > 0 ? (totalAutomated / totalAll) * 100 : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Bot Analysis</h1>
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
          </>
        ) : (
          <>
            <StatCard label="Automated Traffic" value={formatPercent(automatedPct)} />
            <StatCard label="Automated Requests" value={formatNumber(totalAutomated)} />
            <StatCard label="Verified Bot Categories" value={data?.verifiedBotCategories.length || 0} />
          </>
        )}
      </div>

      {/* Bot Score Distribution */}
      <ChartWrapper title="Bot Score Distribution" subtitle="0-29 = automated, 30-69 = likely bot, 70-100 = likely human" loading={loading}>
        <HorizontalBarChart
          data={(data?.botScoreDistribution || []).map((b) => ({
            name: b.range,
            value: b.count,
            color: parseInt(b.range) < 30 ? "#ef4444" : parseInt(b.range) < 70 ? "#eab308" : "#10b981",
          }))}
          valueFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* Two columns: Bot Decisions + Automated Traffic Trend */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Bot Management Decisions" loading={loading}>
          <DonutChart
            data={(data?.botManagementDecisions || []).map((d) => ({
              name: d.name || "Unknown",
              value: d.value,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Automated Traffic Over Time" subtitle="Bot score < 30" loading={loading}>
          <TimeSeriesChart
            data={automatedTrafficFormatted}
            xKey="date"
            series={[
              { key: "automated", label: "Automated", color: "#ef4444" },
              { key: "total", label: "Total", color: "#3b82f6" },
            ]}
            yFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* Verified Bot Categories */}
      <ChartWrapper title="Verified Bot Categories" loading={loading}>
        <HorizontalBarChart
          data={(data?.verifiedBotCategories || []).map((c) => ({
            name: c.category || "Unknown",
            value: c.count,
          }))}
          valueFormatter={formatNumber}
          barColor="#10b981"
        />
      </ChartWrapper>

      {/* Two columns: Top Bot UAs + Bot Paths */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Top Bot User Agents" subtitle="Bot score < 30" loading={loading}>
          <DataTable
            columns={[
              { key: "userAgent", label: "User Agent" },
              { key: "count", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topBotUserAgents || []}
            maxRows={15}
          />
        </ChartWrapper>

        <ChartWrapper title="Bot Requests by Path" subtitle="Bot score < 30" loading={loading}>
          <DataTable
            columns={[
              { key: "path", label: "Path" },
              { key: "count", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.botRequestsByPath || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>
    </div>
  );
}
