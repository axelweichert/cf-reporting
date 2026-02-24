"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchAccessAuditData, type AccessAuditData } from "@/lib/queries/access-audit";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { format } from "date-fns";

export default function AccessAuditPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, refetch } = useCfData<AccessAuditData>({
    fetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchAccessAuditData(accountId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const loginsFormatted = (data?.loginsOverTime || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d"),
  }));

  const totalLogins = (data?.loginsOverTime || []).reduce((s, p) => s + p.successful + p.failed, 0);
  const totalSuccessful = (data?.loginsOverTime || []).reduce((s, p) => s + p.successful, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Access Audit</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type="generic" message={error} onRetry={refetch} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></> : (
          <>
            <StatCard label="Total Logins" value={formatNumber(totalLogins)} />
            <StatCard label="Successful" value={formatNumber(totalSuccessful)} />
            <StatCard label="Failed" value={formatNumber(data?.failedLoginCount || 0)} />
            <StatCard label="Success Rate" value={totalLogins ? `${((totalSuccessful / totalLogins) * 100).toFixed(1)}%` : "N/A"} />
          </>
        )}
      </div>

      <ChartWrapper title="Login Events Over Time" subtitle="Successful vs Failed" loading={loading}>
        <TimeSeriesChart
          data={loginsFormatted}
          xKey="date"
          series={[
            { key: "successful", label: "Successful", color: "#10b981" },
            { key: "failed", label: "Failed", color: "#ef4444" },
          ]}
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="Identity Providers" loading={loading}>
          <DonutChart
            data={(data?.identityProviders || []).map((p) => ({
              name: p.provider || "Unknown",
              value: p.count,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="Geographic Access" subtitle="Top countries" loading={loading}>
          <DataTable
            columns={[
              { key: "country", label: "Country" },
              { key: "count", label: "Logins", align: "right", render: (v) => formatNumber(v as number) },
            ]}
            data={data?.geographicAccess || []}
            maxRows={15}
          />
        </ChartWrapper>
      </div>

      <ChartWrapper title="Access by Application" loading={loading}>
        <DataTable
          columns={[
            {
              key: "appName",
              label: "Application",
              render: (_v, row) => {
                const r = row as { appId: string; appName: string | null };
                return <>{r.appName || "–"}</>;
              },
            },
            { key: "appId", label: "Application ID" },
            { key: "count", label: "Access Events", align: "right", render: (v) => formatNumber(v as number) },
          ]}
          data={data?.accessByApplication || []}
          maxRows={15}
        />
      </ChartWrapper>
    </div>
  );
}
