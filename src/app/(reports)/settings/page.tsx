"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/store";
import type { SmtpConfigResponse, ScheduleConfig, EmailStatus, ReportType, ScheduleFrequency } from "@/types/email";
import {
  Mail, Server, Clock, AlertTriangle, CheckCircle, Info,
  Trash2, ToggleLeft, ToggleRight, Plus, Send, RefreshCw,
  Database, Play,
} from "lucide-react";

const REPORT_TYPES: Array<{ value: ReportType; label: string }> = [
  { value: "executive", label: "Executive Report" },
  { value: "security", label: "Security Report" },
];

const FREQUENCIES: Array<{ value: ScheduleFrequency; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SettingsPage() {
  const { capabilities } = useAuth();
  const zones = capabilities?.zones || [];

  // Status
  const [status, setStatus] = useState<EmailStatus | null>(null);

  // SMTP form
  const [smtpConfig, setSmtpConfig] = useState<SmtpConfigResponse | null>(null);
  const [smtpForm, setSmtpForm] = useState({
    host: "", port: "587", secure: true, user: "", password: "", fromAddress: "", fromName: "cf-reporting",
  });
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpMessage, setSmtpMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // SMTP test
  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);

  // Schedules
  const [schedules, setSchedules] = useState<ScheduleConfig[]>([]);

  // New schedule form
  const [showNewSchedule, setShowNewSchedule] = useState(false);
  const [newSchedule, setNewSchedule] = useState({
    reportType: "executive" as ReportType,
    frequency: "weekly" as ScheduleFrequency,
    hour: 7,
    dayOfWeek: 1,
    dayOfMonth: 1,
    recipients: "",
    zoneId: "",
    timeRange: "7d" as "1d" | "7d" | "30d",
  });
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
    }>;
  } | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [collectorMessage, setCollectorMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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
        if (data.smtp.source !== "env") {
          setSmtpForm((prev) => ({
            ...prev,
            host: data.smtp.host || prev.host,
            port: String(data.smtp.port || 587),
            secure: data.smtp.secure ?? true,
            user: data.smtp.user || prev.user,
            fromAddress: data.smtp.fromAddress || prev.fromAddress,
            fromName: data.smtp.fromName || prev.fromName,
          }));
        }
      }
      if (schedulesRes.ok) {
        const data = await schedulesRes.json();
        setSchedules(data.schedules || []);
      }
      if (collectorRes.ok) setCollector(await collectorRes.json());
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

  // Save SMTP
  const handleSaveSmtp = async () => {
    setSmtpSaving(true);
    setSmtpMessage(null);
    try {
      const res = await fetch("/api/email/smtp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: smtpForm.host,
          port: parseInt(smtpForm.port, 10),
          secure: smtpForm.secure,
          user: smtpForm.user,
          password: smtpForm.password,
          fromAddress: smtpForm.fromAddress,
          fromName: smtpForm.fromName,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSmtpMessage({ type: "success", text: data.message });
        loadData();
      } else {
        setSmtpMessage({ type: "error", text: data.error });
      }
    } catch {
      setSmtpMessage({ type: "error", text: "Failed to save SMTP configuration" });
    }
    setSmtpSaving(false);
  };

  // Test SMTP
  const handleTestSmtp = async () => {
    setTesting(true);
    setSmtpMessage(null);
    try {
      const res = await fetch("/api/email/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testEmail || undefined }),
      });
      const data = await res.json();
      setSmtpMessage({ type: res.ok ? "success" : "error", text: data.message || data.error });
    } catch {
      setSmtpMessage({ type: "error", text: "Connection test failed" });
    }
    setTesting(false);
  };

  // Create schedule
  const handleCreateSchedule = async () => {
    setScheduleSaving(true);
    setFeedback(null);
    const zone = zones.find((z) => z.id === newSchedule.zoneId);
    try {
      const res = await fetch("/api/email/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newSchedule,
          recipients: newSchedule.recipients.split(",").map((e) => e.trim()).filter(Boolean),
          zoneName: zone?.name || newSchedule.zoneId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeedback({ type: "success", text: "Schedule created" });
        setShowNewSchedule(false);
        loadData();
      } else {
        setFeedback({ type: "error", text: data.error });
      }
    } catch {
      setFeedback({ type: "error", text: "Failed to create schedule" });
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
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatusBadge label="SMTP" value={status?.smtpConfigured ? `Via ${status.smtpSource}` : "Not configured"} ok={status?.smtpConfigured} />
          <StatusBadge label="Scheduler" value={status?.schedulerRunning ? "Running" : "Stopped"} ok={status?.schedulerRunning} />
          <StatusBadge label="CF_API_TOKEN" value={status?.cfApiTokenSet ? "Set" : "Not set"} ok={status?.cfApiTokenSet} />
          <StatusBadge label="Site Password" value={status?.appPasswordSet ? "Enabled" : "Disabled"} ok={status?.appPasswordSet} />
        </div>
        {!status?.cfApiTokenSet && (
          <p className="mt-3 text-xs text-zinc-500">
            Scheduled delivery requires CF_API_TOKEN and SMTP_* environment variables.
          </p>
        )}
        {smtpConfig?.source === "session" && (
          <p className="mt-2 text-xs text-yellow-400/80">
            <AlertTriangle size={12} className="mr-1 inline" />
            SMTP settings are stored in your browser session and will be lost when the session expires.
            Set SMTP_* environment variables for persistent configuration.
          </p>
        )}
      </div>

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
            Last run: {new Date(collector.lastRunAt * 1000).toLocaleString()} \u2013{" "}
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
            Data collection requires CF_API_TOKEN and a writable data volume. Mount a Docker volume at /app/data to enable persistent storage.
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
                      <td className="px-3 py-2 text-red-400">{run.error_count > 0 ? run.error_count : "\u2013"}</td>
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

        {isEnvSmtp && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
            <Info size={14} className="mt-0.5 shrink-0 text-blue-400" />
            <p className="text-xs text-blue-300">SMTP is configured via environment variables. Settings below are read-only.</p>
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

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => setSmtpForm({ ...smtpForm, secure: !smtpForm.secure })}
            className="flex items-center gap-2 text-sm text-zinc-300"
            disabled={isEnvSmtp}
          >
            {(isEnvSmtp ? smtpConfig?.secure : smtpForm.secure)
              ? <ToggleRight size={20} className="text-emerald-400" />
              : <ToggleLeft size={20} className="text-zinc-500" />}
            TLS / SSL
          </button>
        </div>

        {smtpMessage && (
          <div className={`mt-3 rounded-md px-3 py-2 text-xs ${smtpMessage.type === "success" ? "border border-emerald-500/20 bg-emerald-500/5 text-emerald-400" : "border border-red-500/20 bg-red-500/5 text-red-400"}`}>
            {smtpMessage.text}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          {!isEnvSmtp && (
            <button onClick={handleSaveSmtp} disabled={smtpSaving || !smtpForm.host} className="flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-600 disabled:opacity-50">
              <Server size={14} />
              {smtpSaving ? "Saving..." : "Save SMTP"}
            </button>
          )}

          <div className="flex items-center gap-2">
            <input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="test@example.com"
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-orange-500 focus:outline-none"
            />
            <button onClick={handleTestSmtp} disabled={testing || !smtpConfig || smtpConfig.source === "none"} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50">
              <Send size={14} />
              {testing ? "Testing..." : "Send Test"}
            </button>
          </div>
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
              onClick={() => setShowNewSchedule(true)}
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
            Set CF_API_TOKEN and SMTP_* environment variables to enable scheduled email delivery.
          </p>
        )}

        {status?.cfApiTokenSet && !status?.smtpEnvConfigured && (
          <p className="mt-3 text-xs text-yellow-400/80">
            <AlertTriangle size={12} className="mr-1 inline" />
            Set SMTP_* environment variables to enable scheduled email delivery. Session-based SMTP cannot be used for schedules.
          </p>
        )}

        <p className="mt-2 text-xs text-zinc-500">
          Schedules are stored in memory and will be lost on container restart. They require CF_API_TOKEN and SMTP environment variables.
        </p>

        {schedules.length === 0 && (
          <p className="mt-4 text-center text-sm text-zinc-500">No schedules configured</p>
        )}

        {schedules.length > 0 && (
          <div className="mt-4 space-y-2">
            {schedules.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{s.reportType}</span>
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{s.frequency}</span>
                    <span className="text-xs text-zinc-500">{s.cronExpression}</span>
                    {s.lastRunStatus === "success" && <CheckCircle size={12} className="text-emerald-400" />}
                    {s.lastRunStatus === "error" && <span title={s.lastRunError}><AlertTriangle size={12} className="text-red-400" /></span>}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {s.zoneName} · {s.timeRange} · {s.recipients.join(", ")}
                    {s.lastRunAt && <span> · Last run: {new Date(s.lastRunAt).toLocaleString()}</span>}
                  </div>
                </div>
                <div className="ml-3 flex items-center gap-2">
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

        {/* New schedule form */}
        {showNewSchedule && (
          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
            <h3 className="text-sm font-semibold text-white">New Schedule</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField label="Report Type" value={newSchedule.reportType} options={REPORT_TYPES} onChange={(v) => setNewSchedule({ ...newSchedule, reportType: v as ReportType })} />
              <SelectField label="Frequency" value={newSchedule.frequency} options={FREQUENCIES} onChange={(v) => setNewSchedule({ ...newSchedule, frequency: v as ScheduleFrequency })} />
              <SelectField label="Hour (UTC)" value={String(newSchedule.hour)} options={Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `${String(i).padStart(2, "0")}:00 UTC` }))} onChange={(v) => setNewSchedule({ ...newSchedule, hour: parseInt(v, 10) })} />
              {newSchedule.frequency === "weekly" && (
                <SelectField label="Day of Week" value={String(newSchedule.dayOfWeek)} options={DAYS_OF_WEEK.map((d, i) => ({ value: String(i), label: d }))} onChange={(v) => setNewSchedule({ ...newSchedule, dayOfWeek: parseInt(v, 10) })} />
              )}
              {newSchedule.frequency === "monthly" && (
                <SelectField label="Day of Month" value={String(newSchedule.dayOfMonth)} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} onChange={(v) => setNewSchedule({ ...newSchedule, dayOfMonth: parseInt(v, 10) })} />
              )}
              <SelectField label="Zone" value={newSchedule.zoneId} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={(v) => setNewSchedule({ ...newSchedule, zoneId: v })} />
              <SelectField label="Time Range" value={newSchedule.timeRange} options={[{ value: "1d", label: "Last 24h" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} onChange={(v) => setNewSchedule({ ...newSchedule, timeRange: v as "1d" | "7d" | "30d" })} />
              <div className="sm:col-span-2">
                <InputField label="Recipients (comma-separated)" value={newSchedule.recipients} onChange={(v) => setNewSchedule({ ...newSchedule, recipients: v })} placeholder="user1@example.com, user2@example.com" />
              </div>
            </div>

            {feedback && (
              <div className={`mt-3 rounded-md px-3 py-2 text-xs ${feedback.type === "success" ? "text-emerald-400" : "text-red-400"}`}>
                {feedback.text}
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <button onClick={handleCreateSchedule} disabled={scheduleSaving || !newSchedule.zoneId || !newSchedule.recipients} className="flex items-center gap-2 rounded-lg bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">
                {scheduleSaving ? "Creating..." : "Create Schedule"}
              </button>
              <button onClick={() => setShowNewSchedule(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
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
