/**
 * SMTP client wrapper using nodemailer.
 *
 * Reads config from env vars (precedence) or config-store.
 * Never logs or exposes SMTP password.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { getSmtpConfig, getSmtpPassword } from "@/lib/config/config-store";

// --- Rate limiting ---

const sendTimestamps: number[] = [];
const MAX_SENDS_PER_HOUR = 10;

function checkRateLimit(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Remove old timestamps
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

// --- Transport creation ---

function createTransport(): Transporter {
  const config = getSmtpConfig();
  if (config.source === "none") {
    throw new Error("SMTP is not configured. Set up SMTP in Settings or via environment variables.");
  }

  const password = getSmtpPassword();
  if (!password) {
    throw new Error("SMTP password not available.");
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: password,
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

/** Test SMTP connection. Returns true if successful, throws on failure. */
export async function testSmtpConnection(): Promise<boolean> {
  const transport = createTransport();
  try {
    await transport.verify();
    return true;
  } finally {
    transport.close();
  }
}

/** Send a test email to verify SMTP works end-to-end. */
export async function sendTestEmail(to: string): Promise<void> {
  checkRateLimit();

  const config = getSmtpConfig();
  const transport = createTransport();

  try {
    await transport.sendMail({
      from: `"${config.fromName || "cf-reporting"}" <${config.fromAddress || config.user}>`,
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

/** Send a report email with HTML content. */
export async function sendReportEmail(
  recipients: string[],
  subject: string,
  html: string
): Promise<void> {
  checkRateLimit();

  if (recipients.length === 0) throw new Error("No recipients specified");
  if (recipients.length > 10) throw new Error("Maximum 10 recipients per email");

  // Validate email addresses
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const email of recipients) {
    if (!emailRegex.test(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }
  }

  const config = getSmtpConfig();
  const transport = createTransport();

  try {
    await transport.sendMail({
      from: `"${config.fromName || "cf-reporting"}" <${config.fromAddress || config.user}>`,
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

/** Check if SMTP is configured (either via env vars or config store). */
export function isSmtpConfigured(): boolean {
  return getSmtpConfig().source !== "none";
}
