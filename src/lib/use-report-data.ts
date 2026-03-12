"use client";

import { useFilterStore } from "@/lib/store";
import { useCfData, type ErrorType } from "@/lib/use-cf-data";

interface UseReportDataOptions<T> {
  reportType: string;
  scopeId: string | null;
  since: string;
  until: string;
  liveFetcher: () => Promise<T>;
}

interface UseReportDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  errorType: ErrorType;
  refetch: () => void;
  isHistoric: boolean;
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
}: UseReportDataOptions<T>): UseReportDataResult<T> {
  const { dataSource } = useFilterStore();
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

  return { ...result, isHistoric };
}
