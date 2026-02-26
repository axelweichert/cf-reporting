"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { CHART_COLORS, SERIES_COLORS, formatNumber } from "./theme";

interface TimeSeriesChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: Array<{
    key: string;
    label: string;
    color?: string;
    yAxisId?: "left" | "right";
  }>;
  height?: number;
  yFormatter?: (value: number) => string;
  stacked?: boolean;
}

function CustomTooltip({
  active,
  payload,
  label,
  yFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  yFormatter: (value: number) => string;
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
      <p className="mb-1 text-xs" style={{ color: CHART_COLORS.tooltip.label }}>
        {label}
      </p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span style={{ color: CHART_COLORS.tooltip.label }}>{p.name}:</span>
          <span className="font-medium" style={{ color: CHART_COLORS.tooltip.text }}>
            {yFormatter(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function TimeSeriesChart({
  data,
  xKey,
  series,
  height = 300,
  yFormatter = formatNumber,
  stacked = false,
}: TimeSeriesChartProps) {
  const hasRightAxis = series.some((s) => s.yAxisId === "right");

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 5, right: hasRightAxis ? 60 : 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
        <XAxis
          dataKey={xKey}
          stroke={CHART_COLORS.axis}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          yAxisId="left"
          stroke={CHART_COLORS.axis}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={yFormatter}
          width={60}
        />
        {hasRightAxis && (
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke={CHART_COLORS.axis}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={yFormatter}
            width={60}
          />
        )}
        <Tooltip content={<CustomTooltip yFormatter={yFormatter} />} />
        {series.length > 1 && (
          <Legend
            wrapperStyle={{ fontSize: 12, color: CHART_COLORS.axis }}
            iconType="circle"
            iconSize={8}
          />
        )}
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color || SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={s.color || SERIES_COLORS[i % SERIES_COLORS.length]}
            fillOpacity={s.yAxisId === "right" ? 0.05 : 0.1}
            strokeWidth={s.yAxisId === "right" ? 1.5 : 2}
            strokeDasharray={s.yAxisId === "right" ? "4 2" : undefined}
            stackId={stacked && !s.yAxisId ? "stack" : undefined}
            yAxisId={s.yAxisId || "left"}
            dot={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
