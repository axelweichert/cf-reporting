/**
 * Next.js instrumentation hook.
 * Runs once when the server starts. Used to initialize the email scheduler
 * and the data collector.
 */

function validateManagedMode(): void {
  const hasEnvToken = !!(process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN);
  if (!hasEnvToken) return; // Explore mode – no validation needed

  if (!process.env.APP_PASSWORD) {
    throw new Error(
      "[startup] APP_PASSWORD is required when CF_API_TOKEN or CF_ACCOUNT_TOKEN is set. " +
      "Without it, anyone can access the app and the configured Cloudflare token.",
    );
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32 || sessionSecret === "change-me-to-a-random-string") {
    throw new Error(
      "[startup] SESSION_SECRET must be set to a random string of at least 32 characters " +
      "when running in managed mode. Generate one with: openssl rand -hex 32",
    );
  }

  // Check for partial SMTP configuration (var names match smtp-client.ts)
  const smtpVars = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };
  const setVars = Object.entries(smtpVars).filter(([, v]) => !!v);
  if (setVars.length > 0 && setVars.length < 3) {
    const missing = Object.entries(smtpVars).filter(([, v]) => !v).map(([k]) => k);
    throw new Error(
      `[startup] Partial SMTP configuration detected. Set all of SMTP_HOST, SMTP_USER, and SMTP_PASS, ` +
      `or none of them. Missing: ${missing.join(", ")}`,
    );
  }

  if (process.env.SECURE_COOKIES === "true") {
    console.log("[startup] SECURE_COOKIES=true – ensure the app is served over HTTPS");
  }
}

export async function register() {
  // Only run in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Catch unhandled errors to prevent silent worker crashes
    process.on("unhandledRejection", (reason) => {
      console.error("[instrumentation] Unhandled rejection:", reason);
    });
    process.on("uncaughtException", (err) => {
      console.error("[instrumentation] Uncaught exception:", err);
    });

    validateManagedMode();

    const { initScheduler, initCollector } = await import("@/lib/scheduler");
    initScheduler();
    await initCollector();
  }
}
