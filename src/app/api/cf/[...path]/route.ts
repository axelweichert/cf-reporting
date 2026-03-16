import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { CloudflareClient } from "@/lib/cf-client";
import { validateOrigin, getSessionRole } from "@/lib/auth-helpers";
import { validateViewerGraphQL, validateViewerRestPath } from "@/lib/cf-viewer-guard";
import { NextRequest } from "next/server";
import type { UserRole } from "@/types/cloudflare";

interface ClientResult {
  client: CloudflareClient;
  role: UserRole;
}

async function getClient(): Promise<ClientResult | null> {
  const session = await getIronSession<SessionData>(
    await cookies(),
    sessionOptions
  );

  // Enforce site auth gate (APP_PASSWORD or env tokens present)
  const hasEnvToken = !!(process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN);
  if ((process.env.APP_PASSWORD || hasEnvToken) && !session.siteAuthenticated) return null;

  const token = session.token || process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN;
  if (!token) return null;

  return { client: new CloudflareClient(token), role: getSessionRole(session) };
}

// Only allow POST to GraphQL – all other CF API operations are read-only GET
const ALLOWED_POST_PATHS = new Set(["/graphql"]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const result = await getClient();
  if (!result) {
    return Response.json(
      { error: "Not authenticated" },
      { status: 401 }
    );
  }

  const { client, role } = result;
  const { path } = await params;
  const cfPath = `/${path.join("/")}`;

  // Viewer guard: only allowlisted REST paths
  if (role === "viewer") {
    const err = validateViewerRestPath(cfPath);
    if (err) {
      return Response.json({ error: `Forbidden: ${err}` }, { status: 403 });
    }
  }

  const searchParams = request.nextUrl.searchParams.toString();
  const fullPath = searchParams ? `${cfPath}?${searchParams}` : cfPath;

  try {
    const data = await client.rest(fullPath);
    // Preserve upstream error status for permission detection (e.g. 403)
    if (!data.success && data._httpStatus && data._httpStatus >= 400) {
      const { _httpStatus, ...responseBody } = data;
      return Response.json(responseBody, { status: _httpStatus });
    }
    return Response.json(data);
  } catch (error) {
    console.error("CF API GET error:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Upstream API request failed" }, { status: 502 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const result = await getClient();
  if (!result) {
    return Response.json(
      { error: "Not authenticated" },
      { status: 401 }
    );
  }

  const { client, role } = result;
  const { path } = await params;
  const cfPath = `/${path.join("/")}`;

  if (!ALLOWED_POST_PATHS.has(cfPath)) {
    return Response.json(
      { error: "POST not allowed for this path" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();

    // Viewer guard: validate GraphQL query against dataset allowlist
    if (role === "viewer") {
      const err = validateViewerGraphQL(body.query);
      if (err) {
        return Response.json({ error: `Forbidden: ${err}` }, { status: 403 });
      }
    }

    const data = await client.graphql(body.query, body.variables);
    return Response.json(data);
  } catch (error) {
    console.error("CF API POST error:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Upstream API request failed" }, { status: 502 });
  }
}
