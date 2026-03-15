// --- SMTP Configuration ---

// One-shot SMTP config submitted inline with test/send requests (never persisted)
export type SmtpSecurity = "tls" | "starttls" | "none";

export interface InlineSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

// Response to client (env SMTP status only)
export interface SmtpConfigResponse {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  passwordSet: boolean;
  fromAddress: string;
  fromName: string;
  source: "env" | "none";
}

// --- Schedule Configuration ---

export type ReportType =
  | "executive"
  | "security"
  | "traffic"
  | "dns"
  | "performance"
  | "ssl"
  | "ddos"
  | "bots"
  | "origin-health"
  | "api-shield"
  | "zt-summary"
  | "gateway-dns"
  | "gateway-network"
  | "access-audit"
  | "shadow-it"
  | "devices-users";

/** Report types that require an accountId instead of a zoneId */
export const ACCOUNT_SCOPED_REPORTS: ReportType[] = [
  "zt-summary",
  "gateway-dns",
  "gateway-network",
  "access-audit",
  "shadow-it",
  "devices-users",
];

export type ScheduleFrequency = "daily" | "weekly" | "monthly";

export type ReportFormat = "html" | "pdf" | "both";

export interface ScheduleConfig {
  id: string;
  enabled: boolean;
  reportType: ReportType;
  reportTypes?: ReportType[]; // Multiple report types per schedule
  frequency: ScheduleFrequency;
  cronExpression: string; // Derived from frequency + hour/day settings
  hour: number; // Hour in the schedule's timezone (0-23)
  dayOfWeek?: number; // 0=Sun, 1=Mon, ..., 6=Sat (for weekly)
  dayOfMonth?: number; // 1-31 (for monthly)
  timezone: string; // IANA timezone (e.g. "Europe/Vienna"), default "UTC"
  recipients: string[];
  zoneId: string;
  zoneName: string;
  accountId?: string;
  accountName?: string;
  timeRange: "1d" | "7d" | "30d";
  format: ReportFormat; // "html", "pdf", or "both"
  subject?: string; // Custom subject line
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: "success" | "error";
  lastRunError?: string;
}

// --- Email Status ---

export interface EmailStatus {
  smtpConfigured: boolean;
  smtpSource: "env" | "none";
  schedulerRunning: boolean;
  activeSchedules: number;
  cfApiTokenSet: boolean;
  smtpEnvConfigured: boolean;
  appPasswordSet: boolean;
}
