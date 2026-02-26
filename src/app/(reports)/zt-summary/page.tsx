"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchZtSummaryData, type ZtSummaryData } from "@/lib/queries/zt-summary";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { Monitor, Users, ShieldCheck, Laptop, AppWindow, Info } from "lucide-react";
import { format } from "date-fns";

export default function ZtSummaryPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<ZtSummaryData>({
    fetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchZtSummaryData(accountId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
    deps: [accountId, start, end],
  });

  if (!accountId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select an account from the filter bar to view this report.</p>
      </div>
    );
  }

  const fleet = data?.fleet;
  const plan = data?.plan;
  const blockRate = data?.totalDnsQueries
    ? ((data.blockedDnsQueries / data.totalDnsQueries) * 100).toFixed(1) + "%"
    : "N/A";
  const loginSuccessRate = data?.accessLogins.total
    ? ((data.accessLogins.successful / data.accessLogins.total) * 100).toFixed(1) + "%"
    : "N/A";

  // Detect if only blocked queries are logged (100% block rate with a single decision type)
  const onlyBlockedLogged = data && data.totalDnsQueries > 0
    && data.blockedDnsQueries === data.totalDnsQueries
    && data.resolverDecisions.length === 1;

  const seatUsage = (fleet?.accessSeats || 0) > (fleet?.gatewaySeats || 0)
    ? fleet?.accessSeats || 0
    : fleet?.gatewaySeats || 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Zero Trust Executive Summary</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {!loading && !error && data && data.totalDnsQueries === 0 && data.accessLogins.total === 0 && (
        <ErrorMessage
          type={capabilities?.permissions.includes("zero_trust") ? "empty" : "permission"}
          message={capabilities?.permissions.includes("zero_trust")
            ? "No Zero Trust activity found for this time period. This may mean no Gateway or Access events occurred, or the services haven't been configured yet."
            : "Your API token doesn't have Zero Trust permissions. Add the Zero Trust permission to see this report."}
        />
      )}

      {/* Plan info */}
      {!loading && plan && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-400">Cloudflare One Plan</p>
              <p className="text-lg font-semibold text-white">{plan.planName}</p>
              {plan.features.length > 0 && (
                <p className="mt-1 text-xs text-zinc-500">
                  Includes: {plan.features.join(", ")}
                </p>
              )}
            </div>
            {plan.seatLimit > 0 && (
              <div className="text-right">
                <p className="text-sm text-zinc-400">Seat Usage</p>
                <p className="text-lg font-semibold text-white">
                  {seatUsage} <span className="text-sm font-normal text-zinc-500">/ {plan.seatLimit}</span>
                </p>
                <div className="mt-1 h-2 w-32 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${Math.min(100, (seatUsage / plan.seatLimit) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Gateway DNS stats */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Gateway DNS</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {loading ? (
            <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
          ) : (
            <>
              <StatCard label="Total DNS Queries" value={formatNumber(data?.totalDnsQueries || 0)} />
              <StatCard label="Blocked Queries" value={formatNumber(data?.blockedDnsQueries || 0)} />
              <StatCard label="Block Rate" value={blockRate} />
              <StatCard label="Access Logins" value={formatNumber(data?.accessLogins.total || 0)} />
            </>
          )}
        </div>
        {onlyBlockedLogged && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
            <Info size={16} className="mt-0.5 shrink-0 text-blue-400" />
            <p className="text-xs text-blue-300">
              Only blocked queries appear in the analytics. Your Gateway activity logging may be set to &quot;Capture only blocked&quot;.
              To see all DNS queries, change the setting under{" "}
              <span className="font-medium">Traffic policies &gt; Traffic settings &gt; Traffic logging &gt; Log traffic activity</span> to &quot;Capture all&quot;.
            </p>
          </div>
        )}
      </div>

      {/* Access stats */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Access & Identity</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {loading ? (
            <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
          ) : (
            <>
              <StatCard label="Login Success Rate" value={loginSuccessRate} />
              <StatCard label="Failed Logins" value={formatNumber((data?.accessLogins.total || 0) - (data?.accessLogins.successful || 0))} />
              <StatCard label="Access Apps" value={formatNumber(fleet?.accessApps || 0)} icon={<AppWindow size={18} />} />
              <StatCard label="Access Seats" value={formatNumber(fleet?.accessSeats || 0)} icon={<ShieldCheck size={18} />} />
            </>
          )}
        </div>
      </div>

      {/* Fleet stats */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Fleet & Devices</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {loading ? (
            <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
          ) : (
            <>
              <StatCard label="Total Devices" value={formatNumber(fleet?.totalDevices || 0)} icon={<Monitor size={18} />} />
              <StatCard label="Active (24h)" value={formatNumber(fleet?.activeDevices || 0)} icon={<Monitor size={18} />} />
              <StatCard label="Total Users" value={formatNumber(fleet?.totalUsers || 0)} icon={<Users size={18} />} />
              <StatCard label="Gateway Seats" value={formatNumber(fleet?.gatewaySeats || 0)} icon={<Laptop size={18} />} />
              <StatCard label="Access Seats" value={formatNumber(fleet?.accessSeats || 0)} icon={<ShieldCheck size={18} />} />
            </>
          )}
        </div>
      </div>

      {/* ZT1: Daily Active Users Trend */}
      {(data?.dailyActiveUsers || []).length > 0 && (
        <ChartWrapper title="Daily Active Users" subtitle="Unique users with successful logins per day" loading={loading}>
          <TimeSeriesChart
            data={(data?.dailyActiveUsers || []).map((p) => ({
              ...p,
              date: format(new Date(p.date), "MMM d"),
            }))}
            xKey="date"
            series={[
              { key: "uniqueUsers", label: "Unique Users", color: "#3b82f6" },
              { key: "logins", label: "Total Logins", color: "#6b7280", yAxisId: "right" },
            ]}
            yFormatter={formatNumber}
          />
        </ChartWrapper>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartWrapper title="Resolver Decisions" loading={loading}>
          <DonutChart
            data={(data?.resolverDecisions || []).map((d) => ({ name: d.decision, value: d.count }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Blocked by Policy" loading={loading}>
          <HorizontalBarChart
            data={(data?.blockedByPolicy || []).map((b) => ({ name: b.name || "Unknown", value: b.value }))}
            valueFormatter={formatNumber}
            barColor="#ef4444"
          />
        </ChartWrapper>

        <ChartWrapper title="Top Blocked Categories" loading={loading}>
          <DonutChart
            data={(data?.topBlockedCategories || []).map((c) => ({ name: c.name || `Category ${c.name}`, value: c.value }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>
    </div>
  );
}
