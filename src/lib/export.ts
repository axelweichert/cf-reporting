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

export function exportHTML(title: string, accountName?: string | null, zoneName?: string | null) {
  const main = document.querySelector("main");
  if (!main) return;

  const clone = main.cloneNode(true) as HTMLElement;

  // Strip interactive elements that don't belong in a static export
  clone.querySelectorAll("input, button, select, [data-export-hide]").forEach((el) => el.remove());

  // Fix Recharts legend aria-labels that serialize as "[object Object] legend icon"
  clone.querySelectorAll('svg[aria-label*="[object Object]"]').forEach((el) => {
    el.removeAttribute("aria-label");
  });

  // Add "export only" note to pagination indicators
  clone.querySelectorAll("[data-table-pagination]").forEach((el) => {
    const note = document.createElement("p");
    note.className = "text-xs text-zinc-500";
    note.style.marginTop = "0.25rem";
    note.textContent = "Note: Only the currently visible page of data is included in this export.";
    el.parentNode?.insertBefore(note, el.nextSibling);
  });

  // Fix Recharts chart centering: ResponsiveContainer sets fixed pixel widths via
  // inline styles on .recharts-wrapper. Override to width:100% so charts center properly.
  clone.querySelectorAll(".recharts-responsive-container").forEach((el) => {
    (el as HTMLElement).style.width = "100%";
  });
  clone.querySelectorAll(".recharts-wrapper").forEach((el) => {
    const wrapper = el as HTMLElement;
    wrapper.style.width = "100%";
    // Also fix the SVG inside to scale with the container
    const svg = wrapper.querySelector("svg");
    if (svg) {
      const origWidth = svg.getAttribute("width");
      const origHeight = svg.getAttribute("height");
      if (origWidth && origHeight) {
        svg.setAttribute("viewBox", `0 0 ${origWidth} ${origHeight}`);
        svg.setAttribute("width", "100%");
        svg.removeAttribute("height");
        svg.style.maxWidth = "100%";
        svg.style.height = "auto";
      }
    }
  });

  // Grab computed styles from SVG chart elements so they render correctly standalone
  const svgs = clone.querySelectorAll("svg");
  svgs.forEach((svg) => {
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #09090b; color: #fafafa; padding: 2rem; line-height: 1.5;
    }
    h1, h2, h3, h4 { font-weight: 600; }

    /* Layout utilities */
    .space-y-6 > * + * { margin-top: 1.5rem; }
    .space-y-4 > * + * { margin-top: 1rem; }
    .space-y-3 > * + * { margin-top: 0.75rem; }
    .space-y-2 > * + * { margin-top: 0.5rem; }
    .space-y-1 > * + * { margin-top: 0.25rem; }

    /* Grid */
    .grid { display: grid; gap: 1.5rem; }
    .grid-cols-1 { grid-template-columns: 1fr; }
    .grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
    .grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
    @media (min-width: 640px) {
      .sm\\:grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
      .sm\\:grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
      .sm\\:grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
    }
    @media (min-width: 768px) {
      .md\\:grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
    }
    @media (min-width: 1024px) {
      .lg\\:grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
      .lg\\:grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
      .lg\\:grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
      .lg\\:grid-cols-5 { grid-template-columns: repeat(5, 1fr); }
    }
    @media (min-width: 1280px) {
      .xl\\:grid-cols-5 { grid-template-columns: repeat(5, 1fr); }
      .xl\\:grid-cols-6 { grid-template-columns: repeat(6, 1fr); }
      .xl\\:grid-cols-7 { grid-template-columns: repeat(7, 1fr); }
    }
    .col-span-2 { grid-column: span 2 / span 2; }
    .sm\\:col-span-2 { grid-column: span 2 / span 2; }

    /* Cards */
    .rounded-xl { border-radius: 0.75rem; }
    .rounded-lg { border-radius: 0.5rem; }
    .rounded-md { border-radius: 0.375rem; }
    .rounded-full { border-radius: 9999px; }
    .rounded { border-radius: 0.25rem; }
    .border { border-width: 1px; border-style: solid; }
    .border-2 { border-width: 2px; border-style: solid; }
    .border-b { border-bottom-width: 1px; border-bottom-style: solid; }
    .border-zinc-700 { border-color: #3f3f46; }
    .border-zinc-800 { border-color: #27272a; }
    .border-zinc-800\\/50 { border-color: rgba(39,39,42,0.5); }
    .border-blue-500\\/20 { border-color: rgba(59,130,246,0.2); }
    .border-red-500\\/20 { border-color: rgba(239,68,68,0.2); }
    .border-emerald-500\\/20 { border-color: rgba(16,185,129,0.2); }
    .border-yellow-500\\/30 { border-color: rgba(234,179,8,0.3); }
    .border-orange-500\\/20 { border-color: rgba(249,115,22,0.2); }
    .border-t-orange-500 { border-top-color: #f97316; }
    .bg-zinc-700 { background: #3f3f46; }
    .bg-zinc-800 { background: #27272a; }
    .bg-zinc-800\\/50 { background: rgba(39,39,42,0.5); }
    .bg-zinc-900 { background: #18181b; }
    .bg-zinc-900\\/50 { background: rgba(24,24,27,0.5); }
    .bg-zinc-950 { background: #09090b; }
    .bg-blue-500\\/5 { background: rgba(59,130,246,0.05); }
    .bg-blue-500\\/10 { background: rgba(59,130,246,0.1); }
    .bg-red-500\\/10 { background: rgba(239,68,68,0.1); }
    .bg-red-500\\/20 { background: rgba(239,68,68,0.2); }
    .bg-emerald-500\\/10 { background: rgba(16,185,129,0.1); }
    .bg-yellow-500\\/5 { background: rgba(234,179,8,0.05); }
    .bg-orange-500 { background: #f97316; }
    .bg-orange-500\\/10 { background: rgba(249,115,22,0.1); }
    .bg-transparent { background: transparent; }

    /* Spacing */
    .p-1 { padding: 0.25rem; }
    .p-1\\.5 { padding: 0.375rem; }
    .p-2 { padding: 0.5rem; }
    .p-3 { padding: 0.75rem; }
    .p-4 { padding: 1rem; }
    .p-5 { padding: 1.25rem; }
    .p-6 { padding: 1.5rem; }
    .p-8 { padding: 2rem; }
    .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
    .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
    .px-4 { padding-left: 1rem; padding-right: 1rem; }
    .px-5 { padding-left: 1.25rem; padding-right: 1.25rem; }
    .py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
    .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
    .py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; }
    .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
    .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
    .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
    .mt-0\\.5 { margin-top: 0.125rem; }
    .mt-1 { margin-top: 0.25rem; }
    .mt-1\\.5 { margin-top: 0.375rem; }
    .mt-2 { margin-top: 0.5rem; }
    .mt-3 { margin-top: 0.75rem; }
    .mt-4 { margin-top: 1rem; }
    .mb-1 { margin-bottom: 0.25rem; }
    .mb-2 { margin-bottom: 0.5rem; }
    .mb-4 { margin-bottom: 1rem; }
    .ml-2 { margin-left: 0.5rem; }
    .ml-3 { margin-left: 0.75rem; }
    .mr-1 { margin-right: 0.25rem; }
    .mx-1 { margin-left: 0.25rem; margin-right: 0.25rem; }
    .gap-1 { gap: 0.25rem; }
    .gap-1\\.5 { gap: 0.375rem; }
    .gap-2 { gap: 0.5rem; }
    .gap-3 { gap: 0.75rem; }
    .gap-4 { gap: 1rem; }
    .gap-6 { gap: 1.5rem; }
    .gap-x-4 { column-gap: 1rem; }
    .gap-y-1 { row-gap: 0.25rem; }

    /* Text */
    .text-white { color: #fff; }
    .text-zinc-100 { color: #f4f4f5; }
    .text-zinc-200 { color: #e4e4e7; }
    .text-zinc-300 { color: #d4d4d8; }
    .text-zinc-400 { color: #a1a1aa; }
    .text-zinc-500 { color: #71717a; }
    .text-zinc-600 { color: #52525b; }
    .text-blue-300 { color: #93c5fd; }
    .text-blue-400 { color: #60a5fa; }
    .text-red-300 { color: #fca5a5; }
    .text-red-400 { color: #f87171; }
    .text-yellow-300 { color: #fde047; }
    .text-yellow-400 { color: #facc15; }
    .text-orange-400 { color: #fb923c; }
    .text-purple-400 { color: #c084fc; }
    .text-emerald-400 { color: #34d399; }
    .text-3xl { font-size: 1.875rem; }
    .text-2xl { font-size: 1.5rem; }
    .text-xl { font-size: 1.25rem; }
    .text-lg { font-size: 1.125rem; }
    .text-base { font-size: 1rem; }
    .text-sm { font-size: 0.875rem; }
    .text-xs { font-size: 0.75rem; }
    .font-bold { font-weight: 700; }
    .font-semibold { font-weight: 600; }
    .font-medium { font-weight: 500; }
    .font-normal { font-weight: 400; }
    .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .uppercase { text-transform: uppercase; }
    .capitalize { text-transform: capitalize; }
    .tracking-wider { letter-spacing: 0.05em; }
    .leading-relaxed { line-height: 1.625; }

    /* Table */
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 0.5rem 1rem; font-size: 0.75rem; font-weight: 500;
         color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em;
         border-bottom: 1px solid #27272a; }
    td { padding: 0.5rem 1rem; font-size: 0.875rem; color: #e4e4e7;
         border-bottom: 1px solid rgba(39,39,42,0.5); }
    th[style*="text-align: right"], td[style*="text-align: right"] { text-align: right; }

    /* SVG charts */
    svg { max-width: 100%; height: auto; }
    .recharts-wrapper { margin: 0 auto; }

    /* Flex */
    .flex { display: flex; }
    .inline-flex { display: inline-flex; }
    .flex-1 { flex: 1 1 0%; }
    .flex-wrap { flex-wrap: wrap; }
    .items-center { align-items: center; }
    .items-start { align-items: flex-start; }
    .justify-between { justify-content: space-between; }
    .justify-center { justify-content: center; }
    .shrink-0 { flex-shrink: 0; }

    /* Width / Height */
    .w-full { width: 100%; }
    .w-px { width: 1px; }
    .w-2 { width: 0.5rem; }
    .w-3 { width: 0.75rem; }
    .w-4 { width: 1rem; }
    .w-8 { width: 2rem; }
    .w-20 { width: 5rem; }
    .w-24 { width: 6rem; }
    .w-32 { width: 8rem; }
    .w-40 { width: 10rem; }
    .w-44 { width: 11rem; }
    .h-full { height: 100%; }
    .h-2 { height: 0.5rem; }
    .h-3 { height: 0.75rem; }
    .h-4 { height: 1rem; }
    .h-5 { height: 1.25rem; }
    .h-6 { height: 1.5rem; }
    .h-8 { height: 2rem; }
    .h-9 { height: 2.25rem; }
    .h-14 { height: 3.5rem; }
    .min-w-0 { min-width: 0; }
    .max-w-4xl { max-width: 56rem; }

    /* Overflow */
    .overflow-hidden { overflow: hidden; }
    .overflow-x-auto { overflow-x: auto; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Display */
    .block { display: block; }
    .hidden { display: none; }

    /* Position */
    .relative { position: relative; }
    .absolute { position: absolute; }
    .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }

    /* Generated timestamp */
    .export-footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #27272a;
                     font-size: 0.75rem; color: #71717a; text-align: center; }
  </style>
</head>
<body>
  ${clone.innerHTML}
  <div class="export-footer">
    Exported from cf-reporting on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = buildReportFilename(title, "html", { accountName: accountName ?? undefined, zoneName: zoneName ?? undefined });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHTML(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
