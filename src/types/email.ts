// --- SMTP Configuration ---

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS (465), false = STARTTLS (587)
  user: string;
  // Password is independently encrypted via HKDF-derived key
  encryptedPass: string; // AES-256-GCM ciphertext, base64
  passIv: string; // IV, base64
  passTag: string; // Auth tag, base64
  fromAddress: string;
  fromName: string;
}

// Input from API (plaintext password, encrypted before storage)
export interface SmtpConfigInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string; // plaintext — only in transit, never stored
  fromAddress: string;
  fromName: string;
}

// Response to client (password masked)
export interface SmtpConfigResponse {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordSet: boolean;
  fromAddress: string;
  fromName: string;
  source: "env" | "config" | "none";
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

// --- Persisted Config ---

export interface PersistedConfig {
  version: 1;
  smtp?: SmtpConfig;
  schedules: ScheduleConfig[];
  updatedAt: string;
}

// --- Email Status ---

export interface EmailStatus {
  persistentMode: boolean;
  secretExplicit: boolean;
  smtpConfigured: boolean;
  smtpSource: "env" | "config" | "none";
  schedulerRunning: boolean;
  activeSchedules: number;
  cfApiTokenSet: boolean;
}
