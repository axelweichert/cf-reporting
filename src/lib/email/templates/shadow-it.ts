/**
 * Shadow IT Discovery report email template.
 */

import type { ShadowItData } from "@/lib/queries/shadow-it";
import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
  barChart,
  textBlock,
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

export function renderShadowItEmail(data: ShadowItData, meta: ReportMeta): string {
  const subtitle = `${meta.accountName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const totalApps = data.discoveredApplications.length;
  const totalRequests = data.discoveredApplications.reduce((sum, a) => sum + a.count, 0);
  const totalCategories = data.categoryBreakdown.length;

  const content = [
    emailHeader("Shadow IT Discovery Report", subtitle),

    // Key stats
    statCardsRow([
      { label: "Discovered Apps", value: formatNum(totalApps) },
      { label: "Total Requests", value: formatNum(totalRequests) },
      { label: "Categories", value: formatNum(totalCategories) },
    ]),

    spacer(4),

    // Note when only blocked traffic is logged
    ...(data.onlyBlockedLogged
      ? [textBlock("Note: Only blocked DNS queries were logged during this period. Discovered applications reflect blocked traffic only.")]
      : []),

    // Discovered applications
    data.discoveredApplications.length > 0
      ? (() => {
          const title = sectionTitle("Discovered Applications");
          const table = dataTable(
            [
              { label: "Application" },
              { label: "Category" },
              { label: "Requests", align: "right" as const },
            ],
            data.discoveredApplications.slice(0, 15).map((a) => [
              a.name,
              a.category,
              formatNum(a.count),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Category breakdown
    data.categoryBreakdown.length > 0
      ? barChart(
          data.categoryBreakdown.slice(0, 10).map((c) => ({
            label: c.category,
            value: c.count,
            color: "#f97316",
          })),
          "Traffic by Category"
        )
      : "",

    spacer(),

    // Top discovered apps bar chart
    data.discoveredApplications.length > 0
      ? barChart(
          data.discoveredApplications.slice(0, 8).map((a) => ({
            label: a.name,
            value: a.count,
            color: "#3b82f6",
          })),
          "Top Applications by Volume"
        )
      : "",

    spacer(),

    // User-to-app mappings
    data.userAppMappings.length > 0
      ? (() => {
          const title = sectionTitle("User Application Usage");
          const table = dataTable(
            [
              { label: "User" },
              { label: "Applications" },
              { label: "Requests", align: "right" as const },
            ],
            data.userAppMappings.slice(0, 10).map((u) => [
              u.email,
              u.apps.length > 0 ? u.apps.slice(0, 3).join(", ") + (u.apps.length > 3 ? ` (+${u.apps.length - 3})` : "") : "\u2013",
              formatNum(u.totalRequests),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(
    `Shadow IT Report \u2013 ${escapeHtml(meta.accountName)}`,
    content.filter(Boolean).join("\n")
  );
}
