/**
 * Next.js instrumentation hook.
 * Runs once when the server starts. Used to initialize the email scheduler
 * and the data collector.
 */

export async function register() {
  // Only run in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initScheduler, initCollector } = await import("@/lib/scheduler");
    initScheduler();
    await initCollector();
  }
}
