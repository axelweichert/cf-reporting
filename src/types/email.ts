// --- SMTP Configuration ---

// One-shot SMTP config submitted inline with test/send requests (never persisted)
export interface InlineSmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS (465), false = STARTTLS (587)
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

// Response to client (env SMTP status only)
export interface SmtpConfigResponse {
  host: string;
  port: number;
  secure: boolean;
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
  | "bots";

export type ScheduleFrequency = "daily" | "weekly" | "monthly";

export interface ScheduleConfig {
  id: string;
  enabled: boolean;
  reportType: ReportType;
  frequency: ScheduleFrequency;
  cronExpression: string; // Derived from frequency + hour/day settings
  hour: number; // UTC hour (0-23)
  dayOfWeek?: number; // 0=Sun, 1=Mon, ..., 6=Sat (for weekly)
  dayOfMonth?: number; // 1-31 (for monthly)
  recipients: string[];
  zoneId: string;
  zoneName: string;
  timeRange: "1d" | "7d" | "30d";
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
