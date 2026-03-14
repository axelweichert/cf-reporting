/**
 * Bot report email template.
 */

import type { BotData } from "@/lib/queries/bots";
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

/** Map bot score range label to a color (low scores = likely bot = red, high = human = green) */
function scoreRangeColor(range: string): string {
  const start = parseInt(range, 10);
  if (isNaN(start)) return "#f97316";
  if (start < 20) return "#ef4444";
  if (start < 40) return "#f97316";
  if (start < 60) return "#eab308";
  if (start < 80) return "#3b82f6";
  return "#10b981";
}

export function renderBotsEmail(data: BotData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("Bot Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Verified Bots", value: formatNum(data.verifiedBotTotal) },
      { label: "Unverified Bots", value: formatNum(data.unverifiedBotTotal), color: "#ef4444" },
    ]),

    spacer(4),

    // Bot score distribution bar chart
    data.botScoreDistribution.length > 0
      ? barChart(
          data.botScoreDistribution.map((b) => ({
            label: b.range,
            value: b.count,
            color: scoreRangeColor(b.range),
          })),
          "Bot Score Distribution"
        )
      : "",

    spacer(),

    // Top bot user agents table
    data.topBotUserAgents.length > 0
      ? (() => {
          const title = sectionTitle("Top Bot User Agents");
          const table = dataTable(
            [{ label: "User Agent" }, { label: "Requests", align: "right" as const }],
            data.topBotUserAgents.slice(0, 10).map((ua) => [escapeHtml(ua.userAgent), formatNum(ua.count)]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Verified bot categories bar chart (only if any exist)
    data.verifiedBotCategories.length > 0
      ? barChart(
          data.verifiedBotCategories.map((c) => ({
            label: c.category,
            value: c.count,
          })),
          "Verified Bot Categories"
        )
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`Bot Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
