import { NextRequest } from "next/server";
import { requireAuth, validateOrigin } from "@/lib/auth-helpers";
import { generateHtml } from "@/lib/pdf/browser-pool";
import { PAGE_TITLES, buildReportFilename } from "@/lib/report-pages";

interface HtmlRequest {
  path: string;
  zone?: string;
  account?: string;
  timeRange?: string;
  customStart?: string;
  customEnd?: string;
  zoneName?: string;
  accountName?: string;
}

/** Valid report paths that can be exported as HTML */
const EXPORTABLE_PATHS = new Set(
  Object.keys(PAGE_TITLES).filter(
    (p) => p !== "/settings" && p !== "/login" && p !== "/dashboard"
  )
);

export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const auth = await requireAuth();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: HtmlRequest;
  try {
    body = (await request.json()) as HtmlRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { path } = body;
  if (!path || typeof path !== "string" || path.includes("?") || !EXPORTABLE_PATHS.has(path)) {
    return Response.json(
      { error: "Invalid or non-exportable report path" },
      { status: 400 }
    );
  }

  const sessionCookie = request.cookies.get("cf-reporting-session")?.value;
  if (!sessionCookie) {
    return Response.json({ error: "Session cookie missing" }, { status: 401 });
  }

  const port = process.env.PORT || "3000";
  const internalUrl = new URL(path, `http://localhost:${port}`);
  internalUrl.searchParams.set("_pdf", "true");
  if (body.zone) internalUrl.searchParams.set("zone", body.zone);
  if (body.account) internalUrl.searchParams.set("account", body.account);
  if (body.timeRange) internalUrl.searchParams.set("timeRange", body.timeRange);
  if (body.customStart) internalUrl.searchParams.set("customStart", body.customStart);
  if (body.customEnd) internalUrl.searchParams.set("customEnd", body.customEnd);

  const title = PAGE_TITLES[path] || "Report";

  try {
    const htmlBuffer = await generateHtml({
      url: internalUrl.toString(),
      sessionCookie,
      title,
      accountName: body.accountName,
      zoneName: body.zoneName,
    });

    const filename = buildReportFilename(title, "html", {
      zoneName: body.zoneName,
      accountName: body.accountName,
    });

    return new Response(new Uint8Array(htmlBuffer), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(htmlBuffer.length),
      },
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "HTML generation failed";
    console.error("[HTML Export]", raw);
    const isConcurrency = raw.includes("Too many concurrent");
    const safeMessage = isConcurrency
      ? raw
      : "HTML generation failed. Please try again.";
    return Response.json({ error: safeMessage }, { status: isConcurrency ? 429 : 500 });
  }
}
