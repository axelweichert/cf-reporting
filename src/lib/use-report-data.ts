"use client";

import { useFilterStore, getPreviousPeriod } from "@/lib/store";
import { useCfData, type ErrorType } from "@/lib/use-cf-data";

interface UseReportDataOptions<T> {
  reportType: string;
  scopeId: string | null;
  since: string;
  until: string;
  /** Fetcher called with (since, until) for both current and previous periods. */
  fetcher: (since: string, until: string) => Promise<T>;
}

interface UseReportDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  errorType: ErrorType;
  refetch: () => void;
  isHistoric: boolean;
  prevData: T | null;
  prevLoading: boolean;
  /** True when comparison is enabled and previous period data is still loading. */
  cmpLoading: boolean;
}

/** Derive ISO prev-period timestamps from current since/until. */
function derivePrevDates(since: string, until: string): { prevSince: string; prevUntil: string } {
  const startDate = since.split("T")[0];
  const endDate = until.split("T")[0];
  const prev = getPreviousPeriod(startDate, endDate);
  return {
    prevSince: `${prev.start}T00:00:00Z`,
    prevUntil: `${prev.end}T00:00:00Z`,
  };
}

async function fetchHistoricData<T>(
  reportType: string,
  scopeId: string,
  since: string,
  until: string,
): Promise<T> {
  const params = new URLSearchParams({ reportType, scopeId, from: since, to: until });
  const res = await fetch(`/api/data/report?${params.toString()}`);

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("No historic data available for this scope and report type. Try switching to Live mode.");
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function useReportData<T>({
  reportType,
  scopeId,
  since,
  until,
  fetcher,
}: UseReportDataOptions<T>): UseReportDataResult<T> {
  const { dataSource, compareEnabled } = useFilterStore();
  const isHistoric = dataSource === "historic";
  const { prevSince, prevUntil } = derivePrevDates(since, until);

  const result = useCfData<T>({
    fetcher: () => {
      if (!scopeId) throw new Error("No scope available");
      if (isHistoric) return fetchHistoricData<T>(reportType, scopeId, since, until);
      return fetcher(since, until);
    },
    deps: [scopeId, since, until, dataSource],
  });

  const prevResult = useCfData<T>({
    fetcher: () => {
      if (!scopeId || !compareEnabled) throw new Error("skip");
      if (isHistoric) return fetchHistoricData<T>(reportType, scopeId, prevSince, prevUntil);
      return fetcher(prevSince, prevUntil);
    },
    deps: [scopeId, prevSince, prevUntil, compareEnabled, dataSource],
  });

  const prevData = compareEnabled ? prevResult.data : null;
  const prevLoading = compareEnabled ? prevResult.loading : false;

  return {
    ...result,
    isHistoric,
    prevData,
    prevLoading,
    cmpLoading: !!(compareEnabled && prevLoading),
  };
}
