import type { Browser, BrowserContext, Page } from "playwright";

/** Maximum concurrent render operations */
const MAX_CONCURRENT = 3;
/** Timeout per render operation (ms) */
const RENDER_TIMEOUT = 30_000;
/** Viewport width for initial page load (desktop layout to trigger data fetching) */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;
/** A4 content width at 96dpi: 210mm - 2×10mm margins = 190mm ≈ 718px */
const A4_CONTENT_WIDTH = 718;

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let activeRenderCount = 0;

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

export interface RenderOptions {
  /** Internal URL to render (e.g. http://localhost:3000/security?_pdf=true) */
  url: string;
  /** Session cookie value to forward for authentication */
  sessionCookie: string;
  /** Report title */
  title?: string;
  /** Account name for document title */
  accountName?: string;
  /** Zone name for document title */
  zoneName?: string;
}

/**
 * Shared page preparation: navigate, wait for data, apply light theme,
 * resize for export, and clean up interactive elements.
 */
async function preparePage(page: Page, opts: RenderOptions): Promise<void> {
  page.setDefaultTimeout(RENDER_TIMEOUT);

  // Navigate and wait for network to settle
  await page.goto(opts.url, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT });

  // Wait for skeleton loaders to disappear
  await page
    .waitForSelector(".animate-pulse", { state: "hidden", timeout: 10_000 })
    .catch(() => { /* no skeletons – fine */ });

  // Wait for at least one chart or stat card to be visible
  await page
    .waitForSelector(".recharts-wrapper, [data-stat-card]", {
      state: "visible",
      timeout: 10_000,
    })
    .catch(() => { /* page might not have charts */ });

  // Small extra delay for animations to finish
  await page.waitForTimeout(500);

  await page.emulateMedia({ media: "screen" });

  // Apply light theme + set document title
  const docTitleParts = [opts.title || "Report"];
  if (opts.accountName) docTitleParts.push(opts.accountName);
  if (opts.zoneName) docTitleParts.push(opts.zoneName);
  const docTitle = docTitleParts.join(" \u2013 ");

  await page.evaluate((dt: string) => {
    document.documentElement.classList.add("light");
    document.title = dt;
  }, docTitle);

  // Resize viewport to A4 content width so ResponsiveContainer fits charts
  await page.setViewportSize({ width: A4_CONTENT_WIDTH, height: VIEWPORT_HEIGHT });

  // Wait for ResponsiveContainer to re-measure and React to re-render
  await page.waitForTimeout(1000);

  // Clean up elements and apply export-specific layout fixes
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
    // Remove Next.js dev indicator
    document
      .querySelectorAll("nextjs-portal, [data-nextjs-dialog-overlay], [data-nextjs-toast]")
      .forEach((el) => el.remove());

    // Prevent page breaks from splitting charts
    document
      .querySelectorAll(".rounded-xl, .rounded-lg")
      .forEach((el) => {
        const h = el as HTMLElement;
        h.style.breakInside = "avoid";
        h.style.pageBreakInside = "avoid";
      });
  });

  // Freeze chart layout: disable ResizeObserver so subsequent layout
  // passes don't trigger ResponsiveContainer to re-render charts.
  await page.evaluate(() => {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
}

/**
 * Run a render operation with concurrency limiting and browser context lifecycle.
 */
async function withRenderContext<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  if (activeRenderCount >= MAX_CONCURRENT) {
    throw new Error("Too many concurrent report generations. Please try again.");
  }

  activeRenderCount++;
  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    activeRenderCount--;
    if (context) {
      await context.close().catch(() => { /* best-effort cleanup */ });
    }
  }
}

/**
 * Generate a PDF by navigating headless Chromium to an internal page.
 * Returns the PDF as a Buffer.
 */
export async function generatePdf(opts: RenderOptions): Promise<Buffer> {
  return withRenderContext(async (page, context) => {
    // Set the session cookie so the internal request is authenticated
    const cookieUrl = new URL(opts.url);
    await context.addCookies([
      {
        name: "cf-reporting-session",
        value: opts.sessionCookie,
        domain: cookieUrl.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await preparePage(page, opts);

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
      headerTemplate: opts.title
        ? `<div style="font-size:9px; color:#666; width:100%; text-align:center; padding:0 1cm;">${escapeHtml(opts.title)}</div>`
        : "<span></span>",
      footerTemplate: `<div style="font-size:8px; color:#999; width:100%; display:flex; justify-content:space-between; padding:0 1cm;">
        <span>Generated ${timestamp}</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`,
      displayHeaderFooter: true,
    });

    return pdfBuffer;
  });
}

/**
 * Generate a standalone HTML file by navigating headless Chromium to an internal page.
 * Captures the fully-rendered DOM with all computed styles inlined.
 * Returns the HTML as a Buffer.
 */
export async function generateHtml(opts: RenderOptions): Promise<Buffer> {
  return withRenderContext(async (page, context) => {
    const cookieUrl = new URL(opts.url);
    await context.addCookies([
      {
        name: "cf-reporting-session",
        value: opts.sessionCookie,
        domain: cookieUrl.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await preparePage(page, opts);

    // Capture the fully-rendered page as standalone HTML.
    // Keep SVGs and chart elements exactly as Playwright rendered them –
    // the fixed pixel widths from the A4 viewport are correct.
    const htmlContent = await page.evaluate(() => {
      // Ensure only light theme is active
      document.documentElement.classList.remove("dark");

      // Ensure all SVGs have xmlns for standalone rendering
      document.querySelectorAll("svg").forEach((svg) => {
        svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      });

      // Collect all stylesheets into inline <style> blocks
      const styles: string[] = [];
      for (const sheet of document.styleSheets) {
        try {
          const rules = Array.from(sheet.cssRules)
            .map((r) => r.cssText)
            // Strip @font-face rules with relative URLs that won't resolve
            .filter((r) => !r.startsWith("@font-face"))
            .join("\n");
          styles.push(rules);
        } catch {
          // Cross-origin stylesheets can't be read – skip
        }
      }

      // Remove script tags (React hydration, Next.js chunks)
      document.querySelectorAll("script, link[rel=preload], link[rel=modulepreload]").forEach((el) => el.remove());

      // Remove existing <link rel="stylesheet"> since we inlined them
      document.querySelectorAll('link[rel="stylesheet"]').forEach((el) => el.remove());

      // Inject inlined styles + system font fallback
      const styleEl = document.createElement("style");
      styleEl.textContent = `
        :root { --font-geist-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; --font-geist-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
        ${styles.join("\n")}
      `;
      document.head.appendChild(styleEl);

      // Add export footer
      const footer = document.createElement("div");
      footer.style.cssText = "margin-top:3rem;padding-top:1rem;border-top:1px solid #e4e4e7;font-size:0.75rem;color:#71717a;text-align:center;";
      footer.textContent = `Exported from cf-reporting on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      document.body.appendChild(footer);

      return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
    });

    return Buffer.from(htmlContent, "utf-8");
  });
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
