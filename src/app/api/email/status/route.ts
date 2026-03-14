import { getAuthenticatedSession } from "@/lib/auth-helpers";
import type { EmailStatus } from "@/types/email";
import { getSmtpFromEnv } from "@/lib/email/smtp-client";

/** GET: Return email delivery system status */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const envSmtp = getSmtpFromEnv();

  let schedulerRunning = false;
  try {
    const { isSchedulerRunning } = await import("@/lib/scheduler");
    schedulerRunning = isSchedulerRunning();
  } catch {
    // Scheduler module may not be loaded
  }

  let activeSchedules = 0;
  try {
    const { getSchedules } = await import("@/lib/scheduler");
    activeSchedules = getSchedules().filter((s) => s.enabled).length;
  } catch {
    // Scheduler module may not be loaded
  }

  const status: EmailStatus = {
    smtpConfigured: !!envSmtp,
    smtpSource: envSmtp ? "env" : "none",
    schedulerRunning,
    activeSchedules,
    cfApiTokenSet: !!process.env.CF_API_TOKEN,
    smtpEnvConfigured: !!envSmtp,
    appPasswordSet: !!process.env.APP_PASSWORD,
  };

  return Response.json(status);
}
