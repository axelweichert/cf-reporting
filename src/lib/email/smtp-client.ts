/**
 * SMTP client wrapper using nodemailer.
 *
 * Reads config from env vars (persistent) or inline one-shot config (per-request, never stored).
 * Never logs or exposes SMTP password.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { InlineSmtpConfig, SmtpSecurity } from "@/types/email";

// --- Rate limiting ---

const sendTimestamps: number[] = [];
const MAX_SENDS_PER_HOUR = 10;

function checkRateLimit(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (sendTimestamps.length > 0 && sendTimestamps[0] < oneHourAgo) {
    sendTimestamps.shift();
  }
  if (sendTimestamps.length >= MAX_SENDS_PER_HOUR) {
    throw new Error(`Rate limit exceeded: maximum ${MAX_SENDS_PER_HOUR} emails per hour`);
  }
}

function recordSend(): void {
  sendTimestamps.push(Date.now());
}

// --- SMTP config resolution ---

export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
  source: "env" | "inline" | "none";
}

/** Parse SMTP_SECURITY env var, with backward compat for legacy SMTP_SECURE boolean. */
function parseSmtpSecurity(): SmtpSecurity {
  const security = process.env.SMTP_SECURITY?.toLowerCase();
  if (security === "tls" || security === "starttls" || security === "none") return security;
  // Backward compat: SMTP_SECURE=true → tls, SMTP_SECURE=false → starttls
  if (process.env.SMTP_SECURE !== undefined) {
    return process.env.SMTP_SECURE === "false" ? "starttls" : "tls";
  }
  return "starttls"; // safe default for port 587
}

/** Get SMTP config from env vars. Returns null if not fully configured. */
export function getSmtpFromEnv(): ResolvedSmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  return {
    host,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    security: parseSmtpSecurity(),
    user,
    password: pass,
    fromAddress: process.env.SMTP_FROM || user,
    fromName: "cf-reporting",
    source: "env",
  };
}

/** Build a resolved config from inline one-shot SMTP data. Returns null if incomplete. */
export function resolveInlineSmtp(inline?: InlineSmtpConfig): ResolvedSmtpConfig | null {
  if (!inline?.host || !inline?.user || !inline?.password) return null;
  return {
    host: inline.host,
    port: inline.port,
    security: inline.security,
    user: inline.user,
    password: inline.password,
    fromAddress: inline.fromAddress || inline.user,
    fromName: inline.fromName || "cf-reporting",
    source: "inline",
  };
}

/** Resolve SMTP config: env vars take precedence, then inline one-shot. */
export function resolveSmtpConfig(inline?: InlineSmtpConfig): ResolvedSmtpConfig {
  const env = getSmtpFromEnv();
  if (env) return env;

  const inlineResolved = resolveInlineSmtp(inline);
  if (inlineResolved) return inlineResolved;

  return {
    host: "", port: 587, security: "starttls", user: "", password: "",
    fromAddress: "", fromName: "cf-reporting", source: "none",
  };
}

// --- Transport creation ---

function createTransport(config: ResolvedSmtpConfig): Transporter {
  if (config.source === "none") {
    throw new Error("SMTP is not configured. Set SMTP_* environment variables or provide SMTP settings with your request.");
  }

  const useTls = config.security === "tls";
  const useStarttls = config.security === "starttls";

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: useTls, // true = implicit TLS (port 465), false = plain or STARTTLS
    requireTLS: useStarttls, // force STARTTLS upgrade when not using implicit TLS
    auth: {
      user: config.user,
      pass: config.password,
    },
    tls: {
      rejectUnauthorized: config.security !== "none",
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

// --- Public API ---

/** Sanitize a name field for use in email From header – strips injection characters. */
function sanitizeName(name: string): string {
  return name.replace(/["\r\n<>]/g, "").trim() || "cf-reporting";
}

/** Test SMTP connection. Returns true if successful, throws on failure. */
export async function testSmtpConnection(inline?: InlineSmtpConfig): Promise<boolean> {
  const config = resolveSmtpConfig(inline);
  const transport = createTransport(config);
  try {
    await transport.verify();
    return true;
  } finally {
    transport.close();
  }
}

/** Send a test email to verify SMTP works end-to-end. */
export async function sendTestEmail(to: string, inline?: InlineSmtpConfig): Promise<void> {
  checkRateLimit();

  const config = resolveSmtpConfig(inline);
  const transport = createTransport(config);

  try {
    await transport.sendMail({
      from: `"${sanitizeName(config.fromName)}" <${config.fromAddress}>`,
      to,
      subject: "[cf-reporting] Test Email",
      text: "This is a test email from cf-reporting. If you received this, your SMTP configuration is working correctly.",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#333;">cf-reporting</h2>
          <p>This is a test email from cf-reporting.</p>
          <p>If you received this, your SMTP configuration is working correctly.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
          <p style="color:#999;font-size:12px;">Sent by cf-reporting email delivery system</p>
        </div>
      `,
    });

    recordSend();
  } finally {
    transport.close();
  }
}

/** Send a report email with HTML content. Uses env SMTP (for scheduler) or inline one-shot config. */
export async function sendReportEmail(
  recipients: string[],
  subject: string,
  html: string,
  inline?: InlineSmtpConfig
): Promise<void> {
  checkRateLimit();

  if (recipients.length === 0) throw new Error("No recipients specified");
  if (recipients.length > 10) throw new Error("Maximum 10 recipients per email");

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const email of recipients) {
    if (!emailRegex.test(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }
  }

  const config = resolveSmtpConfig(inline);
  const transport = createTransport(config);

  try {
    await transport.sendMail({
      from: `"${sanitizeName(config.fromName)}" <${config.fromAddress}>`,
      to: recipients.join(", "),
      subject,
      html,
      text: "This email contains an HTML report. Please view it in an HTML-capable email client.",
    });

    recordSend();
  } finally {
    transport.close();
  }
}

/** Send a report email with file attachments. Uses env SMTP (for scheduler) or inline one-shot config. */
export async function sendReportEmailWithAttachments(
  recipients: string[],
  subject: string,
  bodyText: string,
  attachments: Array<{ filename: string; content: Buffer; contentType: string }>,
  inline?: InlineSmtpConfig,
): Promise<void> {
  checkRateLimit();

  if (recipients.length === 0) throw new Error("No recipients specified");
  if (recipients.length > 10) throw new Error("Maximum 10 recipients per email");

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const email of recipients) {
    if (!emailRegex.test(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }
  }

  const config = resolveSmtpConfig(inline);
  const transport = createTransport(config);

  try {
    await transport.sendMail({
      from: `"${sanitizeName(config.fromName)}" <${config.fromAddress}>`,
      to: recipients.join(", "),
      subject,
      text: bodyText,
      attachments,
    });

    recordSend();
  } finally {
    transport.close();
  }
}

/** Check if SMTP is configured via env vars (for scheduler – no session available). */
export function isSmtpConfiguredViaEnv(): boolean {
  return getSmtpFromEnv() !== null;
}
