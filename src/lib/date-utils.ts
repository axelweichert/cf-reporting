/**
 * Pure date-range utility – shared between browser and server code.
 */

/** Split a date range into daily chunks to avoid GraphQL limit truncation. */
export function splitDateRange(since: string, until: string): Array<{ since: string; until: string }> {
  const start = new Date(since);
  const end = new Date(until);
  const chunks: Array<{ since: string; until: string }> = [];

  const current = new Date(start);
  while (current < end) {
    const chunkEnd = new Date(current);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      since: current.toISOString(),
      until: chunkEnd.toISOString(),
    });

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return chunks;
}
