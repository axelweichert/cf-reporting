"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchSecurityData, type SecurityData } from "@/lib/queries/security";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, ACTION_COLORS } from "@/components/charts/theme";
import { format } from "date-fns";

export default function SecurityPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];
  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<SecurityData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchSecurityData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const wafTimeSeriesFormatted = (data?.wafTimeSeries || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const totalWAFEvents = (data?.wafTimeSeries || []).reduce(
    (sum, p) => sum + p.block + p.challenge + p.managed_challenge + p.js_challenge + p.log,
    0
  );
  const totalBlocks = (data?.wafTimeSeries || []).reduce((sum, p) => sum + p.block, 0);

  const sourceData = (data?.sourceBreakdown || []).map((s, i) => ({
    ...s,
    color: i === 0 ? "#3b82f6" : "#f97316",
  }));

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Security Posture</h1>
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
        ) : (
          <>
            <StatCard label="Total WAF Events" value={formatNumber(totalWAFEvents)} />
            <StatCard label="Blocked Requests" value={formatNumber(totalBlocks)} />
            <StatCard
              label="Challenge Solve Rate"
              value={
                data?.challengeSolveRates.challenged
                  ? `${((data.challengeSolveRates.solved / data.challengeSolveRates.challenged) * 100).toFixed(1)}%`
                  : "N/A"
              }
            />
            <StatCard label="Top Firewall Rules" value={data?.topFirewallRules.length || 0} />
          </>
        )}
      </div>

      {/* WAF Events Over Time */}
      <ChartWrapper title="WAF Events Over Time" subtitle="By action type" loading={loading}>
        <TimeSeriesChart
          data={wafTimeSeriesFormatted}
          xKey="date"
          series={[
            { key: "block", label: "Block", color: ACTION_COLORS.block },
            { key: "managed_challenge", label: "Managed Challenge", color: ACTION_COLORS.managed_challenge },
            { key: "challenge", label: "Challenge", color: ACTION_COLORS.challenge },
            { key: "js_challenge", label: "JS Challenge", color: ACTION_COLORS.js_challenge },
            { key: "log", label: "Log", color: ACTION_COLORS.log },
          ]}
          stacked
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      {/* Two columns: Source Breakdown + Bot Scores */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Managed vs Custom Rules" loading={loading}>
          <DonutChart data={sourceData} valueFormatter={formatNumber} />
        </ChartWrapper>

        <ChartWrapper title="Bot Score Distribution" subtitle="From all HTTP requests" loading={loading}>
          <HorizontalBarChart
            data={(data?.botScoreDistribution || []).map((b) => ({
              name: b.range,
              value: b.count,
              color: parseInt(b.range) < 30 ? "#ef4444" : parseInt(b.range) < 70 ? "#eab308" : "#10b981",
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* Top Firewall Rules */}
      <ChartWrapper title="Top Firewall Rules" subtitle="By hit count" loading={loading}>
        <DataTable
          columns={[
            { key: "ruleId", label: "Rule ID", width: "200px" },
            { key: "description", label: "Description" },
            { key: "count", label: "Hits", align: "right", render: (v) => formatNumber(v as number) },
          ]}
          data={data?.topFirewallRules || []}
          maxRows={15}
        />
      </ChartWrapper>

      {/* Three columns: Top IPs, Countries, ASNs */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartWrapper title="Top Attacking IPs" loading={loading}>
          <DataTable
            columns={[
              { key: "ip", label: "IP Address" },
              { key: "count", label: "Events", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topAttackingIPs || []}
            maxRows={10}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Attacking Countries" loading={loading}>
          <DataTable
            columns={[
              { key: "country", label: "Country" },
              { key: "count", label: "Events", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topAttackingCountries || []}
            maxRows={10}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Attacking ASNs" loading={loading}>
          <DataTable
            columns={[
              { key: "description", label: "ASN" },
              { key: "count", label: "Events", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topAttackingASNs || []}
            maxRows={10}
          />
        </ChartWrapper>
      </div>
    </div>
  );
}
