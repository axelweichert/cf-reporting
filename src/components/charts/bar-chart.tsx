"use client";

import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";
import { CHART_COLORS, SERIES_COLORS, formatNumber } from "./theme";

interface HorizontalBarChartProps {
  data: Array<{ name: string; value: number; color?: string }>;
  height?: number;
  valueFormatter?: (value: number) => string;
  barColor?: string;
}

function BarTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  valueFormatter: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-xl"
      style={{
        backgroundColor: CHART_COLORS.tooltip.bg,
        borderColor: CHART_COLORS.tooltip.border,
      }}
    >
      <p className="text-xs" style={{ color: CHART_COLORS.tooltip.label }}>{label}</p>
      <p className="text-sm font-medium" style={{ color: CHART_COLORS.tooltip.text }}>
        {valueFormatter(payload[0].value)}
      </p>
    </div>
  );
}

export function HorizontalBarChart({
  data,
  height,
  valueFormatter = formatNumber,
  barColor = CHART_COLORS.primary,
}: HorizontalBarChartProps) {
  const chartHeight = height || Math.max(200, data.length * 36);
  const isPdf = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("_pdf") === "true";

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <RechartsBarChart data={data} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} horizontal={false} />
        <XAxis
          type="number"
          stroke={CHART_COLORS.axis}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={valueFormatter}
        />
        <YAxis
          type="category"
          dataKey="name"
          stroke={CHART_COLORS.axis}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={120}
        />
        <Tooltip content={<BarTooltip valueFormatter={valueFormatter} />} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={!isPdf}>
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color || barColor} />
          ))}
        </Bar>
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}

interface GroupedBarChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: Array<{
    key: string;
    label: string;
    color?: string;
  }>;
  height?: number;
  yFormatter?: (value: number) => string;
  stacked?: boolean;
}

export function GroupedBarChart({
  data,
  xKey,
  series,
  height = 300,
  yFormatter = formatNumber,
  stacked = false,
}: GroupedBarChartProps) {
  const isPdf = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("_pdf") === "true";

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
        <XAxis
          dataKey={xKey}
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
          tickFormatter={yFormatter}
          width={60}
        />
        <Tooltip content={<BarTooltip valueFormatter={yFormatter} />} />
        {series.length > 1 && (
          <Legend
            wrapperStyle={{ fontSize: 12, color: CHART_COLORS.axis }}
            iconType="circle"
            iconSize={8}
          />
        )}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.color || SERIES_COLORS[i % SERIES_COLORS.length]}
            stackId={stacked ? "stack" : undefined}
            radius={stacked ? undefined : [4, 4, 0, 0]}
            maxBarSize={40}
            isAnimationActive={!isPdf}
          />
        ))}
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
