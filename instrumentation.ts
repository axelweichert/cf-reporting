/**
 * Next.js instrumentation hook.
 * Runs once when the server starts. Used to initialize the email scheduler.
 */

export async function register() {
  // Only run in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initScheduler } = await import("@/lib/scheduler");
    initScheduler();
  }
}
