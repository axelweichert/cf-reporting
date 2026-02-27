import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import type { SmtpConfigInput } from "@/types/email";
import { getSmtpConfig, saveSmtpConfig, getPersistenceStatus } from "@/lib/config/config-store";
import { NextRequest } from "next/server";

function validateOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return null;
  try {
    if (new URL(origin).host !== host) return Response.json({ error: "Forbidden" }, { status: 403 });
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

async function requireAuth(): Promise<SessionData | null> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (session.token || process.env.CF_API_TOKEN) return session;
  return null;
}

/** GET: Return current SMTP config (password masked) */
export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return Response.json({
    smtp: getSmtpConfig(),
    persistence: getPersistenceStatus(),
  });
}

/** POST: Save SMTP configuration */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as SmtpConfigInput;

    // Validate required fields
    if (!body.host || !body.port || !body.user || !body.password || !body.fromAddress) {
      return Response.json({ error: "Missing required SMTP fields" }, { status: 400 });
    }

    // Validate port
    if (body.port < 1 || body.port > 65535) {
      return Response.json({ error: "Invalid port number" }, { status: 400 });
    }

    // Validate from address
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.fromAddress)) {
      return Response.json({ error: "Invalid from address" }, { status: 400 });
    }

    const { persistentMode } = getPersistenceStatus();

    saveSmtpConfig(body);

    return Response.json({
      success: true,
      persistent: persistentMode,
      message: persistentMode
        ? "SMTP configuration saved persistently."
        : "SMTP configuration saved in memory (will be lost on restart).",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save SMTP configuration";
    return Response.json({ error: message }, { status: 500 });
  }
}
