import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { verifyToken, detectCapabilities } from "@/lib/token";
import { setCapabilitiesCache } from "@/lib/capabilities-cache";
import { NextRequest } from "next/server";

function validateOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return null;
  const originHost = new URL(origin).host;
  if (originHost !== host) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const session = await getIronSession<SessionData>(
    await cookies(),
    sessionOptions
  );

  // Check env var first
  const envToken = process.env.CF_API_TOKEN;
  if (envToken && !session.token) {
    session.token = envToken;
    session.tokenSource = "env";
    await session.save();
  }

  if (!session.token) {
    return Response.json({ authenticated: false });
  }

  return Response.json({
    authenticated: true,
    tokenSource: session.tokenSource || "browser",
    capabilities: session.capabilities || null,
  });
}

export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const { token } = await request.json();

  if (!token || typeof token !== "string") {
    return Response.json(
      { error: "API token is required" },
      { status: 400 }
    );
  }

  try {
    await verifyToken(token);
    const fullCapabilities = await detectCapabilities(token);

    const session = await getIronSession<SessionData>(
      await cookies(),
      sessionOptions
    );
    session.token = token;
    session.tokenSource = "browser";
    // Store only lightweight data in the cookie
    session.capabilities = {
      permissions: fullCapabilities.permissions,
      accountCount: fullCapabilities.accounts.length,
      zoneCount: fullCapabilities.zones.length,
    };
    await session.save();

    // Cache full data in memory (server-side only)
    setCapabilitiesCache(token, fullCapabilities);

    return Response.json({
      authenticated: true,
      capabilities: fullCapabilities,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Token verification failed";
    return Response.json({ error: message }, { status: 401 });
  }
}

export async function DELETE(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getIronSession<SessionData>(
    await cookies(),
    sessionOptions
  );
  session.destroy();

  return Response.json({ authenticated: false });
}
