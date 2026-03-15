/** Build a filename for report exports: 2026-03-15-zonename-executive-report.ext */
export function buildReportFilename(
  title: string,
  ext: string,
  opts?: { zoneName?: string; accountName?: string },
): string {
  const dateStr = new Date().toISOString().split("T")[0];
  const parts = [dateStr];
  if (opts?.accountName) parts.push(opts.accountName);
  if (opts?.zoneName) parts.push(opts.zoneName);
  parts.push(title);
  return parts
    .join(" ")
    .replace(/[^a-zA-Z0-9 .-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase() + "." + ext;
}

/** Shared page title map – used by filter-bar, PDF export, and email system. */
export const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/traffic": "Traffic Overview",
  "/security": "Security Posture",
  "/ddos": "DDoS & Rate Limiting",
  "/bots": "Bot Analysis",
  "/dns": "DNS Analytics",
  "/performance": "Performance",
  "/ssl": "SSL / TLS",
  "/api-shield": "API Shield",
  "/origin-health": "Origin Health",
  "/zt-summary": "Zero Trust Summary",
  "/gateway-dns": "Gateway DNS & HTTP",
  "/gateway-network": "Gateway Network",
  "/access-audit": "Access Audit",
  "/shadow-it": "Shadow IT",
  "/devices-users": "Devices & Users",
  "/executive": "Executive Report",
  "/settings": "Settings",
  "/login": "Login",
};
