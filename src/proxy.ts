import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Proxy to enforce site authentication gate.
 *
 * Gate applies when APP_PASSWORD is set OR when env tokens
 * (CF_API_TOKEN/CF_ACCOUNT_TOKEN) are present – deploying env tokens
 * without APP_PASSWORD would otherwise expose the app to any visitor.
 *
 * We can't read iron-session here (proxy runs on the Edge runtime),
 * so we check for the existence of the session cookie as a lightweight gate.
 * The actual session validation happens in each API route handler.
 */

export function proxy(request: NextRequest) {
  const appPassword = process.env.APP_PASSWORD;
  const hasEnvToken = !!(process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN);
  if (!appPassword && !hasEnvToken) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // Allow the login page and login API
  if (pathname === "/login" || pathname === "/api/auth/login") {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg")
  ) {
    return NextResponse.next();
  }

  // Check if session cookie exists (lightweight check – full auth is in route handlers)
  const sessionCookie = request.cookies.get("cf-reporting-session");
  if (!sessionCookie) {
    // No session at all – redirect to login for page requests, 401 for API
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
