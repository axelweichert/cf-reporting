/**
 * SMTP client wrapper using nodemailer.
 *
 * Reads config from env vars (precedence) or session-provided SMTP settings.
 * Never logs or exposes SMTP password.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { SessionSmtp } from "@/types/cloudflare";

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
  secure: boolean;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
  source: "env" | "session" | "none";
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
    secure: process.env.SMTP_SECURE !== "false",
    user,
    password: pass,
    fromAddress: process.env.SMTP_FROM || user,
    fromName: "cf-reporting",
    source: "env",
  };
}

/** Get SMTP config from session data. Returns null if not configured. */
export function getSmtpFromSession(smtp?: SessionSmtp): ResolvedSmtpConfig | null {
  if (!smtp?.host || !smtp?.user || !smtp?.password) return null;
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    user: smtp.user,
    password: smtp.password,
    fromAddress: smtp.fromAddress || smtp.user,
    fromName: smtp.fromName || "cf-reporting",
    source: "session",
  };
}

/** Resolve SMTP config: env vars take precedence, then session. */
export function resolveSmtpConfig(sessionSmtp?: SessionSmtp): ResolvedSmtpConfig {
  const env = getSmtpFromEnv();
  if (env) return env;

  const session = getSmtpFromSession(sessionSmtp);
  if (session) return session;

  return {
    host: "", port: 587, secure: true, user: "", password: "",
    fromAddress: "", fromName: "cf-reporting", source: "none",
  };
}

// --- Transport creation ---

function createTransport(config: ResolvedSmtpConfig): Transporter {
  if (config.source === "none") {
    throw new Error("SMTP is not configured. Set up SMTP in Settings or via environment variables.");
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
    tls: {
      rejectUnauthorized: true,
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
export async function testSmtpConnection(sessionSmtp?: SessionSmtp): Promise<boolean> {
  const config = resolveSmtpConfig(sessionSmtp);
  const transport = createTransport(config);
  try {
    await transport.verify();
    return true;
  } finally {
    transport.close();
  }
}

/** Send a test email to verify SMTP works end-to-end. */
export async function sendTestEmail(to: string, sessionSmtp?: SessionSmtp): Promise<void> {
  checkRateLimit();

  const config = resolveSmtpConfig(sessionSmtp);
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

/** Send a report email with HTML content. Uses env SMTP (for scheduler) or provided session SMTP. */
export async function sendReportEmail(
  recipients: string[],
  subject: string,
  html: string,
  sessionSmtp?: SessionSmtp
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

  const config = resolveSmtpConfig(sessionSmtp);
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

/** Check if SMTP is configured via env vars (for scheduler – no session available). */
export function isSmtpConfiguredViaEnv(): boolean {
  return getSmtpFromEnv() !== null;
}
