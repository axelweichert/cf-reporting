/**
 * Devices & Users report email template.
 */

import type { DevicesUsersData } from "@/lib/queries/devices-users";
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

export function renderDevicesUsersEmail(data: DevicesUsersData, meta: ReportMeta): string {
  const subtitle = `${meta.accountName} \u2013 ${meta.startDate} to ${meta.endDate}`;

  const content = [
    emailHeader("Devices & Users Report", subtitle),

    // Key stats
    statCardsRow([
      { label: "Total Devices", value: formatNum(data.stats.totalDevices) },
      { label: "Active (24h)", value: formatNum(data.stats.activeDevices), color: "#10b981" },
      { label: "Stale (>30d)", value: formatNum(data.stats.staleDevices), color: data.stats.staleDevices > 0 ? "#ef4444" : "#10b981" },
      { label: "Total Users", value: formatNum(data.stats.totalUsers) },
    ]),

    spacer(4),

    // Device health scorecard
    ...(data.health.length > 0
      ? [
          sectionTitle("Device Health Scorecard"),
          dataTable(
            [
              { label: "Metric" },
              { label: "Score", align: "right" as const },
              { label: "Detail" },
              { label: "Status", align: "center" as const },
            ],
            data.health.map((h) => [
              h.label,
              `${h.value}%`,
              h.detail,
              h.status.toUpperCase(),
            ])
          ),
        ]
      : []),

    spacer(),

    // Seat utilization
    sectionTitle("Seat Utilization"),
    dataTable(
      [
        { label: "Metric" },
        { label: "Value", align: "right" as const },
      ],
      [
        ["Total Users", formatNum(data.stats.totalUsers)],
        ["Access Seats", formatNum(data.stats.accessSeats)],
        ["Gateway Seats", formatNum(data.stats.gatewaySeats)],
        ["Inactive Devices", formatNum(data.stats.inactiveDevices)],
      ]
    ),

    spacer(),

    // OS distribution
    data.osDistribution.length > 0
      ? barChart(
          data.osDistribution.slice(0, 8).map((os) => ({
            label: os.name,
            value: os.value,
            color: "#3b82f6",
          })),
          "OS Distribution"
        )
      : "",

    spacer(),

    // WARP version distribution
    data.warpVersionDistribution.length > 0
      ? barChart(
          data.warpVersionDistribution.slice(0, 8).map((v) => ({
            label: v.name,
            value: v.value,
            color: "#8b5cf6",
          })),
          "WARP Client Versions"
        )
      : "",

    spacer(),

    // Posture rules
    data.postureRules.length > 0
      ? (() => {
          const title = sectionTitle("Device Posture Rules");
          const table = dataTable(
            [
              { label: "Rule" },
              { label: "Type" },
              { label: "Platform" },
              { label: "Requirement" },
              { label: "Devices in Scope", align: "right" as const },
            ],
            data.postureRules.slice(0, 10).map((r) => [
              r.name,
              r.type,
              r.platform,
              r.input || "\u2013",
              formatNum(r.deviceScope),
            ])
          );
          return title + table;
        })()
      : "",

    // Posture error note
    ...(data.postureError
      ? [
          sectionTitle("Posture Rules"),
          dataTable(
            [{ label: "Note" }],
            [[data.postureError]]
          ),
        ]
      : []),

    spacer(),

    // Top devices (most recently seen)
    data.devices.length > 0
      ? (() => {
          const sorted = [...data.devices].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
          const title = sectionTitle("Recently Active Devices");
          const table = dataTable(
            [
              { label: "Device" },
              { label: "User" },
              { label: "OS" },
              { label: "WARP Version" },
              { label: "Status", align: "center" as const },
            ],
            sorted.slice(0, 10).map((d) => [
              d.name,
              d.user,
              d.os,
              d.warpVersion,
              d.status.charAt(0).toUpperCase() + d.status.slice(1),
            ])
          );
          return title + table;
        })()
      : "",

    spacer(16),
    emailFooter(meta.dashboardUrl),
  ];

  return emailWrapper(
    `Devices & Users Report \u2013 ${escapeHtml(meta.accountName)}`,
    content.filter(Boolean).join("\n")
  );
}
