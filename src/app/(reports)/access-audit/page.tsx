"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useReportData } from "@/lib/use-report-data";
import { fetchAccessAuditData, type AccessAuditData } from "@/lib/queries/access-audit";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber, formatPercent } from "@/components/charts/theme";
import { format } from "date-fns";
import { AlertTriangle, AlertCircle, Info } from "lucide-react";

export default function AccessAuditPage() {
  const { capabilities } = useAuth();
  const { selectedAccount, timeRange, customStart, customEnd } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useReportData<AccessAuditData>({
    reportType: "access-audit",
    scopeId: accountId,
    since: `${start}T00:00:00Z`,
    until: `${end}T00:00:00Z`,
    liveFetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchAccessAuditData(accountId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
    },
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

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {!loading && !error && data && totalLogins === 0 && (
        <ErrorMessage
          type={capabilities?.permissions.includes("access") ? "empty" : "permission"}
          message={capabilities?.permissions.includes("access")
            ? "No Access login events found for this time period. This may mean no login attempts occurred, or Access hasn't been configured yet."
            : "Your API token doesn't have Access permissions. Add the 'Access: Apps and Policies' permission to see this report."}
        />
      )}

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

      {/* Anomaly Alerts (A2) */}
      {!loading && (data?.anomalies || []).length > 0 && (
        <div className="space-y-2">
          {data!.anomalies.map((a, i) => {
            const styles = {
              critical: { border: "border-red-500/30", bg: "bg-red-500/5", text: "text-red-300", icon: <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" /> },
              warning: { border: "border-yellow-500/30", bg: "bg-yellow-500/5", text: "text-yellow-300", icon: <AlertCircle size={16} className="mt-0.5 shrink-0 text-yellow-400" /> },
              info: { border: "border-blue-500/20", bg: "bg-blue-500/5", text: "text-blue-300", icon: <Info size={16} className="mt-0.5 shrink-0 text-blue-400" /> },
            }[a.severity];
            return (
              <div key={i} className={`flex items-start gap-2 rounded-md border ${styles.border} ${styles.bg} px-3 py-2`}>
                {styles.icon}
                <div>
                  <p className={`text-xs font-medium ${styles.text}`}>{a.title}</p>
                  <p className="text-xs text-zinc-400">{a.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per-App Success/Failure Breakdown (A3) */}
      <ChartWrapper title="Access by Application" subtitle="Success and failure rates per application" loading={loading}>
        <DataTable
          columns={[
            {
              key: "appName",
              label: "Application",
              render: (_v, row) => {
                const r = row as { appId: string; appName: string | null };
                return <>{r.appName || r.appId}</>;
              },
            },
            { key: "successful", label: "Successful", align: "right", render: (v) => formatNumber(v as number) },
            { key: "failed", label: "Failed", align: "right", render: (v) => {
              const n = v as number;
              return <span className={n > 0 ? "text-red-400" : "text-zinc-600"}>{formatNumber(n)}</span>;
            }},
            { key: "total", label: "Total", align: "right", render: (v) => formatNumber(v as number) },
            { key: "failureRate", label: "Failure Rate", align: "right", render: (v) => {
              const rate = v as number;
              const color = rate > 50 ? "text-red-400" : rate > 20 ? "text-yellow-400" : "text-zinc-400";
              return <span className={color}>{formatPercent(rate)}</span>;
            }},
          ]}
          data={data?.appBreakdown || []}
          maxRows={15}
        />
      </ChartWrapper>

      {/* Failed Login Investigation */}
      {(data?.failedLoginCount || 0) > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-white">Failed Login Investigation</h2>
          <p className="text-sm text-zinc-400">
            {formatNumber(data?.failedLoginCount || 0)} failed login attempts detected in this period.
          </p>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartWrapper title="Failed Logins by Application" loading={loading}>
              <DataTable
                columns={[
                  {
                    key: "appName",
                    label: "Application",
                    render: (_v, row) => {
                      const r = row as { appId: string; appName: string | null };
                      return <>{r.appName || r.appId}</>;
                    },
                  },
                  { key: "count", label: "Failures", align: "right" as const, render: (v) => formatNumber(v as number) },
                ]}
                data={data?.failedByApp || []}
                maxRows={10}
              />
            </ChartWrapper>

            <ChartWrapper title="Failed Logins by Country" loading={loading}>
              <DataTable
                columns={[
                  { key: "country", label: "Country" },
                  { key: "count", label: "Failures", align: "right" as const, render: (v) => formatNumber(v as number) },
                ]}
                data={data?.failedByCountry || []}
                maxRows={10}
              />
            </ChartWrapper>
          </div>

          <ChartWrapper title="Failed Login Details" subtitle="By application, country, and identity provider" loading={loading}>
            <DataTable
              columns={[
                {
                  key: "appName",
                  label: "Application",
                  render: (_v, row) => {
                    const r = row as { appId: string; appName: string | null };
                    return <>{r.appName || r.appId}</>;
                  },
                },
                { key: "country", label: "Country" },
                { key: "identityProvider", label: "Identity Provider" },
                { key: "count", label: "Failures", align: "right" as const, render: (v) => formatNumber(v as number) },
              ]}
              data={data?.failedLoginDetails || []}
              maxRows={15}
            />
          </ChartWrapper>
        </section>
      )}
    </div>
  );
}
