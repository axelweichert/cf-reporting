import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { getCapabilitiesCache, setCapabilitiesCache } from "@/lib/capabilities-cache";
import { detectCapabilities } from "@/lib/token";

export async function GET() {
  const session = await getIronSession<SessionData>(
    await cookies(),
    sessionOptions
  );

  // Enforce site auth gate (APP_PASSWORD or env tokens present)
  const hasEnvToken = !!(process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN);
  if ((process.env.APP_PASSWORD || hasEnvToken) && !session.siteAuthenticated) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const token = session.token || process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN;
  if (!token) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Try cache first
  const cached = getCapabilitiesCache(token);
  if (cached) {
    return Response.json(cached);
  }

  // Re-fetch from Cloudflare
  try {
    const capabilities = await detectCapabilities(token);
    setCapabilitiesCache(token, capabilities);

    // Also update the session with fresh permission data
    session.capabilities = {
      permissions: capabilities.permissions,
      accountCount: capabilities.accounts.length,
      zoneCount: capabilities.zones.length,
    };
    await session.save();

    return Response.json(capabilities);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch capabilities";
    return Response.json({ error: message }, { status: 502 });
  }
}
