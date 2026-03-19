"use client";

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
  ReferenceLine,
} from "recharts";
import { CHART_COLORS } from "./theme";
import type { ContractUsageHistoryMonth } from "@/lib/contract/types";

interface MonthlyUsageChartProps {
  months: ContractUsageHistoryMonth[];
  unit: string;
  height?: number;
  /** True for integer counts (seats, zones) – no decimals */
  snapshot?: boolean;
}

/** Format a period "YYYY-MM" to "Mon YYYY" for the X axis. */
function formatPeriodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Smart value formatting: 595.38M, 52.86M, 1.96K, 9.25, etc. */
function formatValue(v: number, integer = false): string {
  if (integer) {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return Math.round(v).toLocaleString();
  }
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  if (v > 0) return v.toFixed(3);
  return "0";
}

function formatAxis(v: number, integer = false): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  if (integer || v >= 100) return v.toFixed(0);
  return v.toFixed(2);
}

interface ChartDataPoint {
  period: string;
  label: string;
  usage: number;
  projected: number | null;
  committed: number;
}

function UsageTooltip({
  active,
  payload,
  label,
  unit,
  integer,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string; name: string }>;
  label?: string;
  unit: string;
  integer?: boolean;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-xl"
      style={{ backgroundColor: CHART_COLORS.tooltip.bg, borderColor: CHART_COLORS.tooltip.border }}
    >
      <p className="text-xs mb-1" style={{ color: CHART_COLORS.tooltip.label }}>{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="text-sm" style={{ color: p.color }}>
          {p.name}: {formatValue(p.value, integer)} {unit}
        </p>
      ))}
    </div>
  );
}

/** Custom bar label that shows the value above each bar. */
function BarLabel(props: {
  x?: number; y?: number; width?: number; value?: number; integer?: boolean;
}) {
  const { x = 0, y = 0, width = 0, value, integer } = props;
  if (!value || value === 0) return null;
  return (
    <text
      x={x + width / 2}
      y={y - 6}
      fill="#a1a1aa"
      textAnchor="middle"
      fontSize={10}
      fontWeight={500}
    >
      {formatValue(value, integer)}
    </text>
  );
}

export default function MonthlyUsageChart({
  months,
  unit,
  height = 260,
  snapshot = false,
}: MonthlyUsageChartProps) {
  const isPdf = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("_pdf") === "true";

  const fmt = (v: number) => formatValue(v, snapshot);
  const fmtAxis = (v: number) => formatAxis(v, snapshot);

  // Sort months chronologically and build chart data
  const sorted = [...months].sort((a, b) => a.period.localeCompare(b.period));

  const data: ChartDataPoint[] = sorted.map((m) => ({
    period: m.period,
    label: formatPeriodLabel(m.period),
    usage: m.projected ? 0 : m.usageValue, // If projected, usage is shown as projected bar
    projected: m.projected ?? null,
    committed: m.committedAmount,
  }));

  // For months with projected value, split: actual portion as "usage", projection as "projected"
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].projected) {
      data[i].usage = sorted[i].usageValue;
      data[i].projected = sorted[i].projected!;
    }
  }

  if (data.length === 0) return null;

  // Determine Y domain: max of usage, projected, and committed
  const maxValue = Math.max(
    ...data.map((d) => Math.max(d.usage, d.projected ?? 0, d.committed)),
  );
  const yMax = maxValue * 1.15; // 15% headroom for labels

  // Check if committed amount changes over time (for deciding line vs constant)
  const committedValues = [...new Set(data.map((d) => d.committed))];
  const hasVaryingCommitted = committedValues.length > 1;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 20, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
        <XAxis
          dataKey="label"
          stroke={CHART_COLORS.axis}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke={CHART_COLORS.axis}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={fmtAxis}
          width={55}
          domain={[0, yMax]}
        />
        <Tooltip content={<UsageTooltip unit={unit} integer={snapshot} />} />
        <Legend
          wrapperStyle={{ fontSize: 12, color: CHART_COLORS.axis }}
          iconType="circle"
          iconSize={8}
        />

        {/* Main usage bars */}
        <Bar
          dataKey="usage"
          name={`Billable ${unit}`}
          fill="#f97316"
          radius={[3, 3, 0, 0]}
          maxBarSize={48}
          isAnimationActive={!isPdf}
          label={<BarLabel integer={snapshot} />}
        >
          {data.map((d, i) => {
            // Color red if over committed, orange otherwise
            const isOver = d.usage > d.committed && d.committed > 0;
            return <Cell key={i} fill={isOver ? "#ef4444" : "#f97316"} />;
          })}
        </Bar>

        {/* Projected bar (only current partial month, stacked on top of usage) */}
        <Bar
          dataKey="projected"
          name="Projected"
          fill="#f9731666"
          radius={[3, 3, 0, 0]}
          maxBarSize={48}
          isAnimationActive={!isPdf}
          label={<BarLabel integer={snapshot} />}
        />

        {/* Committed / purchased threshold line */}
        {hasVaryingCommitted ? (
          <Line
            dataKey="committed"
            name="Purchased"
            type="stepAfter"
            stroke="#991b1b"
            strokeWidth={2}
            dot={{ r: 4, fill: "#991b1b", stroke: "#fff", strokeWidth: 1 }}
            isAnimationActive={!isPdf}
          />
        ) : (
          // Constant committed amount – use a clean reference line
          <>
            <ReferenceLine
              y={committedValues[0]}
              stroke="#991b1b"
              strokeWidth={2}
              strokeDasharray="6 3"
              label={{
                value: `Purchased: ${fmt(committedValues[0])} ${unit}`,
                position: "insideTopRight",
                fill: "#991b1b",
                fontSize: 11,
              }}
            />
            {/* Hidden line to get legend entry */}
            <Line
              dataKey="committed"
              name="Purchased"
              stroke="#991b1b"
              strokeWidth={2}
              dot={{ r: 4, fill: "#991b1b", stroke: "#fff", strokeWidth: 1 }}
              isAnimationActive={!isPdf}
              legendType="circle"
            />
          </>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
