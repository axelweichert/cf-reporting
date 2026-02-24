"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { CHART_COLORS, SERIES_COLORS, formatNumber } from "./theme";

interface DonutChartProps {
  data: Array<{ name: string; value: number; color?: string }>;
  height?: number;
  innerRadius?: number;
  outerRadius?: number;
  showLegend?: boolean;
  centerLabel?: string;
  centerValue?: string;
  valueFormatter?: (value: number) => string;
}

function CustomTooltip({
  active,
  payload,
  valueFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: { color?: string } }>;
  valueFormatter: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;

  const item = payload[0];
  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-xl"
      style={{
        backgroundColor: CHART_COLORS.tooltip.bg,
        borderColor: CHART_COLORS.tooltip.border,
      }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span style={{ color: CHART_COLORS.tooltip.label }}>{item.name}:</span>
        <span className="font-medium" style={{ color: CHART_COLORS.tooltip.text }}>
          {valueFormatter(item.value)}
        </span>
      </div>
    </div>
  );
}

export default function DonutChart({
  data,
  height = 250,
  innerRadius = 60,
  outerRadius = 90,
  showLegend = true,
  centerLabel,
  centerValue,
  valueFormatter = formatNumber,
}: DonutChartProps) {
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            dataKey="value"
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.color || SERIES_COLORS[index % SERIES_COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
          {showLegend && (
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              wrapperStyle={{ fontSize: 12, paddingLeft: 16 }}
              iconType="circle"
              iconSize={8}
              formatter={(value: string) => (
                <span className="text-zinc-400">{value}</span>
              )}
            />
          )}
        </PieChart>
      </ResponsiveContainer>
      {centerLabel && centerValue && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center" style={{ marginRight: showLegend ? 80 : 0 }}>
            <p className="text-2xl font-semibold text-white">{centerValue}</p>
            <p className="text-xs text-zinc-500">{centerLabel}</p>
          </div>
        </div>
      )}
    </div>
  );
}
