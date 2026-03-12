"use client";

import { useFilterStore } from "@/lib/store";
import { useCfData, type ErrorType } from "@/lib/use-cf-data";

interface UseReportDataOptions<T> {
  reportType: string;
  scopeId: string | null;
  since: string;
  until: string;
  liveFetcher: () => Promise<T>;
  prevSince?: string;
  prevUntil?: string;
  prevLiveFetcher?: () => Promise<T>;
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
  liveFetcher,
  prevSince,
  prevUntil,
  prevLiveFetcher,
}: UseReportDataOptions<T>): UseReportDataResult<T> {
  const { dataSource, compareEnabled } = useFilterStore();
  const isHistoric = dataSource === "historic";

  const result = useCfData<T>({
    fetcher: () => {
      if (!scopeId) throw new Error("No scope available");

      if (isHistoric) {
        return fetchHistoricData<T>(reportType, scopeId, since, until);
      }

      return liveFetcher();
    },
    deps: [scopeId, since, until, dataSource],
  });

  const prevResult = useCfData<T>({
    fetcher: () => {
      if (!scopeId || !compareEnabled) throw new Error("skip");

      if (isHistoric && prevSince && prevUntil) {
        return fetchHistoricData<T>(reportType, scopeId, prevSince, prevUntil);
      }

      if (prevLiveFetcher) return prevLiveFetcher();
      throw new Error("skip");
    },
    deps: [scopeId, prevSince, prevUntil, compareEnabled, dataSource],
  });

  return {
    ...result,
    isHistoric,
    prevData: compareEnabled ? prevResult.data : null,
    prevLoading: compareEnabled ? prevResult.loading : false,
  };
}
