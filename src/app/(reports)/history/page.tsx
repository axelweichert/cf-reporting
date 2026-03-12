"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/store";
import {
  History as HistoryIcon,
  Database,
  RefreshCw,
  X,
  Clock,
  Globe,
  Copy,
  Check,
  Inbox,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Table2,
  Loader2,
  Server,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportType =
  | "executive" | "security" | "traffic" | "performance" | "dns"
  | "origin-health" | "ssl" | "bots" | "api-shield" | "ddos"
  | "gateway-dns" | "gateway-network" | "shadow-it" | "devices-users" | "zt-summary" | "access-audit";

interface CollectionRun {
  id: number;
  run_id: string;
  started_at: number;
  finished_at: number | null;
  status: "running" | "success" | "partial" | "error";
  zones_count: number;
  accounts_count: number;
  success_count: number;
  error_count: number;
  skipped_count: number;
}

interface DataAvailability {
  scope_id: string;
  scope_name: string;
  report_type: string;
  last_collected_at: number;
  data_point_count: number;
  collection_count: number;
}

interface CollectorStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  schedule: string;
  totalReportTypes: number;
  totalCollectionRuns: number;
  totalSuccessItems: number;
  totalErrorItems: number;
  totalSkippedItems: number;
  uniqueScopes: number;
  uniqueReportTypes: number;
  recentRuns: CollectionRun[];
}

interface CollectionLogEntry {
  id: number;
  run_id: string;
  scope_id: string;
  scope_name: string;
  report_type: string;
  status: "success" | "error" | "skipped";
  error_message: string | null;
  duration_ms: number | null;
  collected_at: number;
}

interface AggregateStatRow {
  scope_id: string;
  collected_at: number;
  report_type: string;
  stat_key: string;
  stat_value: number;
}

interface CellDetail {
  scopeId: string;
  scopeName: string;
  reportType: string;
  aggregateStats: AggregateStatRow[];
  timeSeries: Record<string, unknown>[];
  collectionHistory: CollectionLogEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  running: { icon: Loader2, color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
  success: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
  partial: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" },
  error: { icon: XCircle, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(epochSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diffSec = now - epochSec;
  if (diffSec < 60) return "just now";
  const diffMins = Math.floor(diffSec / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(epochSec * 1000).toLocaleDateString();
}

function formatTimestamp(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HistoryPage() {
  useAuth(); // ensure authentication context is available

  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [availability, setAvailability] = useState<DataAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  // Run detail expansion
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runLogs, setRunLogs] = useState<CollectionLogEntry[]>([]);
  const [runLogsLoading, setRunLogsLoading] = useState(false);

  // Cell detail panel
  const [cellDetail, setCellDetail] = useState<CellDetail | null>(null);
  const [cellDetailLoading, setCellDetailLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Active tab in detail panel
  const [detailTab, setDetailTab] = useState<"stats" | "timeseries" | "history">("stats");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, availRes] = await Promise.all([
        fetch("/api/collector/status"),
        fetch("/api/collector/snapshots"),
      ]);

      if (!statusRes.ok) throw new Error(`Status API: HTTP ${statusRes.status}`);
      if (!availRes.ok) throw new Error(`Snapshots API: HTTP ${availRes.status}`);

      const statusData = await statusRes.json();
      const availData = await availRes.json();

      setStatus(statusData);
      setAvailability(availData.availability || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh while collector is running
  useEffect(() => {
    if (!status?.running) return;
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [status?.running, fetchData]);

  const triggerCollection = async () => {
    setTriggering(true);
    try {
      const res = await fetch("/api/collector/trigger", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Refresh status after a short delay
      setTimeout(fetchData, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger collection");
    } finally {
      setTriggering(false);
    }
  };

  const toggleRunExpansion = async (runId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      setRunLogs([]);
      return;
    }

    setExpandedRunId(runId);
    setRunLogsLoading(true);
    try {
      const res = await fetch(`/api/collector/snapshots?runId=${runId}`);
      if (!res.ok) throw new Error("Failed to load run logs");
      const data = await res.json();
      setRunLogs(data.logs || []);
    } catch {
      setRunLogs([]);
    } finally {
      setRunLogsLoading(false);
    }
  };

  const openCellDetail = async (scopeId: string, scopeName: string, reportType: string) => {
    setCellDetailLoading(true);
    setCellDetail(null);
    setDetailTab("stats");
    setCopied(false);
    try {
      const params = new URLSearchParams({ scopeId, reportType });
      const res = await fetch(`/api/collector/snapshots?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load detail");
      const data = await res.json();
      setCellDetail({
        scopeId,
        scopeName,
        reportType,
        aggregateStats: data.aggregateStats || [],
        timeSeries: data.timeSeries || [],
        collectionHistory: data.collectionHistory || [],
      });
    } catch {
      setCellDetail(null);
    } finally {
      setCellDetailLoading(false);
    }
  };

  const closeCellDetail = () => {
    setCellDetail(null);
    setCellDetailLoading(false);
    setCopied(false);
  };

  const copyJson = async (data: unknown) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  // Build the availability grid: group by scope, columns = report types
  const scopeMap = new Map<string, { name: string; items: Map<string, DataAvailability> }>();
  for (const row of availability) {
    if (!scopeMap.has(row.scope_id)) {
      scopeMap.set(row.scope_id, { name: row.scope_name, items: new Map() });
    }
    scopeMap.get(row.scope_id)!.items.set(row.report_type, row);
  }
  const scopes = Array.from(scopeMap.entries());
  const allReportTypes = Array.from(new Set(availability.map((a) => a.report_type))).sort();

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <HistoryIcon size={24} className="text-orange-400" />
            Data History
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Normalized data collected by the background collector
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          {status?.enabled && (
            <button
              onClick={triggerCollection}
              disabled={triggering || status?.running}
              className="flex items-center gap-2 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-500 disabled:opacity-50"
            >
              {triggering || status?.running ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Activity size={14} />
              )}
              {status?.running ? "Running..." : "Collect Now"}
            </button>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && !status && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw size={24} className="animate-spin text-zinc-500" />
          <span className="ml-3 text-sm text-zinc-500">Loading data history...</span>
        </div>
      )}

      {/* Stats overview */}
      {status && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Collection Runs"
            value={status.totalCollectionRuns.toString()}
            icon={Activity}
          />
          <StatCard
            label="Successful Items"
            value={status.totalSuccessItems.toString()}
            icon={CheckCircle2}
            color="text-emerald-400"
          />
          <StatCard
            label="Skipped (No Access)"
            value={status.totalSkippedItems.toString()}
            icon={AlertTriangle}
            color="text-amber-400"
          />
          <StatCard
            label={status.totalErrorItems > 0 ? "Errors" : "Active Scopes"}
            value={status.totalErrorItems > 0 ? status.totalErrorItems.toString() : `${status.uniqueScopes} × ${status.uniqueReportTypes}`}
            icon={status.totalErrorItems > 0 ? XCircle : Server}
            color={status.totalErrorItems > 0 ? "text-red-400" : "text-zinc-400"}
          />
        </div>
      )}

      {/* Recent collection runs */}
      {status && status.recentRuns.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="border-b border-zinc-800 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Clock size={16} className="text-zinc-400" />
              Recent Collection Runs
            </h2>
          </div>
          <div className="divide-y divide-zinc-800/50">
            {status.recentRuns.map((run) => {
              const cfg = STATUS_CONFIG[run.status] || STATUS_CONFIG.error;
              const StatusIcon = cfg.icon;
              const isExpanded = expandedRunId === run.run_id;
              const durationSec = run.finished_at
                ? run.finished_at - run.started_at
                : Math.floor(Date.now() / 1000) - run.started_at;

              return (
                <div key={run.run_id}>
                  <button
                    onClick={() => toggleRunExpansion(run.run_id)}
                    className="flex w-full items-center gap-4 px-5 py-3 text-sm transition-colors hover:bg-zinc-800/30"
                  >
                    {/* Expand/collapse chevron */}
                    <span className="text-zinc-500">
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>

                    {/* Status badge */}
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.bg}`}>
                      <StatusIcon size={12} className={run.status === "running" ? "animate-spin" : ""} />
                      {run.status}
                    </span>

                    {/* Timestamp */}
                    <span className="text-zinc-400">{formatTimestamp(run.started_at)}</span>

                    {/* Scope counts */}
                    <span className="text-zinc-500">
                      {run.zones_count} zone{run.zones_count !== 1 ? "s" : ""}, {run.accounts_count} account{run.accounts_count !== 1 ? "s" : ""}
                    </span>

                    {/* Results */}
                    <span className="ml-auto flex items-center gap-3 text-xs">
                      <span className="text-emerald-400">{run.success_count} OK</span>
                      {run.skipped_count > 0 && (
                        <span className="text-amber-400">{run.skipped_count} skipped</span>
                      )}
                      {run.error_count > 0 && (
                        <span className="text-red-400">{run.error_count} error{run.error_count !== 1 ? "s" : ""}</span>
                      )}
                      <span className="text-zinc-500">{durationSec}s</span>
                    </span>
                  </button>

                  {/* Expanded run log */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800/30 bg-zinc-950/50 px-5 py-3">
                      {runLogsLoading ? (
                        <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
                          <Loader2 size={14} className="animate-spin" />
                          Loading log entries...
                        </div>
                      ) : runLogs.length === 0 ? (
                        <p className="py-2 text-sm text-zinc-500">No log entries found for this run.</p>
                      ) : (
                        <div className="max-h-64 overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                                <th className="pb-2 pr-3 font-medium">Scope</th>
                                <th className="pb-2 pr-3 font-medium">Report</th>
                                <th className="pb-2 pr-3 font-medium">Status</th>
                                <th className="pb-2 pr-3 font-medium">Duration</th>
                                <th className="pb-2 font-medium">Error</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-800/30">
                              {runLogs.map((log) => (
                                <tr key={log.id} className="text-zinc-300">
                                  <td className="py-1.5 pr-3">
                                    <span className="truncate">{log.scope_name}</span>
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    <span
                                      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                                        REPORT_TYPE_COLORS[log.report_type as ReportType] || "bg-zinc-800 text-zinc-400 border-zinc-700"
                                      }`}
                                    >
                                      {REPORT_TYPE_LABELS[log.report_type as ReportType] || log.report_type}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    <span className={
                                      log.status === "success" ? "text-emerald-400" :
                                      log.status === "skipped" ? "text-amber-400" :
                                      log.status === "error" ? "text-red-400" : "text-zinc-500"
                                    }>
                                      {log.status}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 text-zinc-500">
                                    {log.duration_ms != null ? formatDuration(log.duration_ms) : "–"}
                                  </td>
                                  <td className={`max-w-[200px] truncate py-1.5 ${log.status === "skipped" ? "text-amber-400/70" : "text-red-400/70"}`} title={log.error_message || undefined}>
                                    {log.error_message || "–"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Data availability grid */}
      {!loading && availability.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 py-16 text-center">
          <Inbox size={40} className="mx-auto text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">No collected data yet</p>
          <p className="mt-1 text-xs text-zinc-500">
            The background collector has not stored any data yet. Trigger a collection run or wait for the scheduled run.
          </p>
        </div>
      )}

      {!loading && scopes.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="border-b border-zinc-800 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Database size={16} className="text-zinc-400" />
              Data Availability
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Click a cell to view collected data for that scope and report type
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="sticky left-0 z-10 bg-zinc-900 px-4 py-2.5 text-left font-medium text-zinc-400">
                    Scope
                  </th>
                  {allReportTypes.map((rt) => (
                    <th key={rt} className="px-2 py-2.5 text-center font-medium text-zinc-400">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                          REPORT_TYPE_COLORS[rt as ReportType] || "bg-zinc-800 text-zinc-400 border-zinc-700"
                        }`}
                      >
                        {REPORT_TYPE_LABELS[rt as ReportType] || rt}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {scopes.map(([scopeId, scope]) => (
                  <tr key={scopeId} className="hover:bg-zinc-800/20">
                    <td className="sticky left-0 z-10 bg-zinc-900/95 px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Globe size={12} className="shrink-0 text-zinc-500" />
                        <span className="truncate text-zinc-200" title={scopeId}>
                          {scope.name}
                        </span>
                      </div>
                    </td>
                    {allReportTypes.map((rt) => {
                      const item = scope.items.get(rt);
                      if (!item) {
                        return (
                          <td key={rt} className="px-2 py-2 text-center text-zinc-700">
                            –
                          </td>
                        );
                      }
                      return (
                        <td key={rt} className="px-2 py-2 text-center">
                          <button
                            onClick={() => openCellDetail(scopeId, scope.name, rt)}
                            className="group inline-flex flex-col items-center gap-0.5 rounded-md px-2 py-1 transition-colors hover:bg-zinc-700/50"
                            title={`${scope.name} / ${REPORT_TYPE_LABELS[rt as ReportType] || rt}\nLast: ${formatTimestamp(item.last_collected_at)}\n${item.collection_count} collection(s)`}
                          >
                            <span className="text-[10px] text-zinc-400 group-hover:text-zinc-200">
                              {formatRelativeTime(item.last_collected_at)}
                            </span>
                            <span className="text-[10px] text-zinc-600">
                              {item.collection_count}x
                            </span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
            {scopes.length} scope{scopes.length !== 1 ? "s" : ""} × {allReportTypes.length} report type{allReportTypes.length !== 1 ? "s" : ""} – {availability.length} active combination{availability.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* Cell detail slide-over panel */}
      {(cellDetail || cellDetailLoading) && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={closeCellDetail}
          />

          {/* Panel */}
          <div className="relative w-full max-w-2xl border-l border-zinc-800 bg-zinc-950 shadow-xl">
            {/* Panel header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                  <Database size={18} className="text-orange-400" />
                  {cellDetail
                    ? `${cellDetail.scopeName} – ${REPORT_TYPE_LABELS[cellDetail.reportType as ReportType] || cellDetail.reportType}`
                    : "Loading..."}
                </h2>
              </div>
              <button
                onClick={closeCellDetail}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tab bar */}
            {cellDetail && (
              <div className="flex border-b border-zinc-800">
                <TabButton
                  active={detailTab === "stats"}
                  onClick={() => setDetailTab("stats")}
                  icon={BarChart3}
                  label={`Stats (${cellDetail.aggregateStats.length})`}
                />
                <TabButton
                  active={detailTab === "timeseries"}
                  onClick={() => setDetailTab("timeseries")}
                  icon={Activity}
                  label={`Time Series (${cellDetail.timeSeries.length})`}
                />
                <TabButton
                  active={detailTab === "history"}
                  onClick={() => setDetailTab("history")}
                  icon={Table2}
                  label={`History (${cellDetail.collectionHistory.length})`}
                />
              </div>
            )}

            {/* Panel content */}
            <div className="h-[calc(100vh-120px)] overflow-y-auto">
              {cellDetailLoading && (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={20} className="animate-spin text-zinc-500" />
                  <span className="ml-3 text-sm text-zinc-500">Loading data...</span>
                </div>
              )}

              {cellDetail && detailTab === "stats" && (
                <div className="p-6">
                  {cellDetail.aggregateStats.length === 0 ? (
                    <EmptyTabState message="No aggregate stats stored yet. Data normalization transforms will populate this tab." />
                  ) : (
                    <div>
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-400">Aggregate Statistics</span>
                        <CopyButton
                          copied={copied}
                          onClick={() => copyJson(cellDetail.aggregateStats)}
                        />
                      </div>
                      <div className="divide-y divide-zinc-800/50 rounded-lg border border-zinc-800 bg-zinc-900">
                        {cellDetail.aggregateStats.map((stat, i) => (
                          <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                            <span className="text-zinc-400">{stat.stat_key}</span>
                            <span className="font-mono text-zinc-200">
                              {Number.isInteger(stat.stat_value)
                                ? stat.stat_value.toLocaleString()
                                : stat.stat_value.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {cellDetail && detailTab === "timeseries" && (
                <div className="p-6">
                  {cellDetail.timeSeries.length === 0 ? (
                    <EmptyTabState message="No time series data stored yet. Data will appear once normalization transforms are active." />
                  ) : (
                    <div>
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-400">
                          Time Series Data ({cellDetail.timeSeries.length} rows)
                        </span>
                        <CopyButton
                          copied={copied}
                          onClick={() => copyJson(cellDetail.timeSeries)}
                        />
                      </div>
                      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-zinc-800 text-left text-zinc-500">
                              {Object.keys(cellDetail.timeSeries[0]).map((key) => (
                                <th key={key} className="px-3 py-2 font-medium">
                                  {key}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/30">
                            {cellDetail.timeSeries.slice(0, 100).map((row, i) => (
                              <tr key={i} className="text-zinc-300">
                                {Object.entries(row).map(([key, val]) => (
                                  <td key={key} className="whitespace-nowrap px-3 py-1.5 font-mono">
                                    {key === "ts" || key === "collected_at"
                                      ? formatTimestamp(val as number)
                                      : String(val ?? "–")}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {cellDetail.timeSeries.length > 100 && (
                          <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                            Showing 100 of {cellDetail.timeSeries.length} rows
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {cellDetail && detailTab === "history" && (
                <div className="p-6">
                  {cellDetail.collectionHistory.length === 0 ? (
                    <EmptyTabState message="No collection history for this scope and report type." />
                  ) : (
                    <div className="divide-y divide-zinc-800/50 rounded-lg border border-zinc-800 bg-zinc-900">
                      {cellDetail.collectionHistory.map((log) => (
                        <div key={log.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <span className={
                            log.status === "success" ? "text-emerald-400" :
                            log.status === "error" ? "text-red-400" : "text-zinc-500"
                          }>
                            {log.status === "success" ? (
                              <CheckCircle2 size={14} />
                            ) : log.status === "error" ? (
                              <XCircle size={14} />
                            ) : (
                              <AlertTriangle size={14} />
                            )}
                          </span>
                          <span className="text-zinc-400">{formatTimestamp(log.collected_at)}</span>
                          <span className="text-zinc-500">
                            {log.duration_ms != null ? formatDuration(log.duration_ms) : ""}
                          </span>
                          {log.error_message && (
                            <span className="ml-auto max-w-[200px] truncate text-xs text-red-400/70" title={log.error_message}>
                              {log.error_message}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon: Icon,
  color = "text-zinc-400",
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Icon size={14} className={color} />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Activity;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
        active
          ? "border-orange-500 text-orange-400"
          : "border-transparent text-zinc-500 hover:text-zinc-300"
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function EmptyTabState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 py-12 text-center">
      <Inbox size={32} className="mx-auto text-zinc-600" />
      <p className="mt-3 text-sm text-zinc-500">{message}</p>
    </div>
  );
}

function CopyButton({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
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
  );
}
