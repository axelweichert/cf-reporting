/**
 * Server-side date range utilities.
 * Mirrors getDateRange from store.ts but works without React context.
 */

export function getDateRange(timeRange: string): { start: string; end: string } {
  const end = new Date();
  const start = new Date();

  switch (timeRange) {
    case "1d":
      start.setDate(start.getDate() - 1);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    case "7d":
    default:
      start.setDate(start.getDate() - 7);
      break;
  }

  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}
