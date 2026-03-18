/**
 * Contract Usage email template.
 *
 * Renders usage-vs-commitment gauges as table-based horizontal bars
 * for maximum email client compatibility.
 */

import {
  emailWrapper,
  emailHeader,
  emailFooter,
  sectionTitle,
  statCardsRow,
  dataTable,
  escapeHtml,
} from "./base";

import type { ContractUsageEntry, ContractUsageMonthly } from "@/lib/contract/types";

function usageBar(entry: ContractUsageEntry): string {
  const pct = entry.usagePct;
  const fillPct = Math.min(pct, 100);

  let barColor = "#10b981"; // green
  if (pct >= 100) barColor = "#ef4444"; // red
  else if (pct >= entry.warningThreshold * 100) barColor = "#eab308"; // amber

  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(2));

  const valueText = entry.dataAvailable
    ? `${fmt(entry.usageValue)} / ${fmt(entry.committedAmount)} ${escapeHtml(entry.unit)} (${pct.toFixed(1)}%)`
    : "No data";

  return `<tr>
  <td style="padding:8px 32px;background:#ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:13px;color:#27272a;padding-bottom:4px;">
          ${escapeHtml(entry.displayName)}
          <span style="float:right;font-size:12px;color:${barColor};font-weight:600;">${valueText}</span>
        </td>
      </tr>
      <tr>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e4e4e7;border-radius:4px;height:12px;">
            <tr>
              <td width="${fillPct}%" style="background:${barColor};border-radius:4px;height:12px;"></td>
              <td width="${100 - fillPct}%" style="height:12px;"></td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, 1));
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
}

export function buildContractUsageEmail(
  data: ContractUsageMonthly,
  dashboardUrl?: string,
): string {
  const title = `Contract Usage Report \u2013 ${periodLabel(data.period)}`;

  // Summary cards
  const summaryHtml = statCardsRow([
    { label: "Items Tracked", value: String(data.summary.totalItems) },
    { label: "At Warning", value: String(data.summary.atWarning), color: data.summary.atWarning > 0 ? "#eab308" : undefined },
    { label: "Over Limit", value: String(data.summary.overLimit), color: data.summary.overLimit > 0 ? "#ef4444" : undefined },
    { label: "Health", value: `${data.summary.healthPct}%`, color: data.summary.healthPct >= 80 ? "#10b981" : "#eab308" },
  ]);

  // Group by category
  const categories = new Map<string, ContractUsageEntry[]>();
  for (const entry of data.entries) {
    const items = categories.get(entry.category) || [];
    items.push(entry);
    categories.set(entry.category, items);
  }

  let categoryHtml = "";
  for (const [category, items] of categories) {
    categoryHtml += sectionTitle(category);
    for (const item of items) {
      categoryHtml += usageBar(item);
    }
  }

  // Detailed table sorted by usage % descending
  const sortedEntries = [...data.entries]
    .filter((e) => e.dataAvailable)
    .sort((a, b) => b.usagePct - a.usagePct);

  const tableHtml = sortedEntries.length > 0
    ? dataTable(
        [
          { label: "Product", align: "left" },
          { label: "Usage", align: "right" },
          { label: "Committed", align: "right" },
          { label: "Usage %", align: "right" },
        ],
        sortedEntries.map((e) => [
          e.displayName,
          `${e.usageValue.toFixed(2)} ${e.unit}`,
          `${e.committedAmount.toFixed(2)} ${e.unit}`,
          `${e.usagePct.toFixed(1)}%`,
        ]),
        20,
      )
    : "";

  // Disclaimer
  const disclaimerHtml = `<tr>
  <td style="padding:16px 32px;background:#ffffff;">
    <p style="margin:0;font-size:11px;color:#a1a1aa;font-style:italic;">
      Usage estimates based on analytics data. Refer to your Cloudflare invoice for billing-accurate figures.
    </p>
  </td>
</tr>`;

  const content = [
    emailHeader(title, data.period),
    summaryHtml,
    categoryHtml,
    tableHtml,
    disclaimerHtml,
    emailFooter(dashboardUrl),
  ].join("\n");

  return emailWrapper(title, content);
}
