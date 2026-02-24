import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { CloudflareClient } from "@/lib/cf-client";
import { NextRequest } from "next/server";

async function getClient(): Promise<CloudflareClient | null> {
  const session = await getIronSession<SessionData>(
    await cookies(),
    sessionOptions
  );

  const token = session.token || process.env.CF_API_TOKEN;
  if (!token) return null;

  return new CloudflareClient(token);
}

// Only allow POST to GraphQL – all other CF API operations are read-only GET
const ALLOWED_POST_PATHS = new Set(["/graphql"]);

function validateOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return null; // Same-origin requests may omit origin
  const originHost = new URL(origin).host;
  if (originHost !== host) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const client = await getClient();
  if (!client) {
    return Response.json(
      { error: "Not authenticated" },
      { status: 401 }
    );
  }

  const { path } = await params;
  const cfPath = `/${path.join("/")}`;
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

  const client = await getClient();
  if (!client) {
    return Response.json(
      { error: "Not authenticated" },
      { status: 401 }
    );
  }

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
    const data = await client.graphql(body.query, body.variables);
    return Response.json(data);
  } catch (error) {
    console.error("CF API POST error:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Upstream API request failed" }, { status: 502 });
  }
}
