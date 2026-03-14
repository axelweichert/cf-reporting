/**
 * DDoS report email template.
 */

import type { DdosData } from "@/lib/queries/ddos";
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

export function renderDdosEmail(data: DdosData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("DDoS Report", subtitle),

    // Stats
    statCardsRow([
      { label: "DDoS Events", value: formatNum(data.totalDdosEvents), color: "#ef4444" },
      { label: "Rate Limit Events", value: formatNum(data.totalRateLimitEvents), color: "#f97316" },
    ]),

    spacer(4),

    // Attack vectors bar chart
    data.ddosAttackVectors.length > 0
      ? barChart(
          data.ddosAttackVectors.map((v) => ({
            label: v.method,
            value: v.count,
            color: "#ef4444",
          })),
          "Attack Vectors"
        )
      : "",

    spacer(),

    // Top targeted paths table
    data.ddosTopPaths.length > 0
      ? (() => {
          const title = sectionTitle("Top Targeted Paths");
          const table = dataTable(
            [{ label: "Path" }, { label: "Events", align: "right" as const }],
            data.ddosTopPaths.slice(0, 10).map((p) => [escapeHtml(p.path), formatNum(p.count)]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Rate limiting rules
    data.rateLimitRules.length > 0
      ? (() => {
          const title = sectionTitle("Rate Limiting Rules");
          const fmtTimeout = (s: number) => s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
          const table = dataTable(
            [
              { label: "Rule" },
              { label: "Action" },
              { label: "Triggers", align: "right" as const },
              { label: "Threshold", align: "right" as const },
              { label: "Timeout", align: "right" as const },
              { label: "Status" },
            ],
            data.rateLimitRules.map((r) => [
              escapeHtml(r.description),
              escapeHtml(r.action.replace(/_/g, " ")),
              formatNum(r.triggers),
              `${formatNum(r.threshold)} / ${r.period}s`,
              fmtTimeout(r.mitigationTimeout),
              r.enabled ? "Active" : "Off",
            ]),
            20
          );
          return title + table;
        })()
      : "",

    spacer(),

    // L3/L4 attacks section (if available)
    ...(data.l34
      ? [
          sectionTitle("L3/4 Attacks"),
          statCardsRow([
            { label: "Total Attacks", value: formatNum(data.l34.totalAttacks), color: "#ef4444" },
          ]),
          spacer(4),
          ...(data.l34.attacks.length > 0
            ? [
                dataTable(
                  [
                    { label: "Vector" },
                    { label: "Protocol" },
                    { label: "Start" },
                    { label: "End" },
                  ],
                  data.l34.attacks.map((a) => [
                    escapeHtml(a.attackVector),
                    escapeHtml(a.ipProtocol),
                    escapeHtml(a.start.split("T")[0] + " " + a.start.split("T")[1]?.slice(0, 5)),
                    escapeHtml(a.end.split("T")[0] + " " + a.end.split("T")[1]?.slice(0, 5)),
                  ]),
                  10
                ),
              ]
            : []),
        ]
      : []),

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`DDoS Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
