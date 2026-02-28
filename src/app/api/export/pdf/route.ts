import { NextRequest } from "next/server";
import { requireAuth, validateOrigin } from "@/lib/auth-helpers";
import { generatePdf } from "@/lib/pdf/browser-pool";
import { PAGE_TITLES } from "@/lib/report-pages";

interface PdfRequest {
  path: string;
  zone?: string;
  account?: string;
  timeRange?: string;
  customStart?: string;
  customEnd?: string;
  zoneName?: string;
  accountName?: string;
}

/** Valid report paths that can be exported as PDF */
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

  let body: PdfRequest;
  try {
    body = (await request.json()) as PdfRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate the requested path (must be a known exportable route, no query strings)
  const { path } = body;
  if (!path || typeof path !== "string" || path.includes("?") || !EXPORTABLE_PATHS.has(path)) {
    return Response.json(
      { error: "Invalid or non-exportable report path" },
      { status: 400 }
    );
  }

  // Extract session cookie from the incoming request
  const sessionCookie = request.cookies.get("cf-reporting-session")?.value;
  if (!sessionCookie) {
    return Response.json({ error: "Session cookie missing" }, { status: 401 });
  }

  // Build the internal URL with filter params
  const port = process.env.PORT || "3000";
  const internalUrl = new URL(
    path,
    `http://localhost:${port}`
  );
  internalUrl.searchParams.set("_pdf", "true");
  if (body.zone) internalUrl.searchParams.set("zone", body.zone);
  if (body.account) internalUrl.searchParams.set("account", body.account);
  if (body.timeRange) internalUrl.searchParams.set("timeRange", body.timeRange);
  if (body.customStart) internalUrl.searchParams.set("customStart", body.customStart);
  if (body.customEnd) internalUrl.searchParams.set("customEnd", body.customEnd);

  const title = PAGE_TITLES[path] || "Report";

  try {
    const pdfBuffer = await generatePdf({
      url: internalUrl.toString(),
      sessionCookie,
      title,
    });

    // Build a descriptive filename: report-account-zone-date.pdf
    const dateStr = new Date().toISOString().split("T")[0];
    const parts = [title];
    if (body.accountName) parts.push(body.accountName);
    if (body.zoneName) parts.push(body.zoneName);
    parts.push(dateStr);
    const filename = parts
      .join(" ")
      .replace(/[^a-zA-Z0-9 .-]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase() + ".pdf";

    return new Response(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "PDF generation failed";
    console.error("[PDF Export]", raw);
    // Return a safe error message (don't leak internal paths or URLs)
    const isConcurrency = raw.includes("Too many concurrent");
    const safeMessage = isConcurrency
      ? raw
      : "PDF generation failed. Please try again.";
    return Response.json({ error: safeMessage }, { status: isConcurrency ? 429 : 500 });
  }
}
