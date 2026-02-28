import type { Browser, BrowserContext } from "playwright";

/** Maximum concurrent PDF generations */
const MAX_CONCURRENT = 3;
/** Timeout per PDF generation (ms) */
const PDF_TIMEOUT = 30_000;
/** Viewport width for initial page load (desktop layout to trigger data fetching) */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;
/** A4 content width at 96dpi: 210mm - 2×10mm margins = 190mm ≈ 718px */
const A4_CONTENT_WIDTH = 718;

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let activePdfCount = 0;

/**
 * Get or launch a singleton Chromium browser instance.
 * Reuses the same browser across requests; auto-recovers from crashes.
 */
async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    try {
      const { chromium } = await import("playwright");

      const executablePath =
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

      const browser = await chromium.launch({
        executablePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      browser.on("disconnected", () => {
        browserInstance = null;
        browserLaunchPromise = null;
      });

      browserInstance = browser;
      return browser;
    } finally {
      // Always clear the launch promise so retries are possible on failure
      browserLaunchPromise = null;
    }
  })();

  return browserLaunchPromise;
}

interface PdfOptions {
  /** Internal URL to render (e.g. http://localhost:3000/security?_pdf=true) */
  url: string;
  /** Session cookie value to forward for authentication */
  sessionCookie: string;
  /** Report title for the PDF header */
  title?: string;
  /** Account name for PDF document title */
  accountName?: string;
  /** Zone name for PDF document title */
  zoneName?: string;
}

/**
 * Generate a PDF by navigating headless Chromium to an internal page.
 * Returns the PDF as a Buffer.
 */
export async function generatePdf({
  url,
  sessionCookie,
  title,
  accountName,
  zoneName,
}: PdfOptions): Promise<Buffer> {
  if (activePdfCount >= MAX_CONCURRENT) {
    throw new Error("Too many concurrent PDF generations. Please try again.");
  }

  activePdfCount++;
  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });

    // Set the session cookie so the internal request is authenticated
    const cookieUrl = new URL(url);
    await context.addCookies([
      {
        name: "cf-reporting-session",
        value: sessionCookie,
        domain: cookieUrl.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    page.setDefaultTimeout(PDF_TIMEOUT);

    // Navigate and wait for network to settle
    await page.goto(url, { waitUntil: "networkidle", timeout: PDF_TIMEOUT });

    // Wait for skeleton loaders to disappear
    await page
      .waitForSelector(".animate-pulse", { state: "hidden", timeout: 10_000 })
      .catch(() => {
        /* no skeletons — fine */
      });

    // Wait for at least one chart or stat card to be visible
    await page
      .waitForSelector(".recharts-wrapper, [data-stat-card]", {
        state: "visible",
        timeout: 10_000,
      })
      .catch(() => {
        /* page might not have charts */
      });

    // Small extra delay for animations to finish
    await page.waitForTimeout(500);

    // --- PDF rendering strategy ---
    // Problem: @media print causes Recharts' ResponsiveContainer to collapse
    // to width: 0, rendering all charts invisible.
    // Solution: Use screen media + resize viewport to A4 content width.
    // ResponsiveContainer re-measures and sizes charts to fit the PDF page.
    await page.emulateMedia({ media: "screen" });

    // Apply light theme for PDF (white background, dark text)
    // Build a descriptive document title for the PDF tab/viewer
    const docTitleParts = [title || "Report"];
    if (accountName) docTitleParts.push(accountName);
    if (zoneName) docTitleParts.push(zoneName);
    const docTitle = docTitleParts.join(" – ");

    await page.evaluate((dt: string) => {
      document.documentElement.classList.add("light");
      document.title = dt;
    }, docTitle);

    // Resize viewport to A4 content width so ResponsiveContainer fits charts
    await page.setViewportSize({ width: A4_CONTENT_WIDTH, height: VIEWPORT_HEIGHT });

    // Wait for ResponsiveContainer to re-measure and React to re-render
    await page.waitForTimeout(1000);

    // Clean up elements and apply PDF-specific layout fixes
    await page.evaluate(() => {
      // Hide interactive elements
      document.querySelectorAll("button, select, input").forEach((el) => {
        (el as HTMLElement).style.display = "none";
      });
      document
        .querySelectorAll("[data-table-search], [data-table-pagination]")
        .forEach((el) => {
          (el as HTMLElement).style.display = "none";
        });
      // Hide Recharts tooltip wrappers (can appear as artifacts)
      document
        .querySelectorAll(".recharts-tooltip-wrapper")
        .forEach((el) => {
          (el as HTMLElement).style.display = "none";
        });
      // Remove Next.js dev indicator (dark circle with "N" in dev mode)
      document
        .querySelectorAll("nextjs-portal, [data-nextjs-dialog-overlay], [data-nextjs-toast]")
        .forEach((el) => el.remove());

      // Prevent page breaks from splitting charts — keep each card together
      document
        .querySelectorAll(".rounded-xl, .rounded-lg")
        .forEach((el) => {
          const h = el as HTMLElement;
          h.style.breakInside = "avoid";
          h.style.pageBreakInside = "avoid";
        });

    });

    // Freeze chart layout: disable ResizeObserver so that page.pdf()'s
    // internal print layout pass doesn't trigger ResponsiveContainer
    // to re-render charts at a different size (which breaks pie arcs).
    await page.evaluate(() => {
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    });

    const now = new Date();
    const timestamp = now.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "1cm", right: "1cm", bottom: "1.5cm", left: "1cm" },
      headerTemplate: title
        ? `<div style="font-size:9px; color:#666; width:100%; text-align:center; padding:0 1cm;">${escapeHtml(title)}</div>`
        : "<span></span>",
      footerTemplate: `<div style="font-size:8px; color:#999; width:100%; display:flex; justify-content:space-between; padding:0 1cm;">
        <span>Generated ${timestamp}</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`,
      displayHeaderFooter: true,
    });

    return pdfBuffer;
  } finally {
    activePdfCount--;
    if (context) {
      await context.close().catch(() => {
        /* best-effort cleanup */
      });
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shut down the browser (for graceful shutdown). */
export async function closeBrowser(): Promise<void> {
  if (browserInstance?.isConnected()) {
    await browserInstance.close();
    browserInstance = null;
  }
}
