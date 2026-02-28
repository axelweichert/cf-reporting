import type { Browser, BrowserContext } from "playwright";

/** Maximum concurrent PDF generations */
const MAX_CONCURRENT = 3;
/** Timeout per PDF generation (ms) */
const PDF_TIMEOUT = 30_000;
/** Viewport width for consistent chart rendering (matches typical desktop) */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;

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
}

/**
 * Generate a PDF by navigating headless Chromium to an internal page.
 * Returns the PDF as a Buffer.
 */
export async function generatePdf({
  url,
  sessionCookie,
  title,
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

    return Buffer.from(pdfBuffer);
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
