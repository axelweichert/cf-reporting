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
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "API request failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

export async function POST(
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

  // Special handling for GraphQL
  if (cfPath === "/graphql") {
    try {
      const body = await request.json();
      const data = await client.graphql(body.query, body.variables);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "GraphQL request failed";
      return Response.json({ error: message }, { status: 502 });
    }
  }

  try {
    const body = await request.json();
    const data = await client.rest(cfPath, { method: "POST", body });
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "API request failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
