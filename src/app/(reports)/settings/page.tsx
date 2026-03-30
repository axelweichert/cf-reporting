"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/store";
import type { SmtpConfigResponse, ScheduleConfig, EmailStatus, ReportType, ScheduleFrequency, SmtpSecurity, ReportFormat } from "@/types/email";
import { ACCOUNT_SCOPED_REPORTS } from "@/types/email";
import {
  Mail, Clock, AlertTriangle, CheckCircle, Info,
  Trash2, ToggleLeft, ToggleRight, Plus, Send, RefreshCw,
  Database, Play, HardDrive, Download, Upload, Cloud, Pencil, XCircle,
} from "lucide-react";

const REPORT_TYPES: Array<{ value: ReportType; label: string; group: string }> = [
  { value: "executive", label: "Executive Report", group: "Summary" },
  { value: "traffic", label: "Traffic Overview", group: "Web" },
  { value: "security", label: "Security Posture", group: "Web" },
  { value: "ddos", label: "DDoS & Rate Limiting", group: "Web" },
  { value: "bots", label: "Bot Analysis", group: "Web" },
  { value: "performance", label: "Performance", group: "Web" },
  { value: "ssl", label: "SSL / TLS", group: "Web" },
  { value: "api-shield", label: "API Shield", group: "Web" },
  { value: "origin-health", label: "Origin Health", group: "Web" },
  { value: "dns", label: "DNS Analytics", group: "DNS" },
  { value: "zt-summary", label: "ZT Summary", group: "Zero Trust" },
  { value: "gateway-dns", label: "Gateway DNS & HTTP", group: "Zero Trust" },
  { value: "gateway-network", label: "Gateway Network", group: "Zero Trust" },
  { value: "access-audit", label: "Access Audit", group: "Zero Trust" },
  { value: "shadow-it", label: "Shadow IT", group: "Zero Trust" },
  { value: "devices-users", label: "Devices & Users", group: "Zero Trust" },
  { value: "contract-usage", label: "Contract Usage", group: "License" },
];

const FREQUENCIES: Array<{ value: ScheduleFrequency; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Vienna",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Zurich",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Warsaw",
  "Europe/Prague",
  "Europe/Bucharest",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
];

function formatScheduleTime(s: ScheduleConfig): string {
  const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")}`;
  const tz = s.timezone && s.timezone !== "UTC" ? ` ${s.timezone.replace(/_/g, " ")}` : "";
  switch (s.frequency) {
    case "daily":
      return `Daily at ${time}${tz}`;
    case "weekly":
      return `Weekly ${DAYS_OF_WEEK[s.dayOfWeek ?? 0]} at ${time}${tz}`;
    case "monthly":
      return `Monthly on the ${s.dayOfMonth ?? 1}${ordinalSuffix(s.dayOfMonth ?? 1)} at ${time}${tz}`;
    default:
      return `${time}${tz}`;
  }
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function getReportLabel(rt: ReportType): string {
  return REPORT_TYPES.find((r) => r.value === rt)?.label || rt;
}

interface ScheduleFormState {
  reportTypes: ReportType[];
  frequency: ScheduleFrequency;
  hour: number;
  minute: number;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
  recipients: string;
  zoneId: string;
  timeRange: "1d" | "7d" | "30d";
  format: ReportFormat;
}

function defaultFormState(): ScheduleFormState {
  return {
    reportTypes: ["executive"],
    frequency: "weekly",
    hour: 7,
    minute: 0,
    dayOfWeek: 1,
    dayOfMonth: 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    recipients: "",
    zoneId: "",
    timeRange: "7d",
    format: "html",
  };
}

function scheduleToFormState(s: ScheduleConfig): ScheduleFormState {
  return {
    reportTypes: s.reportTypes && s.reportTypes.length > 0 ? s.reportTypes : [s.reportType],
    frequency: s.frequency,
    hour: s.hour,
    minute: s.minute ?? 0,
    dayOfWeek: s.dayOfWeek ?? 1,
    dayOfMonth: s.dayOfMonth ?? 1,
    timezone: s.timezone || "UTC",
    recipients: s.recipients.join(", "),
    zoneId: s.accountId || s.zoneId,
    timeRange: s.timeRange,
    format: s.format || "html",
  };
}

export default function SettingsPage() {
  const { capabilities, role } = useAuth();
  const zones = capabilities?.zones || [];
  const accounts = capabilities?.accounts || [];

  // Status
  const [status, setStatus] = useState<EmailStatus | null>(null);

  // SMTP form
  const [smtpConfig, setSmtpConfig] = useState<SmtpConfigResponse | null>(null);
  const [smtpForm, setSmtpForm] = useState({
    host: "", port: "587", security: "starttls" as SmtpSecurity, user: "", password: "", fromAddress: "", fromName: "cf-reporting",
  });
  const [smtpMessage, setSmtpMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // SMTP test
  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);

  // Schedules
  const [schedules, setSchedules] = useState<ScheduleConfig[]>([]);

  // Schedule form (shared for create + edit)
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>(defaultFormState());
  const [scheduleSaving, setScheduleSaving] = useState(false);

  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Collector
  const [collector, setCollector] = useState<{
    enabled: boolean;
    running: boolean;
    lastRunAt: number | null;
    lastRunStatus: string | null;
    schedule: string;
    totalCollectionRuns: number;
    totalSuccessItems: number;
    totalErrorItems: number;
    totalSkippedItems: number;
    uniqueScopes: number;
    uniqueReportTypes: number;
    recentRuns: Array<{
      id: number;
      run_id: string;
      started_at: number;
      finished_at: number | null;
      status: string;
      zones_count: number;
      accounts_count: number;
      success_count: number;
      error_count: number;
      skipped_count: number;
    }>;
  } | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [collectorMessage, setCollectorMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Backup
  const [backupStatus, setBackupStatus] = useState<{
    r2Configured: boolean;
    r2Bucket: string | null;
    databaseAvailable: boolean;
    databaseSizeMb: number | null;
  } | null>(null);
  const [backupMessage, setBackupMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [backupLoading, setBackupLoading] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeLoading, setWipeLoading] = useState(false);

  // Load data
  const loadData = useCallback(async () => {
    try {
      const [statusRes, smtpRes, schedulesRes, collectorRes] = await Promise.all([
        fetch("/api/email/status"),
        fetch("/api/email/smtp"),
        fetch("/api/email/schedules"),
        fetch("/api/collector/status"),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (smtpRes.ok) {
        const data = await smtpRes.json();
        setSmtpConfig(data.smtp);
      }
      if (schedulesRes.ok) {
        const data = await schedulesRes.json();
        setSchedules(data.schedules || []);
      }
      if (collectorRes.ok) setCollector(await collectorRes.json());

      // Load backup status
      try {
        const backupRes = await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status" }),
        });
        if (backupRes.ok) setBackupStatus(await backupRes.json());
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh collector status while running
  useEffect(() => {
    if (!collector?.running) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/collector/status");
        if (res.ok) setCollector(await res.json());
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [collector?.running]);

  // Trigger manual collection
  const handleTriggerCollection = async () => {
    setTriggering(true);
    setCollectorMessage(null);
    try {
      const res = await fetch("/api/collector/trigger", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setCollectorMessage({ type: "success", text: "Collection started" });
        // Start polling
        setTimeout(async () => {
          try {
            const r = await fetch("/api/collector/status");
            if (r.ok) setCollector(await r.json());
          } catch { /* ignore */ }
        }, 1000);
      } else {
        setCollectorMessage({ type: "error", text: data.error });
      }
    } catch {
      setCollectorMessage({ type: "error", text: "Failed to trigger collection" });
    }
    setTriggering(false);
  };

  // Refresh collector status
  const loadCollectorStatus = async () => {
    try {
      const res = await fetch("/api/collector/status");
      if (res.ok) setCollector(await res.json());
    } catch { /* ignore */ }
  };

  // Build inline SMTP config from form values (for one-shot use)
  const getInlineSmtp = () => ({
    host: smtpForm.host,
    port: parseInt(smtpForm.port, 10),
    security: smtpForm.security,
    user: smtpForm.user,
    password: smtpForm.password,
    fromAddress: smtpForm.fromAddress,
    fromName: smtpForm.fromName,
  });

  // Test SMTP
  const handleTestSmtp = async () => {
    setTesting(true);
    setSmtpMessage(null);
    try {
      const res = await fetch("/api/email/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: testEmail || undefined,
          smtp: isEnvSmtp ? undefined : getInlineSmtp(),
        }),
      });
      const data = await res.json();
      setSmtpMessage({ type: res.ok ? "success" : "error", text: data.message || data.error });
    } catch {
      setSmtpMessage({ type: "error", text: "Connection test failed" });
    }
    setTesting(false);
  };

  // All selected report types are account-scoped (ZT) or zone-scoped – don't allow mixing
  const isAccountScopedReport = scheduleForm.reportTypes.length > 0 && scheduleForm.reportTypes.every((rt) => ACCOUNT_SCOPED_REPORTS.includes(rt));
  const isZoneScopedReport = scheduleForm.reportTypes.length > 0 && scheduleForm.reportTypes.every((rt) => !ACCOUNT_SCOPED_REPORTS.includes(rt));
  const hasMixedScopes = scheduleForm.reportTypes.length > 0 && !isAccountScopedReport && !isZoneScopedReport;

  // Open new schedule form
  const handleNewSchedule = () => {
    setEditingScheduleId(null);
    setScheduleForm(defaultFormState());
    setShowScheduleForm(true);
    setFeedback(null);
  };

  // Open edit form for existing schedule
  const handleEditSchedule = (s: ScheduleConfig) => {
    setEditingScheduleId(s.id);
    setScheduleForm(scheduleToFormState(s));
    setShowScheduleForm(true);
    setFeedback(null);
  };

  // Create or update schedule
  const handleSaveSchedule = async () => {
    setScheduleSaving(true);
    setFeedback(null);
    const zone = zones.find((z) => z.id === scheduleForm.zoneId);
    const account = accounts.find((a) => a.id === scheduleForm.zoneId);
    const recipients = scheduleForm.recipients.split(",").map((e) => e.trim()).filter(Boolean);

    const payload = {
      reportType: scheduleForm.reportTypes[0],
      reportTypes: scheduleForm.reportTypes,
      frequency: scheduleForm.frequency,
      hour: scheduleForm.hour,
      minute: scheduleForm.minute,
      dayOfWeek: scheduleForm.dayOfWeek,
      dayOfMonth: scheduleForm.dayOfMonth,
      timezone: scheduleForm.timezone,
      timeRange: scheduleForm.timeRange,
      format: scheduleForm.format,
      recipients,
      ...(isAccountScopedReport
        ? { accountId: scheduleForm.zoneId, accountName: account?.name || scheduleForm.zoneId, zoneId: "", zoneName: "" }
        : { zoneId: scheduleForm.zoneId, zoneName: zone?.name || scheduleForm.zoneId }),
    };

    try {
      const isEdit = !!editingScheduleId;
      const res = await fetch("/api/email/schedules", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEdit ? { id: editingScheduleId, ...payload } : payload),
      });
      const data = await res.json();
      if (res.ok) {
        setFeedback({ type: "success", text: isEdit ? "Schedule updated" : "Schedule created" });
        setShowScheduleForm(false);
        setEditingScheduleId(null);
        loadData();
      } else {
        setFeedback({ type: "error", text: data.error });
      }
    } catch {
      setFeedback({ type: "error", text: "Failed to save schedule" });
    }
    setScheduleSaving(false);
  };

  // Delete schedule
  const handleDeleteSchedule = async (id: string) => {
    try {
      const res = await fetch(`/api/email/schedules?id=${id}`, { method: "DELETE" });
      if (res.ok) loadData();
    } catch { /* ignore */ }
  };

  // Toggle schedule
  const handleToggleSchedule = async (id: string, enabled: boolean) => {
    try {
      await fetch("/api/email/schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled: !enabled }),
      });
      loadData();
    } catch { /* ignore */ }
  };

  const isEnvSmtp = smtpConfig?.source === "env";

  // Backup handlers
  const handleDownloadConfig = () => {
    window.open("/api/backup?type=config", "_blank");
  };

  const handleDownloadDatabase = () => {
    window.open("/api/backup?type=database", "_blank");
  };

  const handleR2Upload = async (type: "config" | "database") => {
    setBackupLoading(`r2-${type}`);
    setBackupMessage(null);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "r2", type }),
      });
      const data = await res.json();
      if (res.ok) {
        setBackupMessage({ type: "success", text: `Uploaded to R2: ${data.key}` });
      } else {
        setBackupMessage({ type: "error", text: data.error });
      }
    } catch {
      setBackupMessage({ type: "error", text: "R2 upload failed" });
    }
    setBackupLoading(null);
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBackupLoading("restore");
    setBackupMessage(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetch("/api/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, merge: false }),
      });
      const result = await res.json();
      if (res.ok) {
        const parts: string[] = [];
        if (result.schedulesRestored > 0) parts.push(`${result.schedulesRestored} schedule(s) restored`);
        if (result.schedulesSkipped > 0) parts.push(`${result.schedulesSkipped} skipped`);
        if (result.errors?.length > 0) parts.push(`${result.errors.length} error(s)`);
        setBackupMessage({ type: result.errors?.length > 0 ? "error" : "success", text: parts.join(", ") || "Restore complete" });
        loadData();
      } else {
        setBackupMessage({ type: "error", text: result.error });
      }
    } catch {
      setBackupMessage({ type: "error", text: "Failed to parse backup file" });
    }
    setBackupLoading(null);
    if (restoreInputRef.current) restoreInputRef.current.value = "";
  };

  const handleWipeDatabase = async () => {
    setWipeLoading(true);
    setBackupMessage(null);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "wipe" }),
      });
      const data = await res.json();
      if (res.ok) {
        setBackupMessage({ type: "success", text: data.message });
        setShowWipeConfirm(false);
        loadData();
      } else {
        setBackupMessage({ type: "error", text: data.error });
      }
    } catch {
      setBackupMessage({ type: "error", text: "Failed to wipe database" });
    }
    setWipeLoading(false);
  };

  if (role === "viewer") {
    return (
      <div className="mx-auto max-w-4xl py-12 text-center">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="mt-2 text-zinc-400">Settings are only available to operators.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="mt-1 text-sm text-zinc-400">Configure email report delivery</p>
      </div>

      {/* System Status */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <Info size={18} className="text-blue-400" />
          System Status
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatusBadge label="Mode" value={status?.cfApiTokenSet ? "Managed Mode" : "Explore Mode"} ok={status?.cfApiTokenSet} />
          <StatusBadge label="SMTP" value={status?.smtpConfigured ? `Via ${status.smtpSource}` : "Not configured"} ok={status?.smtpConfigured} />
          <StatusBadge label="Scheduler" value={status?.schedulerRunning ? "Running" : "Stopped"} ok={status?.schedulerRunning} />
          <StatusBadge label="API Token" value={status?.cfApiTokenSet ? "Set" : "Not set"} ok={status?.cfApiTokenSet} />
          <StatusBadge label="Site Password" value={status?.appPasswordSet ? "Enabled" : "Disabled"} ok={status?.appPasswordSet} />
        </div>
        {!status?.cfApiTokenSet && (
          <p className="mt-3 text-xs text-zinc-500">
            Scheduled delivery requires a Cloudflare API token (CF_API_TOKEN or CF_ACCOUNT_TOKEN) and SMTP_* environment variables.
          </p>
        )}
      </div>

      {status?.cfApiTokenSet && <>
      {/* Data Collection */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            <Database size={18} className="text-cyan-400" />
            Data Collection
          </h2>
          <div className="flex gap-2">
            <button onClick={() => loadCollectorStatus()} className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button
              onClick={handleTriggerCollection}
              disabled={triggering || collector?.running || !collector?.enabled}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-700 disabled:opacity-50"
            >
              <Play size={14} />
              {collector?.running ? "Collecting..." : triggering ? "Starting..." : "Collect Now"}
            </button>
          </div>
        </div>

        {/* Status badges row */}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatusBadge label="Collector" value={collector?.enabled ? "Enabled" : "Disabled"} ok={collector?.enabled} />
          <StatusBadge label="Status" value={collector?.running ? "Running" : "Idle"} ok={collector?.running ? true : undefined} />
          <StatusBadge label="Schedule" value={collector?.schedule || "\u2013"} ok={!!collector?.schedule} />
          <StatusBadge label="Collections" value={String(collector?.totalCollectionRuns ?? 0)} ok={(collector?.totalCollectionRuns ?? 0) > 0} />
        </div>

        {/* Last run info */}
        {collector?.lastRunAt && (
          <div className="mt-3 text-xs text-zinc-400">
            Last run: {new Date(collector.lastRunAt * 1000).toLocaleString()} –{" "}
            <span className={collector.lastRunStatus === "success" ? "text-emerald-400" : collector.lastRunStatus === "error" ? "text-red-400" : "text-yellow-400"}>
              {collector.lastRunStatus}
            </span>
          </div>
        )}

        {/* Running indicator */}
        {collector?.running && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-cyan-500/20 bg-cyan-500/5 px-3 py-2">
            <RefreshCw size={14} className="animate-spin text-cyan-400" />
            <span className="text-xs text-cyan-300">Collection in progress... Auto-refreshing every 5s.</span>
          </div>
        )}

        {collectorMessage && (
          <div className={`mt-3 rounded-md px-3 py-2 text-xs ${collectorMessage.type === "success" ? "border border-emerald-500/20 bg-emerald-500/5 text-emerald-400" : "border border-red-500/20 bg-red-500/5 text-red-400"}`}>
            {collectorMessage.text}
          </div>
        )}

        {!collector?.enabled && (
          <p className="mt-3 text-xs text-zinc-500">
            Data collection requires a Cloudflare API token (CF_API_TOKEN or CF_ACCOUNT_TOKEN) and a writable data volume. Mount a Docker volume at /app/data to enable persistent storage.
          </p>
        )}

        {/* Recent runs table */}
        {collector?.recentRuns && collector.recentRuns.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-zinc-300">Recent Runs</h3>
            <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-zinc-500">
                    <th className="px-3 py-2">Run</th>
                    <th className="px-3 py-2">Started</th>
                    <th className="px-3 py-2">Success</th>
                    <th className="px-3 py-2">Skipped</th>
                    <th className="px-3 py-2">Errors</th>
                    <th className="px-3 py-2">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {collector.recentRuns.map((run, i) => (
                    <tr key={run.run_id} className={i % 2 === 0 ? "bg-zinc-900/30" : ""}>
                      <td className="px-3 py-2 font-mono text-zinc-400">{run.run_id.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-zinc-400">{new Date(run.started_at * 1000).toLocaleString()}</td>
                      <td className="px-3 py-2 text-emerald-400">{run.success_count}</td>
                      <td className="px-3 py-2 text-amber-400">{run.skipped_count > 0 ? run.skipped_count : "–"}</td>
                      <td className="px-3 py-2 text-red-400">{run.error_count > 0 ? run.error_count : "–"}</td>
                      <td className="px-3 py-2 text-zinc-400">{run.finished_at ? `${run.finished_at - run.started_at}s` : "running"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* SMTP Configuration */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <Mail size={18} className="text-orange-400" />
          SMTP Configuration
        </h2>

        {isEnvSmtp ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
            <Info size={14} className="mt-0.5 shrink-0 text-blue-400" />
            <p className="text-xs text-blue-300">SMTP is configured via environment variables. Settings below are read-only.</p>
          </div>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-2">
            <Info size={14} className="mt-0.5 shrink-0 text-zinc-400" />
            <p className="text-xs text-zinc-400">
              SMTP settings are used for this request only and are never stored. Set SMTP_* environment variables for persistent configuration.
            </p>
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InputField label="SMTP Host" value={isEnvSmtp ? (smtpConfig?.host || "") : smtpForm.host} onChange={(v) => setSmtpForm({ ...smtpForm, host: v })} placeholder="smtp.example.com" disabled={isEnvSmtp} />
          <InputField label="Port" value={isEnvSmtp ? String(smtpConfig?.port || 587) : smtpForm.port} onChange={(v) => setSmtpForm({ ...smtpForm, port: v })} placeholder="587" disabled={isEnvSmtp} />
          <InputField label="Username" value={isEnvSmtp ? (smtpConfig?.user || "") : smtpForm.user} onChange={(v) => setSmtpForm({ ...smtpForm, user: v })} placeholder="user@example.com" disabled={isEnvSmtp} />
          <InputField label="Password" value={isEnvSmtp ? "" : smtpForm.password} onChange={(v) => setSmtpForm({ ...smtpForm, password: v })} placeholder={smtpConfig?.passwordSet ? "••••••••" : "Enter password"} type="password" disabled={isEnvSmtp} />
          <InputField label="From Address" value={isEnvSmtp ? (smtpConfig?.fromAddress || "") : smtpForm.fromAddress} onChange={(v) => setSmtpForm({ ...smtpForm, fromAddress: v })} placeholder="reports@example.com" disabled={isEnvSmtp} />
          <InputField label="From Name" value={isEnvSmtp ? (smtpConfig?.fromName || "") : smtpForm.fromName} onChange={(v) => setSmtpForm({ ...smtpForm, fromName: v })} placeholder="cf-reporting" disabled={isEnvSmtp} />
        </div>

        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm text-zinc-400">Security</label>
          <select
            value={isEnvSmtp ? (smtpConfig?.security || "starttls") : smtpForm.security}
            onChange={(e) => setSmtpForm({ ...smtpForm, security: e.target.value as SmtpSecurity })}
            disabled={isEnvSmtp}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-white focus:border-orange-500 focus:outline-none disabled:opacity-60"
          >
            <option value="starttls">STARTTLS (port 587)</option>
            <option value="tls">TLS/SSL (port 465)</option>
            <option value="none">None (unencrypted)</option>
          </select>
        </div>

        {smtpMessage && (
          <div className={`mt-3 rounded-md px-3 py-2 text-xs ${smtpMessage.type === "success" ? "border border-emerald-500/20 bg-emerald-500/5 text-emerald-400" : "border border-red-500/20 bg-red-500/5 text-red-400"}`}>
            {smtpMessage.text}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="email"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="test@example.com"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-orange-500 focus:outline-none"
          />
          <button onClick={handleTestSmtp} disabled={testing || (isEnvSmtp ? false : !smtpForm.host)} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50">
            <Send size={14} />
            {testing ? "Testing..." : "Send Test"}
          </button>
        </div>
      </div>

      {/* Email Schedules */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            <Clock size={18} className="text-purple-400" />
            Email Schedules
          </h2>
          <div className="flex gap-2">
            <button onClick={() => loadData()} className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button
              onClick={handleNewSchedule}
              disabled={!status?.cfApiTokenSet || !status?.smtpEnvConfigured}
              className="flex items-center gap-2 rounded-lg bg-purple-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-600 disabled:opacity-50"
            >
              <Plus size={14} />
              New Schedule
            </button>
          </div>
        </div>

        {!status?.cfApiTokenSet && (
          <p className="mt-3 text-xs text-yellow-400/80">
            <AlertTriangle size={12} className="mr-1 inline" />
            Set a Cloudflare API token (CF_API_TOKEN or CF_ACCOUNT_TOKEN) and SMTP_* environment variables to enable scheduled email delivery.
          </p>
        )}

        {status?.cfApiTokenSet && !status?.smtpEnvConfigured && (
          <p className="mt-3 text-xs text-yellow-400/80">
            <AlertTriangle size={12} className="mr-1 inline" />
            Set SMTP_* environment variables to enable scheduled email delivery.
          </p>
        )}

        <p className="mt-2 text-xs text-zinc-500">
          Schedules are stored persistently and survive container restarts. They require a Cloudflare API token and SMTP environment variables.
        </p>

        {schedules.length === 0 && (
          <p className="mt-4 text-center text-sm text-zinc-500">No schedules configured</p>
        )}

        {schedules.length > 0 && (
          <div className="mt-4 space-y-2">
            {schedules.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-white">
                      {(s.reportTypes && s.reportTypes.length > 0 ? s.reportTypes : [s.reportType])
                        .map(getReportLabel).join(", ")}
                    </span>
                    {s.format && s.format !== "html" && <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-orange-400">{s.format.toUpperCase()}</span>}
                    {s.lastRunStatus === "success" && <CheckCircle size={12} className="text-emerald-400" />}
                    {s.lastRunStatus === "error" && <span title={s.lastRunError}><AlertTriangle size={12} className="text-red-400" /></span>}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {formatScheduleTime(s)} · {s.accountName || s.zoneName} · {s.timeRange} · {s.recipients.join(", ")}
                    {s.lastRunAt && <span> · Last run: {new Date(s.lastRunAt).toLocaleString()}</span>}
                  </div>
                </div>
                <div className="ml-3 flex items-center gap-2">
                  <button onClick={() => handleEditSchedule(s)} className="text-zinc-400 hover:text-white" title="Edit">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => handleToggleSchedule(s.id, s.enabled)} className="text-zinc-400 hover:text-white" title={s.enabled ? "Disable" : "Enable"}>
                    {s.enabled ? <ToggleRight size={20} className="text-emerald-400" /> : <ToggleLeft size={20} />}
                  </button>
                  <button onClick={() => handleDeleteSchedule(s.id)} className="text-zinc-500 hover:text-red-400" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Schedule form (create or edit) */}
        {showScheduleForm && (
          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
            <h3 className="text-sm font-semibold text-white">{editingScheduleId ? "Edit Schedule" : "New Schedule"}</h3>

            {/* Report type checkboxes grouped by category */}
            <div className="mt-3">
              <label className="mb-2 block text-xs font-medium text-zinc-400">Report Types</label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {Object.entries(
                  REPORT_TYPES.reduce((groups, rt) => {
                    (groups[rt.group] = groups[rt.group] || []).push(rt);
                    return groups;
                  }, {} as Record<string, typeof REPORT_TYPES>)
                ).map(([group, types]) => (
                  <div key={group}>
                    <div className="mb-1 text-xs font-medium text-zinc-500">{group}</div>
                    {types.map((rt) => (
                      <label key={rt.value} className="flex items-center gap-2 py-0.5 text-sm text-zinc-300 hover:text-white cursor-pointer">
                        <input
                          type="checkbox"
                          checked={scheduleForm.reportTypes.includes(rt.value)}
                          onChange={(e) => {
                            const updated = e.target.checked
                              ? [...scheduleForm.reportTypes, rt.value]
                              : scheduleForm.reportTypes.filter((v) => v !== rt.value);
                            setScheduleForm({ ...scheduleForm, reportTypes: updated, zoneId: "" });
                          }}
                          className="rounded border-zinc-600 bg-zinc-700 text-orange-500 focus:ring-orange-500"
                        />
                        {rt.label}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              {hasMixedScopes && (
                <p className="mt-2 text-xs text-yellow-400">
                  <AlertTriangle size={12} className="mr-1 inline" />
                  Cannot mix zone-scoped and account-scoped reports in one schedule. Select only web/DNS reports or only Zero Trust reports.
                </p>
              )}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField label="Frequency" value={scheduleForm.frequency} options={FREQUENCIES} onChange={(v) => setScheduleForm({ ...scheduleForm, frequency: v as ScheduleFrequency })} />
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">Time</label>
                <input
                  type="time"
                  value={`${String(scheduleForm.hour).padStart(2, "0")}:${String(scheduleForm.minute).padStart(2, "0")}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    setScheduleForm({ ...scheduleForm, hour: h, minute: m });
                  }}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
                />
              </div>
              <SelectField
                label="Timezone"
                value={scheduleForm.timezone}
                options={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz.replace(/_/g, " ") }))}
                onChange={(v) => setScheduleForm({ ...scheduleForm, timezone: v })}
              />
              {scheduleForm.frequency === "weekly" && (
                <SelectField label="Day of Week" value={String(scheduleForm.dayOfWeek)} options={DAYS_OF_WEEK.map((d, i) => ({ value: String(i), label: d }))} onChange={(v) => setScheduleForm({ ...scheduleForm, dayOfWeek: parseInt(v, 10) })} />
              )}
              {scheduleForm.frequency === "monthly" && (
                <SelectField label="Day of Month" value={String(scheduleForm.dayOfMonth)} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} onChange={(v) => setScheduleForm({ ...scheduleForm, dayOfMonth: parseInt(v, 10) })} />
              )}
              {isAccountScopedReport
                ? <SelectField label="Account" value={scheduleForm.zoneId} options={accounts.map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => setScheduleForm({ ...scheduleForm, zoneId: v })} />
                : <SelectField label="Zone" value={scheduleForm.zoneId} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={(v) => setScheduleForm({ ...scheduleForm, zoneId: v })} />
              }
              <SelectField label="Time Range" value={scheduleForm.timeRange} options={[{ value: "1d", label: "Last 24h" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} onChange={(v) => setScheduleForm({ ...scheduleForm, timeRange: v as "1d" | "7d" | "30d" })} />
              <SelectField
                label="Format"
                value={scheduleForm.format}
                options={[
                  { value: "html", label: "HTML Email" },
                  { value: "pdf", label: "PDF Attachment" },
                  { value: "both", label: "HTML + PDF Attachment" },
                ]}
                onChange={(v) => setScheduleForm({ ...scheduleForm, format: v as ReportFormat })}
              />
              <div className="sm:col-span-2">
                <InputField label="Recipients (comma-separated)" value={scheduleForm.recipients} onChange={(v) => setScheduleForm({ ...scheduleForm, recipients: v })} placeholder="user1@example.com, user2@example.com" />
              </div>
            </div>

            {feedback && (
              <div className={`mt-3 rounded-md px-3 py-2 text-xs ${feedback.type === "success" ? "text-emerald-400" : "text-red-400"}`}>
                {feedback.text}
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <button onClick={handleSaveSchedule} disabled={scheduleSaving || !scheduleForm.zoneId || !scheduleForm.recipients || scheduleForm.reportTypes.length === 0 || hasMixedScopes} className="flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50">
                {scheduleSaving ? "Saving..." : editingScheduleId ? "Update Schedule" : "Create Schedule"}
              </button>
              <button onClick={() => { setShowScheduleForm(false); setEditingScheduleId(null); }} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Contract Line Items */}
      <ContractSettingsSection />

      {/* Backup & Restore */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <HardDrive size={18} className="text-emerald-400" />
          Backup & Restore
        </h2>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatusBadge label="Database" value={backupStatus?.databaseAvailable ? `${backupStatus.databaseSizeMb ?? 0} MB` : "Unavailable"} ok={backupStatus?.databaseAvailable} />
          <StatusBadge label="R2 Storage" value={backupStatus?.r2Configured ? backupStatus.r2Bucket ?? "Configured" : "Not configured"} ok={backupStatus?.r2Configured} />
          <StatusBadge label="Schedules" value={String(schedules.length)} ok={schedules.length > 0} />
          <StatusBadge label="Collections" value={String(collector?.totalCollectionRuns ?? 0)} ok={(collector?.totalCollectionRuns ?? 0) > 0} />
        </div>

        {/* Export */}
        <div className="mt-4">
          <h3 className="text-sm font-medium text-zinc-300">Export</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={handleDownloadConfig}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              <Download size={14} />
              Download Config (JSON)
            </button>
            <button
              onClick={handleDownloadDatabase}
              disabled={!backupStatus?.databaseAvailable}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            >
              <Download size={14} />
              Download Database (SQLite)
            </button>
            {backupStatus?.r2Configured && (
              <>
                <button
                  onClick={() => handleR2Upload("config")}
                  disabled={backupLoading === "r2-config"}
                  className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
                >
                  <Cloud size={14} />
                  {backupLoading === "r2-config" ? "Uploading..." : "Config to R2"}
                </button>
                <button
                  onClick={() => handleR2Upload("database")}
                  disabled={backupLoading === "r2-database" || !backupStatus?.databaseAvailable}
                  className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
                >
                  <Cloud size={14} />
                  {backupLoading === "r2-database" ? "Uploading..." : "Database to R2"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Import */}
        <div className="mt-4">
          <h3 className="text-sm font-medium text-zinc-300">Restore</h3>
          <div className="mt-2 flex items-center gap-2">
            <input
              ref={restoreInputRef}
              type="file"
              accept=".json"
              onChange={handleRestoreFile}
              className="hidden"
            />
            <button
              onClick={() => restoreInputRef.current?.click()}
              disabled={backupLoading === "restore"}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            >
              <Upload size={14} />
              {backupLoading === "restore" ? "Restoring..." : "Restore from JSON"}
            </button>
            <span className="text-xs text-zinc-500">Replaces all existing schedules</span>
          </div>
        </div>

        {/* Reset Database */}
        <div className="mt-4">
          <h3 className="text-sm font-medium text-zinc-300">Danger Zone</h3>
          <div className="mt-2">
            {!showWipeConfirm ? (
              <button
                onClick={() => setShowWipeConfirm(true)}
                disabled={!backupStatus?.databaseAvailable}
                className="flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                <XCircle size={14} />
                Reset Database
              </button>
            ) : (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                <p className="text-sm font-medium text-red-400">Are you sure?</p>
                <p className="mt-1 text-xs text-zinc-400">
                  This will permanently delete all collected data, schedules, and collection history. This action cannot be undone.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={handleWipeDatabase}
                    disabled={wipeLoading}
                    className="flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    <XCircle size={14} />
                    {wipeLoading ? "Wiping..." : "Yes, wipe everything"}
                  </button>
                  <button
                    onClick={() => setShowWipeConfirm(false)}
                    className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {backupMessage && (
          <div className={`mt-3 rounded-md px-3 py-2 text-xs ${backupMessage.type === "success" ? "border border-emerald-500/20 bg-emerald-500/5 text-emerald-400" : "border border-red-500/20 bg-red-500/5 text-red-400"}`}>
            {backupMessage.text}
          </div>
        )}

        {!backupStatus?.r2Configured && (
          <p className="mt-3 text-xs text-zinc-500">
            To enable R2 backup, set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME environment variables.
          </p>
        )}
      </div>
      </>}
    </div>
  );
}

// --- Sub-components ---

function StatusBadge({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-0.5 text-sm font-medium ${ok ? "text-emerald-400" : "text-zinc-400"}`}>{value}</div>
    </div>
  );
}

function InputField({ label, value, onChange, placeholder, type = "text", disabled }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-orange-500 focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}

function SelectField({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
      >
        <option value="">Select...</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// =============================================================================
// Contract Settings Section
// =============================================================================

interface DetectedProduct {
  key: string;
  displayName: string;
  category: string;
  unit: string;
  description: string;
  detected: boolean;
}

interface ContractItem {
  id: number;
  productKey: string;
  displayName: string;
  category: string;
  unit: string;
  committedAmount: number;
  warningThreshold: number;
  enabled: boolean;
  accountId: string | null;
}

interface AccountInfo {
  account_id: string;
  account_name: string;
  total_zones: number;
  enterprise_zones: number;
}

function ContractSettingsSection() {
  const [items, setItems] = useState<ContractItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedProduct[] | null>(null);
  const [catalog, setCatalog] = useState<DetectedProduct[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addKey, setAddKey] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [addThreshold, setAddThreshold] = useState("80");
  const [addAccountId, setAddAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Batch add state (from detection)
  const [selectedDetected, setSelectedDetected] = useState<Set<string>>(new Set());
  const [batchAmounts, setBatchAmounts] = useState<Record<string, string>>({});

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch("/api/contract/line-items");
      if (res.ok) {
        const data = await res.json();
        setItems(data.items);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const [catRes, acctRes] = await Promise.all([
        fetch("/api/contract/catalog"),
        fetch("/api/contract/accounts"),
      ]);
      if (catRes.ok) {
        const data = await catRes.json();
        setCatalog(data.catalog);
      }
      if (acctRes.ok) {
        const data = await acctRes.json();
        setAccounts(data.accounts || []);
        // Auto-select first account if available
        if (data.accounts?.length > 0 && !addAccountId) {
          setAddAccountId(data.accounts[0].account_id);
        }
      }
    } catch { /* ignore */ }
  }, [addAccountId]);

  useEffect(() => {
    loadItems();
    loadCatalog();
  }, [loadItems, loadCatalog]);

  const handleDetect = async () => {
    setDetecting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/contract/detect", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        const products = data.products as DetectedProduct[];
        setDetected(products);
        // Pre-select detected items that aren't already configured
        const existingKeys = new Set(items.map((i) => i.productKey));
        const preSelected = new Set(
          products.filter((p) => p.detected && !existingKeys.has(p.key)).map((p) => p.key),
        );
        setSelectedDetected(preSelected);
        setBatchAmounts({});
      }
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    }
    setDetecting(false);
  };

  const handleBatchAdd = async () => {
    const toAdd = Array.from(selectedDetected)
      .filter((key) => {
        const amt = parseFloat(batchAmounts[key] || "");
        return !isNaN(amt) && amt > 0;
      })
      .map((key) => ({
        productKey: key,
        committedAmount: parseFloat(batchAmounts[key]),
        accountId: addAccountId || undefined,
      }));

    if (toAdd.length === 0) {
      setMessage({ type: "error", text: "Enter committed amounts for selected items" });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/contract/line-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: toAdd }),
      });
      const data = await res.json();
      if (data.created?.length > 0) {
        setMessage({ type: "success", text: `Added ${data.created.length} line item(s)` });
        setDetected(null);
        await loadItems();
      }
      if (data.errors?.length > 0) {
        setMessage({ type: "error", text: data.errors.map((e: { error: string }) => e.error).join(", ") });
      }
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    }
    setSaving(false);
  };

  const handleAddSingle = async () => {
    if (!addKey || !addAmount) return;
    setSaving(true);
    try {
      const res = await fetch("/api/contract/line-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            productKey: addKey,
            committedAmount: parseFloat(addAmount),
            warningThreshold: (parseFloat(addThreshold) || 80) / 100,
            accountId: addAccountId || undefined,
          },
        }),
      });
      if (res.ok) {
        setMessage({ type: "success", text: "Line item added" });
        setShowAddForm(false);
        setAddKey("");
        setAddAmount("");
        setAddThreshold("80");
        await loadItems();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.errors?.[0]?.error || "Failed to add" });
      }
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    }
    setSaving(false);
  };

  const handleUpdate = async (id: number, field: string, value: number | boolean) => {
    await fetch("/api/contract/line-items", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, [field]: value }),
    });
    await loadItems();
  };

  const handleDelete = async (id: number) => {
    await fetch(`/api/contract/line-items?id=${id}`, { method: "DELETE" });
    await loadItems();
  };

  const existingKeys = new Set(items.map((i) => i.productKey));
  const availableCatalog = catalog.filter((c) => !existingKeys.has(c.key));

  // Group catalog by category for the dropdown
  // Account name lookup for display
  const accountNameMap = new Map<string, string>(
    accounts.map((a) => [a.account_id, a.account_name || a.account_id.slice(0, 12)]),
  );

  const catalogByCategory = new Map<string, DetectedProduct[]>();
  for (const c of availableCatalog) {
    const arr = catalogByCategory.get(c.category) || [];
    arr.push(c);
    catalogByCategory.set(c.category, arr);
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-white">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
          <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="M7 21h10" /><path d="M12 3v18" /><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
        </svg>
        Contract Line Items
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Configure your Cloudflare contract entitlements to track usage against committed amounts.
      </p>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={handleDetect}
          disabled={detecting}
          className="flex items-center gap-1.5 rounded-md bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
        >
          {detecting ? "Detecting..." : "Detect Available Products"}
        </button>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1.5 rounded-md bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600"
        >
          <Plus size={14} />
          Add from Catalog
        </button>
      </div>

      {/* Detection results */}
      {detected && (
        <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-800 p-4">
          <h3 className="text-sm font-medium text-zinc-300">Detected Products</h3>
          <p className="mt-1 text-xs text-zinc-500">Select products and enter committed amounts.</p>
          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
            {detected.filter((p) => !existingKeys.has(p.key)).map((product) => (
              <div key={product.key} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedDetected.has(product.key)}
                  onChange={(e) => {
                    const next = new Set(selectedDetected);
                    if (e.target.checked) next.add(product.key);
                    else next.delete(product.key);
                    setSelectedDetected(next);
                  }}
                  className="rounded border-zinc-600"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-zinc-200">{product.displayName}</span>
                  {product.detected && <span className="ml-2 rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs text-emerald-400">detected</span>}
                </div>
                <span className="text-xs text-zinc-500 w-12 text-right">{product.unit}</span>
                <input
                  type="number"
                  placeholder="Amount"
                  value={batchAmounts[product.key] || ""}
                  onChange={(e) => setBatchAmounts({ ...batchAmounts, [product.key]: e.target.value })}
                  disabled={!selectedDetected.has(product.key)}
                  className="w-24 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-sm text-white placeholder-zinc-600 disabled:opacity-40"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleBatchAdd}
              disabled={saving || selectedDetected.size === 0}
              className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {saving ? "Adding..." : `Add ${selectedDetected.size} Selected`}
            </button>
            <button
              onClick={() => setDetected(null)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add from catalog form */}
      {showAddForm && !detected && (
        <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-800 p-4">
          <h3 className="text-sm font-medium text-zinc-300">Add Line Item</h3>
          {accounts.length > 0 && (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-zinc-400">Account</label>
              <select
                value={addAccountId}
                onChange={(e) => setAddAccountId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
              >
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.account_name || a.account_id.slice(0, 12)} ({a.enterprise_zones} enterprise / {a.total_zones} total zones)
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-zinc-400">Product</label>
              <select
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
              >
                <option value="">Select product...</option>
                {Array.from(catalogByCategory.entries()).map(([cat, products]) => (
                  <optgroup key={cat} label={cat}>
                    {products.map((p) => (
                      <option key={p.key} value={p.key}>{p.displayName} ({p.unit})</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Committed Amount</label>
              <input
                type="number"
                step="0.01"
                value={addAmount}
                onChange={(e) => setAddAmount(e.target.value)}
                placeholder="e.g. 40"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-orange-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Warning at %</label>
              <input
                type="number"
                step="1"
                min="1"
                max="100"
                value={addThreshold}
                onChange={(e) => setAddThreshold(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-orange-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleAddSingle}
              disabled={saving || !addKey || !addAmount}
              className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {saving ? "Adding..." : "Add"}
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Line items table */}
      {loading ? (
        <div className="mt-4 text-sm text-zinc-500">Loading...</div>
      ) : items.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="px-2 py-2 text-left">Product</th>
                <th className="px-2 py-2 text-left">Category</th>
                <th className="px-2 py-2 text-left">Account</th>
                <th className="px-2 py-2 text-right">Committed</th>
                <th className="px-2 py-2 text-right">Unit</th>
                <th className="px-2 py-2 text-right">Warning %</th>
                <th className="px-2 py-2 text-center">Enabled</th>
                <th className="px-2 py-2 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <ContractItemRow
                  key={item.id}
                  item={item}
                  accountNames={accountNameMap}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-zinc-500">No contract line items configured. Use &quot;Detect Available Products&quot; or &quot;Add from Catalog&quot; to get started.</p>
      )}

      {message && (
        <div className={`mt-3 rounded-md px-3 py-2 text-xs ${message.type === "success" ? "border border-emerald-500/20 bg-emerald-500/5 text-emerald-400" : "border border-red-500/20 bg-red-500/5 text-red-400"}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}

function ContractItemRow({ item, accountNames, onUpdate, onDelete }: {
  item: ContractItem;
  accountNames: Map<string, string>;
  onUpdate: (id: number, field: string, value: number | boolean) => void;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(item.committedAmount));
  const [threshold, setThreshold] = useState(String(Math.round(item.warningThreshold * 100)));

  const handleSave = () => {
    const newAmount = parseFloat(amount);
    const newThreshold = parseFloat(threshold);
    if (!isNaN(newAmount) && newAmount > 0) onUpdate(item.id, "committedAmount", newAmount);
    if (!isNaN(newThreshold) && newThreshold >= 1 && newThreshold <= 100) onUpdate(item.id, "warningThreshold", newThreshold / 100);
    setEditing(false);
  };

  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
      <td className="px-2 py-2 text-zinc-200">{item.displayName}</td>
      <td className="px-2 py-2 text-zinc-400">{item.category}</td>
      <td className="px-2 py-2 text-zinc-500 text-xs">{item.accountId ? (accountNames.get(item.accountId) || item.accountId.slice(0, 12)) : "All"}</td>
      <td className="px-2 py-2 text-right font-mono text-zinc-200">
        {editing ? (
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
            className="w-20 rounded border border-zinc-600 bg-zinc-900 px-1 py-0.5 text-right text-sm text-white" />
        ) : item.committedAmount}
      </td>
      <td className="px-2 py-2 text-right text-zinc-500">{item.unit}</td>
      <td className="px-2 py-2 text-right font-mono text-zinc-400">
        {editing ? (
          <input type="number" step="1" min="1" max="100" value={threshold} onChange={(e) => setThreshold(e.target.value)}
            className="w-16 rounded border border-zinc-600 bg-zinc-900 px-1 py-0.5 text-right text-sm text-white" />
        ) : `${(item.warningThreshold * 100).toFixed(0)}%`}
      </td>
      <td className="px-2 py-2 text-center">
        <button onClick={() => onUpdate(item.id, "enabled", !item.enabled)} className="text-zinc-400 hover:text-white">
          {item.enabled ? <ToggleRight size={18} className="text-emerald-400" /> : <ToggleLeft size={18} />}
        </button>
      </td>
      <td className="px-2 py-2 text-center">
        <div className="flex items-center justify-center gap-1">
          {editing ? (
            <>
              <button onClick={handleSave} className="rounded bg-orange-500/20 px-2 py-0.5 text-xs text-orange-400 hover:bg-orange-500/30">Save</button>
              <button onClick={() => setEditing(false)} className="rounded bg-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-600">Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} className="text-zinc-500 hover:text-zinc-300">
                <Pencil size={14} />
              </button>
              <button onClick={() => onDelete(item.id)} className="text-zinc-500 hover:text-red-400">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
