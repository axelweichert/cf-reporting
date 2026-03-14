/**
 * Access Audit report email template.
 */

import type { AccessAuditData } from "@/lib/queries/access-audit";
import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
  barChart,
  recommendationRow,
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

export function renderAccessAuditEmail(data: AccessAuditData, meta: ReportMeta): string {
  const subtitle = `${meta.accountName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const totalLogins = data.loginsOverTime.reduce((sum, p) => sum + p.successful + p.failed, 0);
  const totalSuccessful = data.loginsOverTime.reduce((sum, p) => sum + p.successful, 0);
  const successRate = totalLogins > 0 ? ((totalSuccessful / totalLogins) * 100).toFixed(1) : "N/A";

  const content = [
    emailHeader("Access Audit Report", subtitle),

    // Key stats
    statCardsRow([
      { label: "Total Logins", value: formatNum(totalLogins) },
      { label: "Successful", value: formatNum(totalSuccessful), color: "#10b981" },
      { label: "Failed", value: formatNum(data.failedLoginCount), color: "#ef4444" },
      { label: "Success Rate", value: typeof successRate === "string" ? `${successRate}%` : "N/A", color: "#3b82f6" },
    ]),

    spacer(4),

    // Access by application
    data.accessByApplication.length > 0
      ? barChart(
          data.accessByApplication.slice(0, 8).map((a) => ({
            label: a.appName || a.appId,
            value: a.count,
            color: "#3b82f6",
          })),
          "Access by Application"
        )
      : "",

    spacer(),

    // Per-app success/failure breakdown
    data.appBreakdown.length > 0
      ? (() => {
          const title = sectionTitle("Application Login Breakdown");
          const table = dataTable(
            [
              { label: "Application" },
              { label: "Successful", align: "right" as const },
              { label: "Failed", align: "right" as const },
              { label: "Total", align: "right" as const },
              { label: "Failure Rate", align: "right" as const },
            ],
            data.appBreakdown.slice(0, 10).map((a) => [
              a.appName || a.appId,
              formatNum(a.successful),
              formatNum(a.failed),
              formatNum(a.total),
              `${a.failureRate.toFixed(1)}%`,
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Geographic access
    data.geographicAccess.length > 0
      ? barChart(
          data.geographicAccess.slice(0, 8).map((g) => ({
            label: g.country,
            value: g.count,
            color: "#f97316",
          })),
          "Login Countries"
        )
      : "",

    spacer(),

    // Identity providers
    data.identityProviders.length > 0
      ? barChart(
          data.identityProviders.slice(0, 8).map((p) => ({
            label: p.provider,
            value: p.count,
            color: "#8b5cf6",
          })),
          "Identity Providers"
        )
      : "",

    spacer(),

    // Failed login details
    data.failedByApp.length > 0
      ? barChart(
          data.failedByApp.slice(0, 8).map((a) => ({
            label: a.appName || a.appId,
            value: a.count,
            color: "#ef4444",
          })),
          "Failed Logins by Application"
        )
      : "",

    spacer(),

    // Failed by country
    data.failedByCountry.length > 0
      ? barChart(
          data.failedByCountry.slice(0, 8).map((c) => ({
            label: c.country,
            value: c.count,
            color: "#ef4444",
          })),
          "Failed Logins by Country"
        )
      : "",

    spacer(),

    // Anomalies
    ...(data.anomalies.length > 0
      ? [
          sectionTitle("Anomalies & Alerts"),
          ...data.anomalies.map((a) => recommendationRow(a.severity, a.title, a.description)),
        ]
      : []),

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(
    `Access Audit Report \u2013 ${escapeHtml(meta.accountName)}`,
    content.filter(Boolean).join("\n")
  );
}
