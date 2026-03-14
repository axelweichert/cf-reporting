/**
 * API Shield report email template.
 */

import type { ApiShieldData } from "@/lib/queries/api-shield";
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

export function renderApiShieldEmail(data: ApiShieldData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("API Shield Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Managed Endpoints", value: formatNum(data.stats.totalManaged) },
      { label: "Discovered Endpoints", value: formatNum(data.stats.totalDiscovered) },
      { label: "In Review", value: formatNum(data.stats.discoveredInReview), color: data.stats.discoveredInReview > 0 ? "#eab308" : "#10b981" },
      { label: "Avg Reqs/Hour", value: String(data.stats.avgRequestsPerHour) },
    ]),

    spacer(4),

    // Method distribution bar chart
    data.methodDistribution.length > 0
      ? barChart(
          data.methodDistribution.map((m) => ({
            label: m.method,
            value: m.count,
          })),
          "Method Distribution"
        )
      : "",

    spacer(),

    // Top endpoint traffic table
    data.topEndpointTraffic.length > 0
      ? (() => {
          const title = sectionTitle("Top Endpoint Traffic");
          const table = dataTable(
            [
              { label: "Endpoint" },
              { label: "Requests", align: "right" as const },
              { label: "2xx", align: "right" as const },
              { label: "4xx", align: "right" as const },
              { label: "5xx", align: "right" as const },
            ],
            data.topEndpointTraffic.slice(0, 10).map((e) => [
              escapeHtml(e.endpointPath),
              formatNum(e.requests),
              formatNum(e.status2xx),
              formatNum(e.status4xx),
              formatNum(e.status5xx),
            ]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`API Shield Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
