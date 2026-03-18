"use client";

interface UsageGaugeProps {
  label: string;
  usageValue: number;
  committedAmount: number;
  unit: string;
  usagePct: number;
  warningThreshold: number;
  dataAvailable: boolean;
}

export default function UsageGauge({
  label,
  usageValue,
  committedAmount,
  unit,
  usagePct,
  warningThreshold,
  dataAvailable,
}: UsageGaugeProps) {
  const clampedPct = Math.min(usagePct, 150); // Visual cap at 150%
  const fillWidth = Math.min((clampedPct / 100) * 100, 100); // Bar max at 100%
  const thresholdPos = warningThreshold * 100; // e.g., 80

  let barColor = "#10b981"; // green
  if (usagePct >= 100) barColor = "#ef4444"; // red
  else if (usagePct >= thresholdPos) barColor = "#eab308"; // amber

  const fmt = (v: number) =>
    v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v >= 1 ? v.toFixed(2) : v.toFixed(3);

  return (
    <div className="group">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-zinc-300 truncate mr-2">{label}</span>
        <span className="text-xs text-zinc-400 whitespace-nowrap">
          {dataAvailable ? (
            <>
              <span className="font-mono" style={{ color: barColor }}>{fmt(usageValue)}</span>
              {" / "}
              <span className="font-mono">{fmt(committedAmount)}</span>
              {" "}
              <span className="text-zinc-500">{unit}</span>
              {" "}
              <span className="font-semibold" style={{ color: barColor }}>
                ({usagePct.toFixed(1)}%)
              </span>
            </>
          ) : (
            <span className="text-zinc-600 italic">No data</span>
          )}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-zinc-800 overflow-hidden">
        {dataAvailable && (
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
            style={{
              width: `${fillWidth}%`,
              backgroundColor: barColor,
            }}
          />
        )}
        {/* Warning threshold marker */}
        <div
          className="absolute inset-y-0 w-0.5 bg-zinc-500 opacity-60"
          style={{ left: `${thresholdPos}%` }}
          title={`Warning threshold: ${thresholdPos}%`}
        />
      </div>
    </div>
  );
}
