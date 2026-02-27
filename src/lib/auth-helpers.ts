import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { NextRequest } from "next/server";

/**
 * Shared authentication helpers for API routes.
 */

/** Validate request origin for CSRF protection. Rejects if origin doesn't match host. */
export function validateOrigin(request: NextRequest): Response | null {
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

/**
 * Get the current session data.
 * If APP_PASSWORD is set and the user hasn't authenticated, returns null.
 */
export async function getAuthenticatedSession(): Promise<SessionData | null> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);

  // If APP_PASSWORD is configured, require site authentication
  if (process.env.APP_PASSWORD && !session.siteAuthenticated) {
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
