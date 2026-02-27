/**
 * Executive report email template.
 */

import type { ExecutiveData } from "@/lib/queries/executive";
import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
  barChart,
  textBlock,
  recommendationRow,
  spacer,
  formatNum,
  formatBytes,
} from "./base";

interface ReportMeta {
  zoneName: string;
  startDate: string;
  endDate: string;
  dashboardUrl?: string;
}

export function renderExecutiveEmail(data: ExecutiveData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} — ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("Executive Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Total Requests", value: formatNum(data.traffic.totalRequests) },
      { label: "Bandwidth", value: formatBytes(data.traffic.totalBandwidth) },
      { label: "Cache Hit Ratio", value: `${data.traffic.cacheHitRatio.toFixed(1)}%`, color: data.traffic.cacheHitRatio >= 80 ? "#10b981" : data.traffic.cacheHitRatio >= 50 ? "#eab308" : "#ef4444" },
      { label: "Threats Blocked", value: formatNum(data.security.totalThreatsBlocked), color: "#ef4444" },
    ]),

    spacer(4),

    // Executive summary
    sectionTitle("Summary"),
    textBlock(data.summary),

    spacer(),

    // Status code breakdown
    barChart(
      data.statusCodeBreakdown.map((s) => ({
        label: s.name,
        value: s.value,
        color: s.name === "2xx" ? "#10b981" : s.name === "3xx" ? "#3b82f6" : s.name === "4xx" ? "#eab308" : "#ef4444",
      })),
      "Response Status Codes"
    ),

    spacer(),

    // Top countries
    data.topCountries.length > 0
      ? barChart(
          data.topCountries.slice(0, 8).map((c) => ({ label: c.name, value: c.value })),
          "Top Traffic Countries"
        )
      : "",

    spacer(),

    // Performance
    sectionTitle("Performance"),
    dataTable(
      [
        { label: "Metric" },
        { label: "Avg", align: "right" as const },
        { label: "P50", align: "right" as const },
        { label: "P95", align: "right" as const },
        { label: "P99", align: "right" as const },
      ],
      [
        ["Time to First Byte", `${data.performance.ttfb.avg}ms`, `${data.performance.ttfb.p50}ms`, `${data.performance.ttfb.p95}ms`, `${data.performance.ttfb.p99}ms`],
        ["Origin Response", `${data.performance.originResponseTime.avg}ms`, `${data.performance.originResponseTime.p50}ms`, `${data.performance.originResponseTime.p95}ms`, `${data.performance.originResponseTime.p99}ms`],
      ]
    ),

    spacer(),

    // Threat vectors
    data.security.topThreatVectors.length > 0
      ? barChart(
          data.security.topThreatVectors.map((v) => ({ label: v.name, value: v.count, color: "#ef4444" })),
          "Top Threat Vectors"
        )
      : "",

    spacer(),

    // Recommendations
    ...(data.recommendations.length > 0
      ? [sectionTitle("Recommendations"), ...data.recommendations.map((r) => recommendationRow(r.severity, r.title, r.description))]
      : []),

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`Executive Report — ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
