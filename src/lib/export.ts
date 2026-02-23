/**
 * Client-side export utilities for report pages.
 * PDF uses the browser's native print dialog (Save as PDF).
 * HTML clones the report content into a standalone downloadable file.
 */

export function exportPDF() {
  window.print();
}

export function exportHTML(title: string) {
  const main = document.querySelector("main");
  if (!main) return;

  const clone = main.cloneNode(true) as HTMLElement;

  // Strip interactive elements that don't belong in a static export
  clone.querySelectorAll("input, button, [data-export-hide]").forEach((el) => el.remove());

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
    .space-y-2 > * + * { margin-top: 0.5rem; }

    /* Grid */
    .grid { display: grid; gap: 1.5rem; }
    .grid-cols-1 { grid-template-columns: 1fr; }
    @media (min-width: 640px) {
      .sm\\:grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
    }
    @media (min-width: 1024px) {
      .lg\\:grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
      .lg\\:grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
      .lg\\:grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
    }

    /* Cards */
    .rounded-xl { border-radius: 0.75rem; }
    .rounded-lg { border-radius: 0.5rem; }
    .border { border-width: 1px; border-style: solid; }
    .border-zinc-800 { border-color: #27272a; }
    .border-zinc-800\\/50 { border-color: rgba(39,39,42,0.5); }
    .bg-zinc-900 { background: #18181b; }
    .bg-zinc-900\\/50 { background: rgba(24,24,27,0.5); }
    .bg-zinc-950 { background: #09090b; }
    .p-4 { padding: 1rem; }
    .p-5 { padding: 1.25rem; }
    .p-6 { padding: 1.5rem; }
    .px-4 { padding-left: 1rem; padding-right: 1rem; }
    .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
    .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
    .gap-4 { gap: 1rem; }
    .gap-6 { gap: 1.5rem; }

    /* Text */
    .text-white { color: #fff; }
    .text-zinc-100 { color: #f4f4f5; }
    .text-zinc-200 { color: #e4e4e7; }
    .text-zinc-300 { color: #d4d4d8; }
    .text-zinc-400 { color: #a1a1aa; }
    .text-zinc-500 { color: #71717a; }
    .text-2xl { font-size: 1.5rem; }
    .text-xl { font-size: 1.25rem; }
    .text-sm { font-size: 0.875rem; }
    .text-xs { font-size: 0.75rem; }
    .font-bold { font-weight: 700; }
    .font-medium { font-weight: 500; }
    .font-semibold { font-weight: 600; }

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
    .items-center { align-items: center; }
    .justify-between { justify-content: space-between; }

    /* Generated timestamp */
    .export-footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #27272a;
                     font-size: 0.75rem; color: #71717a; text-align: center; }
  </style>
</head>
<body>
  ${clone.innerHTML}
  <div class="export-footer">
    Exported from CF Reporting on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").toLowerCase()}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHTML(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
