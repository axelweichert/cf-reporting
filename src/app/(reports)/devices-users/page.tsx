"use client";

import { useFilterStore } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchDevicesUsersData, type DevicesUsersData } from "@/lib/queries/devices-users";
import ChartWrapper from "@/components/charts/chart-wrapper";
import DonutChart from "@/components/charts/donut-chart";
import { HorizontalBarChart } from "@/components/charts/bar-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { Monitor, Users, ShieldCheck, Wifi, Laptop, AlertTriangle, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

function RelativeTime({ date }: { date: string }) {
  const text = (() => {
    try {
      return formatDistanceToNow(new Date(date), { addSuffix: true });
    } catch {
      return "Unknown";
    }
  })();
  return <>{text}</>;
}

function StatusBadge({ status }: { status: "active" | "inactive" | "stale" }) {
  const styles = {
    active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    inactive: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    stale: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function SeatBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
      Yes
    </span>
  ) : (
    <span className="text-xs text-zinc-600">No</span>
  );
}

export default function DevicesUsersPage() {
  const { capabilities } = useAuth();
  const { selectedAccount } = useFilterStore();
  const accounts = capabilities?.accounts || [];
  const accountId = accounts.length === 1 ? accounts[0].id : selectedAccount;
  const accountName = accounts.find((a) => a.id === accountId)?.name || "Unknown";

  const { data, loading, error, errorType, refetch } = useCfData<DevicesUsersData>({
    fetcher: () => {
      if (!accountId) throw new Error("No account available");
      return fetchDevicesUsersData(accountId);
    },
    deps: [accountId],
  });

  if (!accountId) {
    return (
      <div className="mx-auto max-w-7xl py-12 text-center">
        <p className="text-zinc-400">Please select an account from the filter bar to view this report.</p>
      </div>
    );
  }

  const stats = data?.stats;
  const plan = data?.plan;
  const seatUsage = Math.max(stats?.accessSeats || 0, stats?.gatewaySeats || 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Devices & Users</h1>
        <p className="mt-1 text-sm text-zinc-400">{accountName} – WARP fleet & Access/Gateway seats</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      {!loading && !error && data && stats?.totalDevices === 0 && stats?.totalUsers === 0 && (
        <ErrorMessage
          type={capabilities?.permissions.includes("zero_trust") ? "empty" : "permission"}
          message={capabilities?.permissions.includes("zero_trust")
            ? "No devices or users found. This may mean WARP hasn't been deployed or Access users haven't been configured yet."
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

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {loading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <StatCard label="Total Devices" value={formatNumber(stats?.totalDevices || 0)} icon={<Monitor size={18} />} />
            <StatCard label="Active (24h)" value={formatNumber(stats?.activeDevices || 0)} icon={<Wifi size={18} />} />
            <StatCard label="Inactive (1-30d)" value={formatNumber(stats?.inactiveDevices || 0)} icon={<Clock size={18} />} />
            <StatCard label="Stale (>30d)" value={formatNumber(stats?.staleDevices || 0)} icon={<AlertTriangle size={18} />} />
            <StatCard label="Total Users" value={formatNumber(stats?.totalUsers || 0)} icon={<Users size={18} />} />
            <StatCard label="Access Seats" value={formatNumber(stats?.accessSeats || 0)} icon={<ShieldCheck size={18} />} />
            <StatCard label="Gateway Seats" value={formatNumber(stats?.gatewaySeats || 0)} icon={<Laptop size={18} />} />
          </>
        )}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="OS Distribution" loading={loading}>
          <DonutChart
            data={data?.osDistribution || []}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="WARP Client Versions" subtitle="Top 15" loading={loading}>
          <HorizontalBarChart
            data={data?.warpVersionDistribution || []}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      {/* Device Inventory */}
      <ChartWrapper title="Device Inventory" subtitle={`${stats?.totalDevices || 0} devices`} loading={loading}>
        <DataTable
          columns={[
            { key: "name", label: "Device Name" },
            { key: "user", label: "User" },
            { key: "os", label: "OS" },
            { key: "warpVersion", label: "WARP Version" },
            {
              key: "lastSeen",
              label: "Last Seen",
              render: (v) => <RelativeTime date={v as string} />,
            },
            {
              key: "status",
              label: "Status",
              align: "center",
              render: (v) => <StatusBadge status={v as "active" | "inactive" | "stale"} />,
            },
          ]}
          data={data?.devices || []}
          maxRows={15}
        />
      </ChartWrapper>

      {/* Users */}
      <ChartWrapper title="Users" subtitle={`${stats?.totalUsers || 0} users`} loading={loading}>
        <DataTable
          columns={[
            { key: "name", label: "Name" },
            { key: "email", label: "Email" },
            {
              key: "accessSeat",
              label: "Access Seat",
              align: "center",
              render: (v) => <SeatBadge active={v as boolean} />,
            },
            {
              key: "gatewaySeat",
              label: "Gateway Seat",
              align: "center",
              render: (v) => <SeatBadge active={v as boolean} />,
            },
            {
              key: "deviceCount",
              label: "Devices",
              align: "right",
              render: (v) => formatNumber(v as number),
            },
            {
              key: "lastLogin",
              label: "Last Login",
              render: (v) => v ? <RelativeTime date={v as string} /> : <span className="text-zinc-600">N/A</span>,
            },
          ]}
          data={data?.users || []}
          maxRows={15}
        />
      </ChartWrapper>

      {/* Posture Rules */}
      <ChartWrapper
        title="Device Posture Rules"
        subtitle={`${(data?.postureRules || []).length} rules`}
        loading={loading}
        error={data?.postureError || undefined}
        errorType={data?.postureError ? "permission" : undefined}
      >
        <DataTable
          columns={[
            { key: "name", label: "Rule Name" },
            { key: "type", label: "Type" },
            { key: "platform", label: "Platform" },
            { key: "input", label: "Requirement" },
            {
              key: "deviceScope",
              label: "Devices in Scope",
              align: "right",
              render: (v) => formatNumber(v as number),
            },
          ]}
          data={data?.postureRules || []}
          maxRows={15}
        />
      </ChartWrapper>
    </div>
  );
}
