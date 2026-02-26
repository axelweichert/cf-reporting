"use client";

import { useFilterStore, getDateRange } from "@/lib/store";
import { useAuth } from "@/lib/store";
import { useCfData } from "@/lib/use-cf-data";
import { fetchSslData, type SslData } from "@/lib/queries/ssl";
import ChartWrapper from "@/components/charts/chart-wrapper";
import TimeSeriesChart from "@/components/charts/time-series-chart";
import DonutChart from "@/components/charts/donut-chart";
import DataTable from "@/components/charts/data-table";
import StatCard from "@/components/ui/stat-card";
import { CardSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";
import { formatNumber } from "@/components/charts/theme";
import { ShieldCheck, ShieldAlert, CheckCircle, XCircle } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

function SettingBadge({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
      {enabled ? (
        <CheckCircle size={16} className="text-emerald-400" />
      ) : (
        <XCircle size={16} className="text-zinc-500" />
      )}
      <span className={`text-sm ${enabled ? "text-zinc-200" : "text-zinc-500"}`}>{label}</span>
    </div>
  );
}

const SSL_MODE_LABELS: Record<string, string> = {
  off: "Off (not secure)",
  flexible: "Flexible",
  full: "Full",
  strict: "Full (Strict)",
};

const TLS13_LABELS: Record<string, string> = {
  on: "Enabled",
  off: "Disabled",
  zrt: "Enabled + 0-RTT",
};

export default function SslPage() {
  const { capabilities } = useAuth();
  const { selectedZone, timeRange, customStart, customEnd } = useFilterStore();
  const zones = capabilities?.zones || [];

  const zoneId = selectedZone;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || "Unknown";
  const { start, end } = getDateRange(timeRange, customStart, customEnd);

  const { data, loading, error, errorType, refetch } = useCfData<SslData>({
    fetcher: () => {
      if (!zoneId) throw new Error("No zone available");
      return fetchSslData(zoneId, `${start}T00:00:00Z`, `${end}T00:00:00Z`);
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

  const encTsFormatted = (data?.encryptionTimeSeries || []).map((p) => ({
    ...p,
    date: format(new Date(p.date), "MMM d HH:mm"),
  }));

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">SSL / TLS</h1>
        <p className="mt-1 text-sm text-zinc-400">{zoneName} – {start} to {end}</p>
      </div>

      {error && !loading && <ErrorMessage type={errorType} message={error} onRetry={refetch} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {loading ? (
          <><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></>
        ) : (
          <>
            <StatCard label="Total Requests" value={formatNumber(data?.stats.totalRequests || 0)} />
            <StatCard label="Encrypted" value={`${data?.stats.encryptedPercent || 0}%`} icon={<ShieldCheck size={18} />} />
            <StatCard label="TLS 1.3" value={`${data?.stats.tlsv13Percent || 0}%`} />
            <StatCard label="HTTP/3" value={`${data?.stats.http3Percent || 0}%`} />
            <StatCard label="SSL Mode" value={SSL_MODE_LABELS[data?.settings.mode || ""] || data?.settings.mode || "—"} />
            <StatCard label="Certificates" value={data?.stats.certCount || 0} />
          </>
        )}
      </div>

      {/* SSL Settings */}
      {!loading && data && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">SSL/TLS Settings</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            <SettingBadge enabled={data.settings.mode === "strict"} label={`SSL: ${SSL_MODE_LABELS[data.settings.mode] || data.settings.mode}`} />
            <SettingBadge enabled={data.settings.tls13 !== "off"} label={`TLS 1.3: ${TLS13_LABELS[data.settings.tls13] || data.settings.tls13}`} />
            <SettingBadge enabled={data.settings.alwaysUseHttps} label="Always HTTPS" />
            <SettingBadge enabled={data.settings.autoHttpsRewrites} label="Auto HTTPS Rewrites" />
            <SettingBadge enabled={data.settings.http2} label="HTTP/2" />
            <SettingBadge enabled={data.settings.http3} label="HTTP/3 (QUIC)" />
            <SettingBadge enabled={data.settings.zeroRtt} label="0-RTT" />
            <SettingBadge enabled={data.settings.opportunisticEncryption} label="Opportunistic Encryption" />
            <SettingBadge
              enabled={data.settings.minTlsVersion !== "1.0"}
              label={`Min TLS: ${data.settings.minTlsVersion}`}
            />
          </div>
        </div>
      )}

      {/* Certificates */}
      {!loading && data && data.certificates.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Certificates</h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.certificates.map((cert) => (
              <div key={cert.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-white capitalize">{cert.type.replace(/_/g, " ")}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {cert.hosts.length <= 3 ? cert.hosts.join(", ") : `${cert.hosts.slice(0, 2).join(", ")} +${cert.hosts.length - 2} more`}
                    </p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    cert.status === "active"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                  }`}>
                    {cert.status}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div>
                    <span className="text-zinc-500">Authority:</span>{" "}
                    <span className="text-zinc-300">{cert.authority}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Validity:</span>{" "}
                    <span className="text-zinc-300">{cert.validityDays} days</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Algorithms:</span>{" "}
                    <span className="text-zinc-300">{cert.signatureAlgorithms.join(", ") || "—"}</span>
                  </div>
                  {cert.expiresOn && (
                    <div>
                      <span className="text-zinc-500">Expires:</span>{" "}
                      <span className="text-zinc-300">
                        {(() => {
                          try { return formatDistanceToNow(new Date(cert.expiresOn), { addSuffix: true }); }
                          catch { return cert.expiresOn; }
                        })()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts */}
      <ChartWrapper title="Encryption Over Time" subtitle="Encrypted vs total requests" loading={loading}>
        <TimeSeriesChart
          data={encTsFormatted}
          xKey="date"
          series={[
            { key: "encryptedRequests", label: "Encrypted", color: "#10b981" },
            { key: "totalRequests", label: "Total", color: "#6b7280" },
          ]}
          yFormatter={formatNumber}
        />
      </ChartWrapper>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartWrapper title="TLS Version Distribution" loading={loading}>
          <DonutChart
            data={(data?.tlsVersions || []).map((t) => ({
              name: t.version === "none" ? "Unencrypted" : t.version,
              value: t.requests,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>

        <ChartWrapper title="HTTP Protocol Distribution" loading={loading}>
          <DonutChart
            data={(data?.httpProtocols || []).map((p) => ({
              name: p.protocol,
              value: p.requests,
            }))}
            valueFormatter={formatNumber}
          />
        </ChartWrapper>
      </div>

      <ChartWrapper title="TLS + HTTP Protocol Matrix" subtitle="Connection protocol combinations" loading={loading}>
        <DataTable
          columns={[
            { key: "tlsVersion", label: "TLS Version", render: (v) => (v as string) === "none" ? "Unencrypted" : v as string },
            { key: "httpProtocol", label: "HTTP Protocol" },
            { key: "requests", label: "Requests", align: "right", render: (v) => formatNumber(v as number) },
          ]}
          data={data?.protocolMatrix || []}
          maxRows={15}
        />
      </ChartWrapper>
    </div>
  );
}
