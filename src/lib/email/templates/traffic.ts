/**
 * Traffic report email template.
 */

import type { TrafficData } from "@/lib/queries/traffic";
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
  formatBytes,
} from "./base";

interface ReportMeta {
  zoneName: string;
  startDate: string;
  endDate: string;
  dashboardUrl?: string;
}

export function renderTrafficEmail(data: TrafficData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const totalErrors = data.statusCodes
    .filter((s) => s.name === "4xx" || s.name === "5xx")
    .reduce((sum, s) => sum + s.value, 0);
  const errorRate = data.totalRequests > 0
    ? ((totalErrors / data.totalRequests) * 100).toFixed(2)
    : "0.00";

  const content = [
    emailHeader("Traffic Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Total Requests", value: formatNum(data.totalRequests) },
      { label: "Bandwidth", value: formatBytes(data.totalBandwidth) },
      { label: "Cache Hit Ratio", value: `${data.cache.ratio.toFixed(1)}%`, color: data.cache.ratio >= 80 ? "#10b981" : data.cache.ratio >= 50 ? "#eab308" : "#ef4444" },
      { label: "Error Rate", value: `${errorRate}%`, color: parseFloat(errorRate) > 5 ? "#ef4444" : parseFloat(errorRate) > 1 ? "#eab308" : "#10b981" },
    ]),

    spacer(4),

    // Status codes bar chart
    data.statusCodes.length > 0
      ? barChart(
          data.statusCodes.map((s) => ({
            label: s.name,
            value: s.value,
            color: s.name === "2xx" ? "#10b981" : s.name === "3xx" ? "#3b82f6" : s.name === "4xx" ? "#eab308" : "#ef4444",
          })),
          "Status Codes"
        )
      : "",

    spacer(),

    // Top countries bar chart
    data.topCountries.length > 0
      ? barChart(
          data.topCountries.slice(0, 8).map((c) => ({ label: c.name, value: c.value })),
          "Top Countries"
        )
      : "",

    spacer(),

    // Top paths data table
    data.topPaths.length > 0
      ? (() => {
          const title = sectionTitle("Top Paths");
          const table = dataTable(
            [{ label: "Path" }, { label: "Requests", align: "right" as const }],
            data.topPaths.slice(0, 10).map((p) => [escapeHtml(p.name), formatNum(p.value)]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`Traffic Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
