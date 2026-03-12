import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { validateOrigin } from "@/lib/auth-helpers";
import { NextRequest } from "next/server";
import { timingSafeEqual, createHash } from "crypto";

/**
 * APP_PASSWORD login endpoint.
 *
 * Security measures:
 * - Constant-time password comparison (prevents timing attacks)
 * - Rate limiting per IP (prevents brute force)
 * - No password reflection in responses
 * - Origin validation (CSRF protection)
 */

// --- Rate limiting ---
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_MAP_SIZE = 10_000;

// Periodic cleanup to prevent unbounded map growth
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();

  // Periodic cleanup when map gets large
  if (loginAttempts.size > MAX_MAP_SIZE) {
    cleanupExpiredEntries();
  }

  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (record.count >= MAX_ATTEMPTS) {
    return false;
  }

  record.count++;
  return true;
}

/**
 * Extract client IP. Only trusts X-Forwarded-For / X-Real-IP when
 * TRUSTED_PROXY=true is set (meaning the app sits behind a known reverse proxy).
 * Without that flag, forwarded headers can be spoofed to evade rate limits.
 */
function getClientIp(request: NextRequest): string {
  if (process.env.TRUSTED_PROXY === "true") {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp;
  }
  return (request as NextRequest & { ip?: string }).ip || "unknown";
}

/**
 * Constant-time password comparison.
 * Hashes both values to ensure equal length, then uses timingSafeEqual.
 */
function secureCompare(input: string, expected: string): boolean {
  const inputHash = createHash("sha256").update(input).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

/** GET: Check if APP_PASSWORD is required and if user is authenticated */
export async function GET() {
  const appPassword = process.env.APP_PASSWORD;
  const hasEnvToken = !!(process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN);

  // Require site auth when APP_PASSWORD is set OR env tokens are present
  if (!appPassword && !hasEnvToken) {
    return Response.json({ required: false, authenticated: true });
  }

  if (!appPassword && hasEnvToken) {
    // Env token deployed without APP_PASSWORD – refuse to serve until configured
    return Response.json({
      required: true,
      authenticated: false,
      misconfigured: true,
      error: "APP_PASSWORD must be set when using CF_API_TOKEN or CF_ACCOUNT_TOKEN environment variables.",
    });
  }

  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  return Response.json({
    required: true,
    authenticated: session.siteAuthenticated === true,
  });
}

/** POST: Authenticate with APP_PASSWORD */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    return Response.json({ error: "APP_PASSWORD must be configured when using environment tokens" }, { status: 400 });
  }

  const ip = getClientIp(request);

  // Check rate limit
  if (!checkLoginRateLimit(ip)) {
    return Response.json(
      { error: "Too many login attempts. Please try again in 15 minutes." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const password = body?.password;

    if (!password || typeof password !== "string") {
      return Response.json({ error: "Password is required" }, { status: 400 });
    }

    if (!secureCompare(password, appPassword)) {
      return Response.json({ error: "Invalid password" }, { status: 401 });
    }

    // Success – set session flag (don't reset rate limit to prevent abuse)
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    session.siteAuthenticated = true;
    await session.save();

    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
}
