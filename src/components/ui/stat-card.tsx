"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  change?: number;
  icon?: React.ReactNode;
  href?: string;
}

export default function StatCard({ label, value, change, icon }: StatCardProps) {
  const trend = change !== undefined ? (change > 0 ? "up" : change < 0 ? "down" : "flat") : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm text-zinc-400">{label}</p>
        {icon && <div className="text-zinc-500">{icon}</div>}
      </div>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {trend && (
        <div className={`mt-2 flex items-center gap-1 text-xs ${
          trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-zinc-500"
        }`}>
          {trend === "up" && <TrendingUp size={14} />}
          {trend === "down" && <TrendingDown size={14} />}
          {trend === "flat" && <Minus size={14} />}
          <span>{change !== undefined ? `${change > 0 ? "+" : ""}${change.toFixed(1)}%` : ""} vs prev period</span>
        </div>
      )}
    </div>
  );
}
