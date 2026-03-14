/**
 * Zero Trust Summary report email template.
 */

import type { ZtSummaryData } from "@/lib/queries/zt-summary";
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

export function renderZtSummaryEmail(data: ZtSummaryData, meta: ReportMeta): string {
  const subtitle = `${meta.accountName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const totalLogins = data.accessLogins.total;
  const successRate = totalLogins > 0
    ? ((data.accessLogins.successful / totalLogins) * 100).toFixed(1)
    : "N/A";

  const content = [
    emailHeader("Zero Trust Summary", subtitle),

    // Key stats
    statCardsRow([
      { label: "Total DNS Queries", value: formatNum(data.totalDnsQueries) },
      { label: "Blocked Queries", value: formatNum(data.blockedDnsQueries), color: "#ef4444" },
      { label: "Active Devices", value: formatNum(data.fleet.activeDevices) },
      { label: "Total Users", value: formatNum(data.fleet.totalUsers) },
    ]),

    spacer(4),

    // Fleet overview
    sectionTitle("Fleet Overview"),
    dataTable(
      [
        { label: "Metric" },
        { label: "Value", align: "right" as const },
      ],
      [
        ["Total Devices", formatNum(data.fleet.totalDevices)],
        ["Active Devices (24h)", formatNum(data.fleet.activeDevices)],
        ["Total Users", formatNum(data.fleet.totalUsers)],
        ["Access Seats", formatNum(data.fleet.accessSeats)],
        ["Gateway Seats", formatNum(data.fleet.gatewaySeats)],
        ["Access Applications", formatNum(data.fleet.accessApps)],
      ]
    ),

    spacer(),

    // Access logins
    sectionTitle("Access Logins"),
    statCardsRow([
      { label: "Total Logins", value: formatNum(totalLogins) },
      { label: "Successful", value: formatNum(data.accessLogins.successful), color: "#10b981" },
      { label: "Login Success Rate", value: typeof successRate === "string" ? `${successRate}%` : "N/A", color: "#3b82f6" },
    ]),

    spacer(),

    // Resolver decisions
    data.resolverDecisions.length > 0
      ? barChart(
          data.resolverDecisions.map((d) => ({
            label: d.decision,
            value: d.count,
            color: d.decision.toLowerCase().includes("block") ? "#ef4444" : "#10b981",
          })),
          "DNS Resolver Decisions"
        )
      : "",

    spacer(),

    // Top blocked categories
    data.topBlockedCategories.length > 0
      ? barChart(
          data.topBlockedCategories.slice(0, 8).map((c) => ({
            label: c.name,
            value: c.value,
            color: "#ef4444",
          })),
          "Top Blocked Categories"
        )
      : "",

    spacer(),

    // Blocked by policy
    data.blockedByPolicy.length > 0
      ? barChart(
          data.blockedByPolicy.slice(0, 8).map((p) => ({
            label: p.name,
            value: p.value,
            color: "#f97316",
          })),
          "Blocked by Policy"
        )
      : "",

    spacer(),

    // Compliance metrics
    ...(data.compliance.length > 0
      ? [
          sectionTitle("Compliance Scorecard"),
          dataTable(
            [
              { label: "Metric" },
              { label: "Score", align: "right" as const },
              { label: "Detail" },
              { label: "Status", align: "center" as const },
            ],
            data.compliance.map((c) => [
              c.label,
              `${c.value}%`,
              c.detail,
              c.status.toUpperCase(),
            ])
          ),
        ]
      : []),

    spacer(),

    // Daily active users trend
    data.dailyActiveUsers.length > 0
      ? (() => {
          const title = sectionTitle("Daily Active Users");
          const table = dataTable(
            [
              { label: "Date" },
              { label: "Unique Users", align: "right" as const },
              { label: "Logins", align: "right" as const },
            ],
            data.dailyActiveUsers.map((d) => [
              d.date,
              formatNum(d.uniqueUsers),
              formatNum(d.logins),
            ]),
            14
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(
    `Zero Trust Summary \u2013 ${escapeHtml(meta.accountName)}`,
    content.filter(Boolean).join("\n")
  );
}
