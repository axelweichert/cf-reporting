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
import { pctChange } from "@/lib/compare-utils";

interface TimeSeriesChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: Array<{
    key: string;
    label: string;
    color: string;
    yAxisId?: "left" | "right";
    isDashed?: boolean;
    isComparison?: boolean;
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
  series,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; dataKey: string }>;
  label?: string;
  yFormatter: (value: number) => string;
  series: TimeSeriesChartProps["series"];
}) {
  if (!active || !payload?.length) return null;

  // Build a map of comparison series key → current series key for % change
  const compMap = new Map<string, string>();
  for (const s of series) {
    if (s.isComparison && s.key.startsWith("prev_")) {
      compMap.set(s.key, s.key.slice(5));
    }
  }

  // Index payload by dataKey for lookups
  const payloadByKey = new Map<string, number>();
  for (const p of payload) {
    payloadByKey.set(p.dataKey, p.value);
  }

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
      {payload.map((p, i) => {
        const seriesDef = series.find((s) => s.key === p.dataKey);
        const isComp = seriesDef?.isComparison;

        // For comparison entries, compute % change
        let changeText: string | null = null;
        if (isComp) {
          const currentKey = compMap.get(p.dataKey);
          if (currentKey) {
            const currentVal = payloadByKey.get(currentKey);
            if (currentVal !== undefined) {
              const change = pctChange(currentVal, p.value);
              if (change !== undefined) {
                const sign = change > 0 ? "+" : "";
                changeText = `${sign}${change.toFixed(1)}%`;
              }
            }
          }
        }

        return (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
            <span style={{ color: isComp ? CHART_COLORS.tooltip.border : CHART_COLORS.tooltip.label, opacity: isComp ? 0.7 : 1 }}>
              {p.name}:
            </span>
            <span className="font-medium" style={{ color: isComp ? CHART_COLORS.tooltip.border : CHART_COLORS.tooltip.text, opacity: isComp ? 0.7 : 1 }}>
              {yFormatter(p.value)}
            </span>
            {changeText && (
              <span className="text-xs text-zinc-500">{changeText}</span>
            )}
          </div>
        );
      })}
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
  const isPdf = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("_pdf") === "true";

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
        <Tooltip content={<CustomTooltip yFormatter={yFormatter} series={series} />} />
        {series.filter((s) => !s.isComparison).length > 1 && (
          <Legend
            wrapperStyle={{ fontSize: 12, color: CHART_COLORS.axis }}
            iconType="circle"
            iconSize={8}
            {...{ payload: series.filter((s) => !s.isComparison).map((s, i) => ({
              value: s.label,
              type: "circle" as const,
              color: s.color || SERIES_COLORS[i % SERIES_COLORS.length],
            })) }}
          />
        )}
        {series.map((s, i) => {
          const color = s.color || SERIES_COLORS[i % SERIES_COLORS.length];
          const isComp = s.isComparison;
          return (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={color}
              fill={color}
              fillOpacity={isComp ? 0.03 : s.yAxisId === "right" ? 0.05 : 0.1}
              strokeWidth={isComp ? 1.5 : s.yAxisId === "right" ? 1.5 : 2}
              strokeOpacity={isComp ? 0.5 : 1}
              strokeDasharray={s.isDashed ? "6 3" : s.yAxisId === "right" ? "4 2" : undefined}
              stackId={stacked && !s.yAxisId && !isComp ? "stack" : undefined}
              yAxisId={s.yAxisId || "left"}
              dot={false}
              isAnimationActive={!isPdf}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}
