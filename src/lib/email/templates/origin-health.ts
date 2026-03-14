/**
 * Origin Health report email template.
 */

import type { OriginHealthData } from "@/lib/queries/origin-health";
import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
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

export function renderOriginHealthEmail(data: OriginHealthData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("Origin Health Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Total Requests", value: formatNum(data.stats.totalRequests) },
      { label: "Avg Response Time", value: `${data.stats.avgResponseTime}ms` },
      { label: "P95 Response Time", value: `${data.stats.p95ResponseTime}ms`, color: data.stats.p95ResponseTime > 2000 ? "#ef4444" : data.stats.p95ResponseTime > 1000 ? "#eab308" : "#10b981" },
      { label: "5xx Error Rate", value: `${data.stats.errorRate5xx}%`, color: data.stats.errorRate5xx > 5 ? "#ef4444" : data.stats.errorRate5xx > 1 ? "#eab308" : "#10b981" },
    ]),

    spacer(4),

    // Status breakdown table
    data.statusBreakdown.length > 0
      ? (() => {
          const title = sectionTitle("Status Breakdown");
          const table = dataTable(
            [
              { label: "Status" },
              { label: "Group" },
              { label: "Requests", align: "right" as const },
              { label: "Avg Response", align: "right" as const },
            ],
            data.statusBreakdown.slice(0, 15).map((s) => [
              String(s.status),
              escapeHtml(s.statusGroup),
              formatNum(s.requests),
              `${s.avgResponseTime}ms`,
            ]),
            15
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Health check status table (only if health checks are configured)
    data.hasHealthChecks && data.healthChecks.length > 0
      ? (() => {
          const title = sectionTitle("Health Check Status");
          const table = dataTable(
            [
              { label: "Name" },
              { label: "Status" },
              { label: "Address" },
            ],
            data.healthChecks.map((hc) => [
              escapeHtml(hc.name),
              escapeHtml(hc.status),
              escapeHtml(hc.address),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`Origin Health Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
