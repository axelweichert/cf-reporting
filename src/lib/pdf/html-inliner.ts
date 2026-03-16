/**
 * Self-contained HTML snapshot capture using only Playwright page APIs.
 *
 * Replaces the previously vendored SingleFile (AGPL) library.
 * Runs entirely inside the browser context via page.evaluate():
 *   1. Inlines all <link rel="stylesheet"> as <style> blocks
 *   2. Inlines CSS url() resources (images, fonts) as data URIs
 *   3. Converts <img> src/srcset to base64 data URIs
 *   4. Converts <canvas> elements to inline <img>
 *   5. Removes <script> tags
 *   6. Returns the full serialized HTML
 *
 * MIT-licensed – no external dependencies.
 */

import type { Page } from "playwright";

/**
 * Capture the current page state as a self-contained HTML string.
 * All external resources are inlined as data URIs.
 */
export async function captureInlinedHtml(page: Page): Promise<string> {
  return page.evaluate(async () => {
    // --- Helpers ---

    async function fetchAsDataUri(url: string): Promise<string | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await blobToDataUri(blob);
      } catch {
        return null;
      }
    }

    function blobToDataUri(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    // Match url(...) in CSS, handling quotes and no-quotes
    const CSS_URL_RE = /url\(\s*(['"]?)((?:(?!\1\s*\)).)+)\1\s*\)/g;

    async function inlineCssUrls(cssText: string, baseUrl: string): Promise<string> {
      const replacements: Array<{ match: string; replacement: string }> = [];

      let m: RegExpExecArray | null;
      const re = new RegExp(CSS_URL_RE.source, CSS_URL_RE.flags);
      while ((m = re.exec(cssText)) !== null) {
        const rawUrl = m[2];
        if (rawUrl.startsWith("data:")) continue;

        let resolved: string;
        try {
          resolved = new URL(rawUrl, baseUrl).href;
        } catch {
          continue;
        }

        const dataUri = await fetchAsDataUri(resolved);
        if (dataUri) {
          replacements.push({ match: m[0], replacement: `url("${dataUri}")` });
        }
      }

      let result = cssText;
      for (const { match, replacement } of replacements) {
        result = result.split(match).join(replacement);
      }
      return result;
    }

    // --- 1. Inline <link rel="stylesheet"> ---

    const linkEls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    for (const link of linkEls) {
      const href = (link as HTMLLinkElement).href;
      if (!href) continue;

      try {
        const res = await fetch(href, { credentials: "same-origin" });
        if (!res.ok) continue;
        let cssText = await res.text();
        cssText = await inlineCssUrls(cssText, href);

        const style = document.createElement("style");
        style.textContent = cssText;
        link.parentNode?.replaceChild(style, link);
      } catch {
        // Keep the link tag if fetch fails
      }
    }

    // --- 2. Inline url() in existing <style> blocks ---

    const styleEls = Array.from(document.querySelectorAll("style"));
    for (const style of styleEls) {
      if (style.textContent) {
        style.textContent = await inlineCssUrls(
          style.textContent,
          document.baseURI,
        );
      }
    }

    // --- 3. Inline url() in element style attributes ---

    const styledEls = Array.from(document.querySelectorAll("[style]"));
    for (const el of styledEls) {
      const attr = el.getAttribute("style");
      if (attr && CSS_URL_RE.test(attr)) {
        const inlined = await inlineCssUrls(attr, document.baseURI);
        el.setAttribute("style", inlined);
      }
    }

    // --- 4. Inline <img> src and srcset ---

    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      if (img.src && !img.src.startsWith("data:")) {
        const dataUri = await fetchAsDataUri(img.src);
        if (dataUri) img.src = dataUri;
      }
      if (img.srcset) {
        // Inline each source in the srcset
        const parts = img.srcset.split(",").map((s) => s.trim());
        const inlinedParts: string[] = [];
        for (const part of parts) {
          const [url, descriptor] = part.split(/\s+/);
          if (url.startsWith("data:")) {
            inlinedParts.push(part);
            continue;
          }
          const dataUri = await fetchAsDataUri(url);
          inlinedParts.push(dataUri ? `${dataUri} ${descriptor || ""}`.trim() : part);
        }
        img.srcset = inlinedParts.join(", ");
      }
    }

    // --- 5. Inline SVG <image> href ---

    const svgImages = Array.from(document.querySelectorAll("image"));
    for (const img of svgImages) {
      const href = img.getAttribute("href") || img.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (href && !href.startsWith("data:")) {
        const dataUri = await fetchAsDataUri(href);
        if (dataUri) {
          img.setAttribute("href", dataUri);
          img.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
        }
      }
    }

    // --- 6. Convert <canvas> to <img> ---

    const canvases = Array.from(document.querySelectorAll("canvas"));
    for (const canvas of canvases) {
      try {
        const dataUri = canvas.toDataURL("image/png");
        const img = document.createElement("img");
        img.src = dataUri;
        img.width = canvas.width;
        img.height = canvas.height;
        img.style.cssText = canvas.style.cssText;
        canvas.parentNode?.replaceChild(img, canvas);
      } catch {
        // Canvas may be tainted – skip
      }
    }

    // --- 7. Remove all <script> tags ---

    document.querySelectorAll("script").forEach((s) => s.remove());

    // --- 8. Remove <link> tags that aren't stylesheets (preload, modulepreload, etc.) ---

    document.querySelectorAll('link:not([rel="stylesheet"])').forEach((l) => l.remove());

    // --- 9. Set charset and base ---

    if (!document.querySelector('meta[charset]')) {
      const meta = document.createElement("meta");
      meta.setAttribute("charset", "utf-8");
      document.head.prepend(meta);
    }

    // Remove any <base> tag to avoid broken relative references
    document.querySelectorAll("base").forEach((b) => b.remove());

    // --- 10. Serialize ---

    return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
  });
}
