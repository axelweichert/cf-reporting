import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import type { EmailStatus } from "@/types/email";
import { getSmtpConfig, getSchedules, getPersistenceStatus } from "@/lib/config/config-store";
import { isSecretExplicit } from "@/lib/config/crypto";

/** GET: Return email delivery system status */
export async function GET() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.token && !process.env.CF_API_TOKEN) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const smtp = getSmtpConfig();
  const { persistentMode } = getPersistenceStatus();
  const schedules = getSchedules();

  let schedulerRunning = false;
  try {
    const { isSchedulerRunning } = await import("@/lib/scheduler");
    schedulerRunning = isSchedulerRunning();
  } catch {
    // Scheduler module may not be loaded
  }

  const status: EmailStatus = {
    persistentMode,
    secretExplicit: isSecretExplicit(),
    smtpConfigured: smtp.source !== "none",
    smtpSource: smtp.source,
    schedulerRunning,
    activeSchedules: schedules.filter((s) => s.enabled).length,
    cfApiTokenSet: !!process.env.CF_API_TOKEN,
  };

  return Response.json(status);
}
