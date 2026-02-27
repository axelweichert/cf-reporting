/**
 * Config store singleton for persistent email configuration.
 *
 * Detects whether DATA_DIR is writable:
 * - Writable → persistent mode (encrypted JSON file survives restarts)
 * - Not writable → in-memory mode (config lost on restart)
 *
 * SMTP env vars (SMTP_HOST etc.) always take precedence over stored config.
 */

import { accessSync, readFileSync, writeFileSync, renameSync, constants } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  encryptConfig,
  decryptConfig,
  encryptSmtpPassword,
  decryptSmtpPassword,
  isSecretExplicit,
} from "./crypto";
import type {
  SmtpConfig,
  SmtpConfigInput,
  SmtpConfigResponse,
  ScheduleConfig,
  PersistedConfig,
} from "@/types/email";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const CONFIG_FILE = "config.enc";

// --- Persistence detection ---

let _persistentMode: boolean | null = null;

function isPersistent(): boolean {
  if (_persistentMode !== null) return _persistentMode;
  try {
    accessSync(DATA_DIR, constants.W_OK);
    _persistentMode = isSecretExplicit();
  } catch {
    _persistentMode = false;
  }
  return _persistentMode;
}

// --- In-memory fallback ---

let memoryConfig: PersistedConfig = {
  version: 1,
  schedules: [],
  updatedAt: new Date().toISOString(),
};

// --- File I/O ---

function configPath(): string {
  return join(DATA_DIR, CONFIG_FILE);
}

function loadFromDisk(): PersistedConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const blob = JSON.parse(raw);
    const decrypted = decryptConfig(blob);
    return JSON.parse(decrypted) as PersistedConfig;
  } catch {
    // File doesn't exist or can't be decrypted — start fresh
    return { version: 1, schedules: [], updatedAt: new Date().toISOString() };
  }
}

function saveToDisk(config: PersistedConfig): void {
  config.updatedAt = new Date().toISOString();
  const json = JSON.stringify(config);
  const encrypted = encryptConfig(json);
  const tempPath = configPath() + ".tmp";
  writeFileSync(tempPath, JSON.stringify(encrypted), { mode: 0o600 });
  renameSync(tempPath, configPath());
}

// --- Initialization ---

let initialized = false;

function ensureLoaded(): PersistedConfig {
  if (!initialized) {
    initialized = true;
    if (isPersistent()) {
      memoryConfig = loadFromDisk();
    }
  }
  return memoryConfig;
}

function save(config: PersistedConfig): void {
  memoryConfig = config;
  if (isPersistent()) {
    saveToDisk(config);
  }
}

// --- SMTP env var detection ---

function smtpFromEnv(): SmtpConfigResponse | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return {
    host,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE !== "false",
    user: process.env.SMTP_USER || "",
    passwordSet: !!process.env.SMTP_PASS,
    fromAddress: process.env.SMTP_FROM || "",
    fromName: process.env.SMTP_FROM_NAME || "cf-reporting",
    source: "env",
  };
}

// --- Public API ---

export function getPersistenceStatus() {
  return {
    persistentMode: isPersistent(),
    secretExplicit: isSecretExplicit(),
    dataDir: DATA_DIR,
  };
}

/** Get SMTP config for API response (password always masked). Env vars take precedence. */
export function getSmtpConfig(): SmtpConfigResponse {
  const envConfig = smtpFromEnv();
  if (envConfig) return envConfig;

  const config = ensureLoaded();
  if (!config.smtp) {
    return {
      host: "",
      port: 587,
      secure: true,
      user: "",
      passwordSet: false,
      fromAddress: "",
      fromName: "cf-reporting",
      source: "none",
    };
  }

  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user,
    passwordSet: !!config.smtp.encryptedPass,
    fromAddress: config.smtp.fromAddress,
    fromName: config.smtp.fromName,
    source: "config",
  };
}

/** Get the raw SMTP password (decrypted). For internal use by smtp-client only. */
export function getSmtpPassword(): string | null {
  // Env var takes precedence
  if (process.env.SMTP_HOST && process.env.SMTP_PASS) {
    return process.env.SMTP_PASS;
  }

  const config = ensureLoaded();
  if (!config.smtp?.encryptedPass) return null;

  try {
    return decryptSmtpPassword({
      encryptedPass: config.smtp.encryptedPass,
      passIv: config.smtp.passIv,
      passTag: config.smtp.passTag,
    });
  } catch {
    return null;
  }
}

/** Save SMTP config (encrypts password before storage). */
export function saveSmtpConfig(input: SmtpConfigInput): void {
  const config = ensureLoaded();
  const encrypted = encryptSmtpPassword(input.password);

  config.smtp = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    encryptedPass: encrypted.encryptedPass,
    passIv: encrypted.passIv,
    passTag: encrypted.passTag,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
  };

  save(config);
}

/** Get all schedules. */
export function getSchedules(): ScheduleConfig[] {
  return ensureLoaded().schedules;
}

/** Add a new schedule. Returns the created schedule with ID. */
export function addSchedule(schedule: Omit<ScheduleConfig, "id" | "createdAt">): ScheduleConfig {
  const config = ensureLoaded();
  const newSchedule: ScheduleConfig = {
    ...schedule,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  config.schedules.push(newSchedule);
  save(config);
  return newSchedule;
}

/** Update an existing schedule by ID. */
export function updateSchedule(id: string, updates: Partial<ScheduleConfig>): ScheduleConfig | null {
  const config = ensureLoaded();
  const idx = config.schedules.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  config.schedules[idx] = { ...config.schedules[idx], ...updates, id };
  save(config);
  return config.schedules[idx];
}

/** Delete a schedule by ID. */
export function deleteSchedule(id: string): boolean {
  const config = ensureLoaded();
  const before = config.schedules.length;
  config.schedules = config.schedules.filter((s) => s.id !== id);
  if (config.schedules.length === before) return false;
  save(config);
  return true;
}

/** Update schedule run status (called by scheduler after execution). */
export function updateScheduleRunStatus(
  id: string,
  status: "success" | "error",
  error?: string
): void {
  const config = ensureLoaded();
  const schedule = config.schedules.find((s) => s.id === id);
  if (!schedule) return;
  schedule.lastRunAt = new Date().toISOString();
  schedule.lastRunStatus = status;
  schedule.lastRunError = status === "error" ? error : undefined;
  save(config);
}
