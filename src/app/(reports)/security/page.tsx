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

  const { data, loading, error, errorType, refetch } = useCfData<SecurityData>({
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

  // S1: Merge traffic volume into WAF time series for correlation
  const trafficByHour = new Map<string, number>();
  for (const t of data?.trafficTimeSeries || []) {
    trafficByHour.set(t.date, t.requests);
  }
  const wafTimeSeriesFormatted = (data?.wafTimeSeries || []).map((p) => ({
    ...p,
    requests: trafficByHour.get(p.date) || 0,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  const totalWAFEvents = (data?.wafTimeSeries || []).reduce(
    (sum, p) => sum + p.block + p.challenge + p.managed_challenge + p.js_challenge + p.challenge_solved + p.log,
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
            <StatCard
              label="Skip Rule Hits"
              value={formatNumber((data?.topSkipRules || []).reduce((sum, r) => sum + r.count, 0))}
            />
          </>
        )}
      </div>

      {/* S1: WAF Events + Traffic Correlation */}
      <ChartWrapper title="WAF Events Over Time" subtitle="By action type, with traffic overlay" loading={loading}>
        <TimeSeriesChart
          data={wafTimeSeriesFormatted}
          xKey="date"
          series={[
            { key: "block", label: "Block", color: ACTION_COLORS.block },
            { key: "managed_challenge", label: "Managed Challenge", color: ACTION_COLORS.managed_challenge },
            { key: "challenge_solved", label: "Challenge Solved", color: ACTION_COLORS.challenge_solved },
            { key: "challenge", label: "Challenge", color: ACTION_COLORS.challenge },
            { key: "js_challenge", label: "JS Challenge", color: ACTION_COLORS.js_challenge },
            { key: "log", label: "Log", color: ACTION_COLORS.log },
            { key: "requests", label: "Total Requests", color: "#6b7280", yAxisId: "right" },
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

      {/* S5: Attack Classification */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Attack Categories" subtitle="Blocked requests classified by type" loading={loading}>
          <HorizontalBarChart
            data={(data?.attackCategories || []).slice(0, 10).map((c) => ({
              name: c.category,
              value: c.count,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Blocked Request Methods" subtitle="HTTP methods of blocked requests" loading={loading}>
          <DonutChart
            data={(data?.httpMethodBreakdown || []).map((m) => ({
              name: m.method,
              value: m.count,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* S2: Rule Effectiveness */}
      <ChartWrapper title="Rule Effectiveness" subtitle="Top rules by hit count with block rate analysis" loading={loading}>
        <DataTable
          columns={[
            {
              key: "ruleName",
              label: "Rule",
              render: (_v, row) => {
                const r = row as { ruleName: string | null; description: string };
                const displayName = r.ruleName || r.description;
                return <>{displayName && displayName !== "No description" ? displayName : "–"}</>;
              },
            },
            { key: "totalHits", label: "Total Hits", align: "right", render: (v) => formatNumber(v as number) },
            { key: "blocks", label: "Blocks", align: "right", render: (v) => formatNumber(v as number) },
            { key: "challenges", label: "Challenges", align: "right", render: (v) => formatNumber(v as number) },
            {
              key: "blockRate",
              label: "Block Rate",
              align: "right",
              render: (v) => {
                const rate = v as number;
                const color = rate >= 90 ? "text-emerald-400" : rate >= 50 ? "text-yellow-400" : "text-red-400";
                return <span className={color}>{rate.toFixed(1)}%</span>;
              },
            },
          ]}
          data={data?.ruleEffectiveness || []}
          maxRows={15}
        />
      </ChartWrapper>

      {/* Firewall Rules: Block/Challenge vs Skip */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Top Block / Challenge Rules" loading={loading}>
          <DataTable
            columns={[
              {
                key: "ruleName",
                label: "Rule",
                render: (_v, row) => {
                  const r = row as { ruleName: string | null; description: string };
                  const displayName = r.ruleName || r.description;
                  return <>{displayName && displayName !== "No description" ? displayName : "–"}</>;
                },
              },
              {
                key: "action",
                label: "Action",
                render: (v) => {
                  const action = v as string;
                  const color = ACTION_COLORS[action] || "#6b7280";
                  return <span style={{ color }}>{action.replace(/_/g, " ")}</span>;
                },
              },
              { key: "count", label: "Hits", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topFirewallRules || []}
            maxRows={15}
          />
        </ChartWrapper>

        <ChartWrapper title="Top Skip Rules" loading={loading}>
          <DataTable
            columns={[
              {
                key: "ruleName",
                label: "Rule",
                render: (_v, row) => {
                  const r = row as { ruleName: string | null; description: string };
                  const displayName = r.ruleName || r.description;
                  return <>{displayName && displayName !== "No description" ? displayName : "–"}</>;
                },
              },
              { key: "ruleId", label: "Rule ID" },
              { key: "count", label: "Hits", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.topSkipRules || []}
            maxRows={15}
          />
        </ChartWrapper>
      </div>

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
