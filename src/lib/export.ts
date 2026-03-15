/**
 * Client-side export utilities for report pages.
 * PDF uses server-side Playwright rendering via /api/export/pdf.
 * HTML clones the report content into a standalone downloadable file.
 */

import { buildReportFilename } from "@/lib/report-pages";

interface PdfExportParams {
  pathname: string;
  zone?: string | null;
  account?: string | null;
  timeRange?: string;
  customStart?: string | null;
  customEnd?: string | null;
  zoneName?: string | null;
  accountName?: string | null;
}

/**
 * Generate and download a PDF via the server-side Playwright endpoint.
 * Falls back to window.print() if the API call fails.
 */
export async function exportPDF(params: PdfExportParams): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const body: Record<string, string> = { path: params.pathname };
    if (params.zone) body.zone = params.zone;
    if (params.account) body.account = params.account;
    if (params.timeRange) body.timeRange = params.timeRange;
    if (params.customStart) body.customStart = params.customStart;
    if (params.customEnd) body.customEnd = params.customEnd;
    if (params.zoneName) body.zoneName = params.zoneName;
    if (params.accountName) body.accountName = params.accountName;

    const res = await fetch("/api/export/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "PDF generation failed" }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // Extract filename from Content-Disposition header or generate one
    const disposition = res.headers.get("Content-Disposition");
    let filename = "report.pdf";
    if (disposition) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[PDF Export] Server-side generation failed, falling back to print dialog:", err);
    window.print();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate and download an HTML file via the server-side SingleFile endpoint.
 * Uses the same Playwright + SingleFile pipeline as scheduled email attachments.
 */
export async function exportHTML(params: PdfExportParams): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const body: Record<string, string> = { path: params.pathname };
    if (params.zone) body.zone = params.zone;
    if (params.account) body.account = params.account;
    if (params.timeRange) body.timeRange = params.timeRange;
    if (params.customStart) body.customStart = params.customStart;
    if (params.customEnd) body.customEnd = params.customEnd;
    if (params.zoneName) body.zoneName = params.zoneName;
    if (params.accountName) body.accountName = params.accountName;

    const res = await fetch("/api/export/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "HTML generation failed" }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const disposition = res.headers.get("Content-Disposition");
    let filename = "report.html";
    if (disposition) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("[HTML Export] Server-side generation failed:", err);
  } finally {
    clearTimeout(timeout);
  }
}
