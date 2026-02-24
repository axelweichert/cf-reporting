"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchZtSummaryData, type ZtSummaryData } from "@/lib/queries/zt-summary";
import ChartWrapper from "@/components/charts/chart-wrapper";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";

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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <StatCard label="Total DNS Queries" value={formatNumber(data?.totalDnsQueries || 0)} />
            <StatCard label="Blocked by Policy" value={formatNumber(data?.blockedByPolicy.reduce((s, b) => s + b.value, 0) || 0)} />
            <StatCard label="Access Logins" value={formatNumber(data?.accessLogins.total || 0)} />
            <StatCard label="Login Success Rate" value={data?.accessLogins.total ? `${((data.accessLogins.successful / data.accessLogins.total) * 100).toFixed(1)}%` : "N/A"} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Blocked Requests by Policy" loading={loading}>
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
