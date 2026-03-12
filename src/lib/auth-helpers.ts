import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { NextRequest } from "next/server";

/**
 * Shared authentication helpers for API routes.
 */

/**
 * Validate request origin for CSRF protection.
 * Rejects if Origin header is missing or doesn't match Host.
 * Origin is required on all mutating requests (POST/PUT/DELETE/PATCH).
 */
export function validateOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  // Require Origin header on mutating requests – missing Origin is not safe to allow
  if (!origin) {
    return Response.json({ error: "Forbidden: missing Origin header" }, { status: 403 });
  }
  if (!host) {
    return Response.json({ error: "Forbidden: missing Host header" }, { status: 403 });
  }

  try {
    if (new URL(origin).host !== host) return Response.json({ error: "Forbidden" }, { status: 403 });
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Get the current session data.
 * If APP_PASSWORD is set (or env tokens require it), the user must have authenticated.
 */
export async function getAuthenticatedSession(): Promise<SessionData | null> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);

  // Require APP_PASSWORD authentication when:
  // 1. APP_PASSWORD is explicitly configured, OR
  // 2. Env tokens are set (env tokens without APP_PASSWORD = open to any visitor)
  const hasEnvToken = !!(process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN);
  const requireSiteAuth = !!(process.env.APP_PASSWORD || hasEnvToken);
  if (requireSiteAuth && !session.siteAuthenticated) {
    return null;
  }

  // Check if user has a CF token (session or env)
  if (session.token || process.env.CF_API_TOKEN) {
    return session;
  }

  return null;
}

/**
 * Check if the current request is from an authenticated user.
 * Returns true if: (1) APP_PASSWORD gate passed (if set), and (2) CF token available.
 */
export async function requireAuth(): Promise<{ session: SessionData; token: string } | null> {
  const session = await getAuthenticatedSession();
  if (!session) return null;

  const token = session.token || process.env.CF_API_TOKEN;
  if (!token) return null;

  return { session, token };
}
