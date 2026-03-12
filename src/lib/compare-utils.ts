/**
 * Period-over-period comparison utilities.
 */

/** Returns percentage change, or undefined if previous is 0/undefined. */
export function pctChange(current: number, previous: number | undefined): number | undefined {
  if (previous === undefined || previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

/**
 * Index-based merge of current and previous time series.
 * Adds `prev_<key>` fields from prevSeries[i] into currentSeries[i].
 */
export function mergeComparisonTimeSeries<T extends Record<string, unknown>>(
  currentSeries: T[],
  prevSeries: T[],
  valueKeys: string[],
): T[] {
  return currentSeries.map((point, i) => {
    const prevPoint = prevSeries[i];
    const merged = { ...point } as Record<string, unknown>;
    for (const key of valueKeys) {
      merged[`prev_${key}`] = prevPoint ? prevPoint[key] ?? 0 : 0;
    }
    return merged as T;
  });
}

export interface ComparisonSeriesDef {
  key: string;
  label: string;
  color: string;
  yAxisId?: "left" | "right";
  isDashed?: boolean;
  isComparison?: boolean;
}

/**
 * Generates dashed comparison series definitions from existing series.
 * For each series with key in valueKeys, creates a `prev_<key>` series.
 */
export function makeComparisonSeries(
  currentSeries: ComparisonSeriesDef[],
  valueKeys: string[],
): ComparisonSeriesDef[] {
  const keySet = new Set(valueKeys);
  return currentSeries
    .filter((s) => keySet.has(s.key))
    .map((s): ComparisonSeriesDef => ({
      key: `prev_${s.key}`,
      label: `${s.label} (prev)`,
      color: s.color,
      yAxisId: s.yAxisId,
      isDashed: true,
      isComparison: true,
    }));
}
