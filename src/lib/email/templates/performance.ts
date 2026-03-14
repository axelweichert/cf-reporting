/**
 * Performance report email template.
 */

import type { PerformanceData } from "@/lib/queries/performance";
import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
  barChart,
  spacer,
  escapeHtml,
  formatNum,
} from "./base";

interface ReportMeta {
  zoneName: string;
  startDate: string;
  endDate: string;
  dashboardUrl?: string;
}

export function renderPerformanceEmail(data: PerformanceData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("Performance Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Total Requests", value: formatNum(data.stats.totalRequests) },
      { label: "Avg TTFB", value: `${data.stats.avgTtfb}ms` },
      { label: "P95 TTFB", value: `${data.stats.p95Ttfb}ms`, color: data.stats.p95Ttfb > 1000 ? "#ef4444" : data.stats.p95Ttfb > 500 ? "#eab308" : "#10b981" },
      { label: "Avg Origin Time", value: `${data.stats.avgOriginTime}ms` },
    ]),

    spacer(4),

    // Content type performance table
    data.contentTypePerf.length > 0
      ? (() => {
          const title = sectionTitle("Content Type Performance");
          const table = dataTable(
            [
              { label: "Content Type" },
              { label: "Requests", align: "right" as const },
              { label: "Avg TTFB", align: "right" as const },
              { label: "Avg Origin", align: "right" as const },
            ],
            data.contentTypePerf.slice(0, 10).map((c) => [
              escapeHtml(c.contentType),
              formatNum(c.requests),
              `${c.avgTtfb}ms`,
              `${c.avgOriginTime}ms`,
            ]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Country performance table
    data.countryPerf.length > 0
      ? (() => {
          const title = sectionTitle("Country Performance");
          const table = dataTable(
            [
              { label: "Country" },
              { label: "Requests", align: "right" as const },
              { label: "Avg TTFB", align: "right" as const },
              { label: "Avg Origin", align: "right" as const },
            ],
            data.countryPerf.slice(0, 10).map((c) => [
              escapeHtml(c.country),
              formatNum(c.requests),
              `${c.avgTtfb}ms`,
              `${c.avgOriginTime}ms`,
            ]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Protocol distribution bar chart
    data.protocolDistribution.length > 0
      ? barChart(
          data.protocolDistribution.map((p) => ({
            label: p.protocol,
            value: p.requests,
          })),
          "Protocol Distribution"
        )
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`Performance Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
