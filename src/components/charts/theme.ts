// Shared chart color palette and theme constants for dark mode
export const CHART_COLORS = {
  primary: "#f97316",   // orange-500
  secondary: "#3b82f6", // blue-500
  tertiary: "#10b981",  // emerald-500
  quaternary: "#a855f7", // purple-500
  quinary: "#f43f5e",   // rose-500
  senary: "#eab308",    // yellow-500
  grid: "#27272a",      // zinc-800
  axis: "#71717a",      // zinc-500
  tooltip: {
    bg: "#18181b",      // zinc-900
    border: "#3f3f46",  // zinc-700
    text: "#fafafa",    // zinc-50
    label: "#a1a1aa",   // zinc-400
  },
};

export const SERIES_COLORS = [
  "#f97316", "#3b82f6", "#10b981", "#a855f7",
  "#f43f5e", "#eab308", "#06b6d4", "#ec4899",
  "#84cc16", "#6366f1",
];

export const STATUS_COLORS: Record<string, string> = {
  "2xx": "#10b981",
  "3xx": "#3b82f6",
  "4xx": "#eab308",
  "5xx": "#ef4444",
};

export const ACTION_COLORS: Record<string, string> = {
  block: "#ef4444",
  challenge: "#eab308",
  managed_challenge: "#f97316",
  js_challenge: "#a855f7",
  challenge_solved: "#10b981",
  log: "#3b82f6",
  allow: "#10b981",
  bypass: "#6b7280",
  skip: "#6b7280",
};

export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000_000) return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}
