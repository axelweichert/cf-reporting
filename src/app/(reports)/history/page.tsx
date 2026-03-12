"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/store";
import {
  History as HistoryIcon,
  Database,
  RefreshCw,
  Eye,
  X,
  Clock,
  Globe,
  Copy,
  Check,
  Inbox,
} from "lucide-react";

type ReportType =
  | "executive" | "security" | "traffic" | "performance" | "dns"
  | "origin-health" | "ssl" | "bots" | "api-shield" | "ddos"
  | "gateway-dns" | "gateway-network" | "shadow-it" | "devices-users" | "zt-summary" | "access-audit";

interface SnapshotMeta {
  id: number;
  zone_id: string;
  zone_name: string;
  report_type: ReportType;
  period_start: string;
  period_end: string;
  collected_at: string;
}

interface SnapshotDetail extends SnapshotMeta {
  data: unknown;
}

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  executive: "Executive",
  security: "Security",
  traffic: "Traffic",
  performance: "Performance",
  dns: "DNS",
  "origin-health": "Origin Health",
  ssl: "SSL / TLS",
  bots: "Bot Analysis",
  "api-shield": "API Shield",
  ddos: "DDoS",
  "gateway-dns": "Gateway DNS",
  "gateway-network": "Gateway Network",
  "shadow-it": "Shadow IT",
  "devices-users": "Devices & Users",
  "zt-summary": "ZT Summary",
  "access-audit": "Access Audit",
};

const REPORT_TYPE_COLORS: Record<ReportType, string> = {
  executive: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  security: "bg-red-500/10 text-red-400 border-red-500/20",
  traffic: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  performance: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  dns: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  "origin-health": "bg-pink-500/10 text-pink-400 border-pink-500/20",
  ssl: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  bots: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "api-shield": "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  ddos: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  "gateway-dns": "bg-teal-500/10 text-teal-400 border-teal-500/20",
  "gateway-network": "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "shadow-it": "bg-violet-500/10 text-violet-400 border-violet-500/20",
  "devices-users": "bg-sky-500/10 text-sky-400 border-sky-500/20",
  "zt-summary": "bg-lime-500/10 text-lime-400 border-lime-500/20",
  "access-audit": "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20",
};

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function HistoryPage() {
  const { capabilities } = useAuth();
  const zones = capabilities?.zones || [];

  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterZone, setFilterZone] = useState<string>("");
  const [filterReportType, setFilterReportType] = useState<string>("");

  // Detail panel
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchSnapshots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterZone) params.set("zoneId", filterZone);
      if (filterReportType) params.set("reportType", filterReportType);
      params.set("limit", "200");

      const res = await fetch(`/api/collector/snapshots?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSnapshots(data.snapshots || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snapshots");
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, [filterZone, filterReportType]);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  const openDetail = async (id: number) => {
    setDetailLoading(true);
    setSelectedSnapshot(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/collector/snapshots?id=${id}`);
      if (!res.ok) throw new Error("Failed to load snapshot");
      const data: SnapshotDetail = await res.json();
      setSelectedSnapshot(data);
    } catch {
      setSelectedSnapshot(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedSnapshot(null);
    setDetailLoading(false);
    setCopied(false);
  };

  const copyJson = async () => {
    if (!selectedSnapshot?.data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedSnapshot.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <HistoryIcon size={24} className="text-orange-400" />
          Data History
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Browse stored data snapshots collected by the background collector
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex flex-wrap items-end gap-4">
          {/* Zone filter */}
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-400">Zone</label>
            <select
              value={filterZone}
              onChange={(e) => setFilterZone(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
            >
              <option value="">All Zones</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>

          {/* Report type filter */}
          <div className="min-w-[180px] flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-400">Report Type</label>
            <select
              value={filterReportType}
              onChange={(e) => setFilterReportType(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
            >
              <option value="">All Types</option>
              {(Object.keys(REPORT_TYPE_LABELS) as ReportType[]).map((rt) => (
                <option key={rt} value={rt}>
                  {REPORT_TYPE_LABELS[rt]}
                </option>
              ))}
            </select>
          </div>

          {/* Refresh button */}
          <button
            onClick={fetchSnapshots}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw size={24} className="animate-spin text-zinc-500" />
          <span className="ml-3 text-sm text-zinc-500">Loading snapshots...</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && snapshots.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 py-16 text-center">
          <Inbox size={40} className="mx-auto text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">No snapshots found</p>
          <p className="mt-1 text-xs text-zinc-500">
            The background collector has not stored any data yet, or no snapshots match the current filters.
          </p>
        </div>
      )}

      {/* Snapshot table */}
      {!loading && snapshots.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_120px_180px_100px_60px] gap-4 border-b border-zinc-800 px-5 py-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
            <span>Zone</span>
            <span>Report Type</span>
            <span>Period</span>
            <span>Collected</span>
            <span className="text-right">Actions</span>
          </div>

          {/* Rows */}
          <div className="divide-y divide-zinc-800/50">
            {snapshots.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[1fr_120px_180px_100px_60px] items-center gap-4 px-5 py-3 text-sm transition-colors hover:bg-zinc-800/30"
              >
                {/* Zone */}
                <div className="flex items-center gap-2 truncate">
                  <Globe size={14} className="shrink-0 text-zinc-500" />
                  <span className="truncate text-zinc-200">{s.zone_name}</span>
                </div>

                {/* Report type badge */}
                <div>
                  <span
                    className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                      REPORT_TYPE_COLORS[s.report_type] || "bg-zinc-800 text-zinc-400 border-zinc-700"
                    }`}
                  >
                    {REPORT_TYPE_LABELS[s.report_type] || s.report_type}
                  </span>
                </div>

                {/* Period */}
                <div className="text-xs text-zinc-400">
                  {formatDate(s.period_start)} – {formatDate(s.period_end)}
                </div>

                {/* Collected (relative) */}
                <div className="flex items-center gap-1 text-xs text-zinc-500" title={new Date(s.collected_at).toLocaleString()}>
                  <Clock size={12} className="shrink-0" />
                  {formatRelativeTime(s.collected_at)}
                </div>

                {/* Actions */}
                <div className="text-right">
                  <button
                    onClick={() => openDetail(s.id)}
                    className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
                    title="View snapshot data"
                  >
                    <Eye size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
            {snapshots.length} snapshot{snapshots.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* Detail slide-over panel */}
      {(selectedSnapshot || detailLoading) && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={closeDetail}
          />

          {/* Panel */}
          <div className="relative w-full max-w-2xl border-l border-zinc-800 bg-zinc-950 shadow-xl">
            {/* Panel header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                <Database size={18} className="text-orange-400" />
                Snapshot Detail
              </h2>
              <button
                onClick={closeDetail}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Panel content */}
            <div className="h-[calc(100vh-64px)] overflow-y-auto">
              {detailLoading && (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw size={20} className="animate-spin text-zinc-500" />
                  <span className="ml-3 text-sm text-zinc-500">Loading snapshot data...</span>
                </div>
              )}

              {selectedSnapshot && (
                <div className="space-y-4 p-6">
                  {/* Metadata */}
                  <div className="grid grid-cols-2 gap-3">
                    <MetaField label="Zone" value={selectedSnapshot.zone_name} />
                    <MetaField
                      label="Report Type"
                      value={REPORT_TYPE_LABELS[selectedSnapshot.report_type] || selectedSnapshot.report_type}
                    />
                    <MetaField
                      label="Period"
                      value={`${formatDate(selectedSnapshot.period_start)} – ${formatDate(selectedSnapshot.period_end)}`}
                    />
                    <MetaField
                      label="Collected"
                      value={new Date(selectedSnapshot.collected_at).toLocaleString()}
                    />
                  </div>

                  {/* JSON data */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-zinc-400">Response Data</label>
                      <button
                        onClick={copyJson}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                      >
                        {copied ? (
                          <>
                            <Check size={12} className="text-emerald-400" />
                            <span className="text-emerald-400">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            Copy JSON
                          </>
                        )}
                      </button>
                    </div>
                    <pre className="mt-2 max-h-[60vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-300">
                      {JSON.stringify(selectedSnapshot.data, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-zinc-200">{value}</div>
    </div>
  );
}
