/**
 * SSL/TLS report email template.
 */

import type { SslData } from "@/lib/queries/ssl";
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

export function renderSslEmail(data: SslData, meta: ReportMeta): string {
  const subtitle = `${meta.zoneName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("SSL/TLS Report", subtitle),

    // Stats
    statCardsRow([
      { label: "Total Requests", value: formatNum(data.stats.totalRequests) },
      { label: "Encrypted", value: `${data.stats.encryptedPercent}%`, color: data.stats.encryptedPercent >= 99 ? "#10b981" : data.stats.encryptedPercent >= 90 ? "#eab308" : "#ef4444" },
      { label: "TLS 1.3", value: `${data.stats.tlsv13Percent}%`, color: data.stats.tlsv13Percent >= 80 ? "#10b981" : "#eab308" },
      { label: "HTTP/3", value: `${data.stats.http3Percent}%` },
    ]),

    spacer(),

    statCardsRow([
      { label: "Certificates", value: String(data.stats.certCount) },
    ]),

    spacer(4),

    // TLS versions bar chart
    data.tlsVersions.length > 0
      ? barChart(
          data.tlsVersions.map((t) => ({
            label: t.version,
            value: t.requests,
          })),
          "TLS Versions"
        )
      : "",

    spacer(),

    // HTTP protocols bar chart
    data.httpProtocols.length > 0
      ? barChart(
          data.httpProtocols.map((p) => ({
            label: p.protocol,
            value: p.requests,
          })),
          "HTTP Protocols"
        )
      : "",

    spacer(),

    // Certificates table
    data.certificates.length > 0
      ? (() => {
          const title = sectionTitle("Certificates");
          const table = dataTable(
            [
              { label: "Type" },
              { label: "Host" },
              { label: "Status" },
              { label: "Expires", align: "right" as const },
            ],
            data.certificates.slice(0, 10).map((c) => [
              escapeHtml(c.type),
              escapeHtml(c.hosts[0] || "\u2013"),
              escapeHtml(c.status),
              c.expiresOn ? escapeHtml(c.expiresOn.split("T")[0]) : "\u2013",
            ]),
            10
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(`SSL/TLS Report \u2013 ${meta.zoneName}`, content.filter(Boolean).join("\n"));
}
