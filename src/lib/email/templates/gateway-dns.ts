/**
 * Gateway DNS report email template.
 */

import type { GatewayDnsData } from "@/lib/queries/gateway-dns";
import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
  barChart,
  spacer,
  formatNum,
  escapeHtml,
} from "./base";

interface ReportMeta {
  accountName: string;
  startDate: string;
  endDate: string;
  dashboardUrl?: string;
}

export function renderGatewayDnsEmail(data: GatewayDnsData, meta: ReportMeta): string {
  const subtitle = `${meta.accountName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const totalQueries = data.resolverDecisions.reduce((sum, d) => sum + d.count, 0);
  const blockedQueries = data.resolverDecisions
    .filter((d) => d.decision.toLowerCase().includes("block"))
    .reduce((sum, d) => sum + d.count, 0);
  const blockRate = totalQueries > 0 ? ((blockedQueries / totalQueries) * 100).toFixed(1) : "0";

  const content = [
    emailHeader("Gateway DNS Report", subtitle),

    // Key stats
    statCardsRow([
      { label: "Total DNS Queries", value: formatNum(totalQueries) },
      { label: "Blocked Queries", value: formatNum(blockedQueries), color: "#ef4444" },
      { label: "Block Rate", value: `${blockRate}%`, color: "#f97316" },
    ]),

    spacer(4),

    // Resolver decisions breakdown
    data.resolverDecisions.length > 0
      ? barChart(
          data.resolverDecisions.map((d) => ({
            label: d.decision,
            value: d.count,
            color: d.decision.toLowerCase().includes("block") ? "#ef4444" : "#10b981",
          })),
          "Resolver Decisions"
        )
      : "",

    spacer(),

    // Blocked categories
    data.blockedCategories.length > 0
      ? barChart(
          data.blockedCategories.slice(0, 10).map((c) => ({
            label: c.category,
            value: c.count,
            color: "#ef4444",
          })),
          "Blocked Categories"
        )
      : "",

    spacer(),

    // Top blocked domains
    data.topBlockedDomains.length > 0
      ? (() => {
          const title = sectionTitle("Top Blocked Domains");
          const table = dataTable(
            [
              { label: "Domain" },
              { label: "Category" },
              { label: "Blocks", align: "right" as const },
            ],
            data.topBlockedDomains.slice(0, 10).map((d) => [
              d.domain,
              d.category,
              formatNum(d.count),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Blocked by location
    data.topBlockedLocations.length > 0
      ? barChart(
          data.topBlockedLocations.slice(0, 8).map((l) => ({
            label: l.location,
            value: l.count,
            color: "#f97316",
          })),
          "Blocks by Location"
        )
      : "",

    spacer(),

    // Policy breakdown
    data.policyBreakdown.length > 0
      ? (() => {
          const title = sectionTitle("Policy Breakdown");
          const table = dataTable(
            [
              { label: "Policy" },
              { label: "Allowed", align: "right" as const },
              { label: "Blocked", align: "right" as const },
              { label: "Total", align: "right" as const },
            ],
            data.policyBreakdown.slice(0, 10).map((p) => [
              p.policyName,
              formatNum(p.allowed),
              formatNum(p.blocked),
              formatNum(p.total),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Location breakdown
    data.locationBreakdown.length > 0
      ? (() => {
          const title = sectionTitle("Location Breakdown");
          const table = dataTable(
            [
              { label: "Location" },
              { label: "Total", align: "right" as const },
              { label: "Blocked", align: "right" as const },
            ],
            data.locationBreakdown.slice(0, 10).map((l) => [
              l.location,
              formatNum(l.total),
              formatNum(l.blocked),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // HTTP inspection (if available)
    ...(data.httpInspection
      ? [
          sectionTitle("HTTP Inspection"),
          statCardsRow([
            { label: "HTTP Requests Inspected", value: formatNum(data.httpInspection.totalRequests) },
          ]),
          ...(data.httpInspection.byAction.length > 0
            ? [
                barChart(
                  data.httpInspection.byAction.map((a) => ({
                    label: a.action,
                    value: a.count,
                    color: a.action.toLowerCase() === "block" ? "#ef4444" : "#3b82f6",
                  })),
                  "HTTP Actions"
                ),
              ]
            : []),
          ...(data.httpInspection.topHosts.length > 0
            ? [
                dataTable(
                  [
                    { label: "Host" },
                    { label: "Requests", align: "right" as const },
                  ],
                  data.httpInspection.topHosts.slice(0, 10).map((h) => [
                    h.host,
                    formatNum(h.count),
                  ])
                ),
              ]
            : []),
        ]
      : []),

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(
    `Gateway DNS Report \u2013 ${escapeHtml(meta.accountName)}`,
    content.filter(Boolean).join("\n")
  );
}
