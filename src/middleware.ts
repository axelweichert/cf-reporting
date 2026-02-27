import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Middleware to enforce APP_PASSWORD gate on API routes.
 *
 * When APP_PASSWORD is set, all API routes (except /api/auth/login)
 * require the user to have authenticated via the site password.
 *
 * We can't read iron-session here (middleware runs on the Edge runtime),
 * so we check for the existence of the session cookie as a lightweight gate.
 * The actual session validation happens in each API route handler.
 *
 * For a stronger gate, each API route also checks siteAuthenticated.
 */

export function middleware(request: NextRequest) {
  // Only apply when APP_PASSWORD is configured
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) return NextResponse.next();

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

  // Check if session cookie exists (lightweight check — full auth is in route handlers)
  const sessionCookie = request.cookies.get("cf-reporting-session");
  if (!sessionCookie) {
    // No session at all — redirect to login for page requests, 401 for API
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
