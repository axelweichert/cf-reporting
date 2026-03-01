/**
 * Security report email template.
 */

import type { SecurityEmailData } from "@/lib/email/report-data";
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
} from "./base";

interface ReportMeta {
  zoneName: string;
  startDate: string;
  endDate: string;
  dashboardUrl?: string;
}

export function renderSecurityEmail(data: SecurityEmailData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} – ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("Security Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Threats Blocked", value: formatNum(data.totalThreatsBlocked), color: "#ef4444" },
      { label: "Challenge Solve Rate", value: data.challengeSolveRate > 0 ? `${data.challengeSolveRate.toFixed(1)}%` : "N/A", color: "#10b981" },
    ]),

    spacer(4),

    // Source breakdown
    data.topSources.length > 0
      ? barChart(
          data.topSources.slice(0, 8).map((s) => ({ label: s.name, value: s.value, color: "#f97316" })),
          "WAF Event Sources"
        )
      : "",

    spacer(),

    // Top attacking IPs
    data.topAttackingIPs.length > 0
      ? dataTable(
          [{ label: "IP Address" }, { label: "Blocked Requests", align: "right" as const }],
          data.topAttackingIPs.slice(0, 10).map((ip) => [ip.ip, formatNum(ip.count)])
        )
      : "",

    data.topAttackingIPs.length > 0 ? "" : "",

    spacer(),

    // Top attacking countries
    data.topAttackingCountries.length > 0
      ? barChart(
          data.topAttackingCountries.slice(0, 8).map((c) => ({ label: c.country, value: c.count, color: "#ef4444" })),
          "Top Attacking Countries"
        )
      : "",

    spacer(),

    // Top block rules
    data.topBlockRules.length > 0
      ? (() => {
          const tableContent = sectionTitle("Top Firewall Rules");
          const table = dataTable(
            [{ label: "Rule ID" }, { label: "Blocks", align: "right" as const }],
            data.topBlockRules.slice(0, 10).map((r) => [r.name, formatNum(r.count)])
          );
          return tableContent + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`Security Report – ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
