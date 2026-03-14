/**
 * DNS report email template.
 */

import type { DnsData } from "@/lib/queries/dns";
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

export function renderDnsEmail(data: DnsData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("DNS Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Total Queries", value: formatNum(data.totalQueries) },
      { label: "Avg Latency", value: `${data.latency.avg}ms` },
      { label: "P50 Latency", value: `${data.latency.p50}ms` },
      { label: "P99 Latency", value: `${data.latency.p99}ms`, color: data.latency.p99 > 100 ? "#ef4444" : data.latency.p99 > 50 ? "#eab308" : "#10b981" },
    ]),

    spacer(4),

    // Response codes bar chart
    data.responseCodeBreakdown.length > 0
      ? barChart(
          data.responseCodeBreakdown.map((r) => ({
            label: r.name,
            value: r.value,
            color: r.name === "NOERROR" ? "#10b981" : r.name === "NXDOMAIN" ? "#ef4444" : "#f97316",
          })),
          "Response Codes"
        )
      : "",

    spacer(),

    // Top queried records table
    data.topQueriedRecords.length > 0
      ? (() => {
          const title = sectionTitle("Top Queried Records");
          const table = dataTable(
            [{ label: "Record Name" }, { label: "Queries", align: "right" as const }],
            data.topQueriedRecords.slice(0, 10).map((r) => [escapeHtml(r.name), formatNum(r.count)]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(),

    // NXDOMAIN hotspots table (only if any exist)
    data.nxdomainHotspots.length > 0
      ? (() => {
          const title = sectionTitle("NXDOMAIN Hotspots");
          const table = dataTable(
            [{ label: "Record Name" }, { label: "Queries", align: "right" as const }],
            data.nxdomainHotspots.slice(0, 10).map((r) => [escapeHtml(r.name), formatNum(r.count)]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`DNS Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
