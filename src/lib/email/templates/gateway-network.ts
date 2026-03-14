/**
 * Gateway Network (L4) report email template.
 */

import type { GatewayNetworkData } from "@/lib/queries/gateway-network";
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

export function renderGatewayNetworkEmail(data: GatewayNetworkData, meta: ReportMeta): string {
  const subtitle = `${meta.accountName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const totalSessions = data.sessionsOverTime.reduce((sum, p) => sum + p.allowed + p.blocked, 0);
  const totalBlocked = data.sessionsOverTime.reduce((sum, p) => sum + p.blocked, 0);
  const totalAllowed = data.sessionsOverTime.reduce((sum, p) => sum + p.allowed, 0);
  const blockRate = totalSessions > 0 ? ((totalBlocked / totalSessions) * 100).toFixed(1) : "0";

  const content = [
    emailHeader("Gateway Network Report", subtitle),

    // Key stats
    statCardsRow([
      { label: "Total L4 Sessions", value: formatNum(totalSessions) },
      { label: "Allowed", value: formatNum(totalAllowed), color: "#10b981" },
      { label: "Blocked", value: formatNum(totalBlocked), color: "#ef4444" },
      { label: "Block Rate", value: `${blockRate}%`, color: "#f97316" },
    ]),

    spacer(4),

    // Transport protocols
    data.transportProtocols.length > 0
      ? barChart(
          data.transportProtocols.map((p) => ({
            label: p.protocol,
            value: p.count,
            color: "#3b82f6",
          })),
          "Transport Protocols"
        )
      : "",

    spacer(),

    // Port/service breakdown
    data.portBreakdown.length > 0
      ? (() => {
          const title = sectionTitle("Top Ports & Services");
          const table = dataTable(
            [
              { label: "Port" },
              { label: "Service" },
              { label: "Sessions", align: "right" as const },
            ],
            data.portBreakdown.slice(0, 10).map((p) => [
              String(p.port),
              p.service,
              formatNum(p.count),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Blocked destinations
    data.blockedDestinations.length > 0
      ? (() => {
          const title = sectionTitle("Top Blocked Destinations");
          const table = dataTable(
            [
              { label: "IP Address" },
              { label: "Country" },
              { label: "Port" },
              { label: "Protocol" },
              { label: "Blocks", align: "right" as const },
            ],
            data.blockedDestinations.slice(0, 10).map((d) => [
              d.ip,
              d.country,
              d.port != null ? String(d.port) : "\u2013",
              d.protocol,
              formatNum(d.count),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(),

    // Source countries
    data.topSourceCountries.length > 0
      ? barChart(
          data.topSourceCountries.slice(0, 8).map((c) => ({
            label: c.country,
            value: c.count,
            color: "#f97316",
          })),
          "Top Source Countries"
        )
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(
    `Gateway Network Report \u2013 ${escapeHtml(meta.accountName)}`,
    content.filter(Boolean).join("\n")
  );
}
