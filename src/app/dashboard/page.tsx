"use client";

import { useAuth } from "@/lib/store";
import Link from "next/link";
import {
  Globe,
  Shield,
  Zap,
  Bot,
  Server,
  ShieldCheck,
  Network,
  KeyRound,
  Eye,
} from "lucide-react";
import type { Permission } from "@/types/cloudflare";

interface ReportCard {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  requiredPermission?: Permission;
  category: string;
}

const reportCards: ReportCard[] = [
  {
    title: "Traffic Overview",
    description: "Requests, bandwidth, cache hit ratio, geographic distribution",
    href: "/traffic",
    icon: <Globe size={24} />,
    requiredPermission: "zone_analytics",
    category: "Web / App Security",
  },
  {
    title: "Security Posture",
    description: "WAF events, firewall rules, bot scores, top attackers",
    href: "/security",
    icon: <Shield size={24} />,
    requiredPermission: "firewall",
    category: "Web / App Security",
  },
  {
    title: "DDoS & Rate Limiting",
    description: "DDoS events, attack vectors, rate limiting triggers",
    href: "/ddos",
    icon: <Zap size={24} />,
    requiredPermission: "zone_analytics",
    category: "Web / App Security",
  },
  {
    title: "Bot Analysis",
    description: "Bot score distribution, verified bots, top user agents",
    href: "/bots",
    icon: <Bot size={24} />,
    requiredPermission: "firewall",
    category: "Web / App Security",
  },
  {
    title: "DNS Analytics",
    description: "Query volume, record types, NXDOMAIN hotspots",
    href: "/dns",
    icon: <Server size={24} />,
    requiredPermission: "dns_read",
    category: "DNS",
  },
  {
    title: "ZT Executive Summary",
    description: "Active users, blocked requests, security incidents",
    href: "/zt-summary",
    icon: <ShieldCheck size={24} />,
    requiredPermission: "zero_trust",
    category: "Zero Trust",
  },
  {
    title: "Gateway DNS & HTTP",
    description: "DNS queries, blocked domains, categories breakdown",
    href: "/gateway-dns",
    icon: <Network size={24} />,
    requiredPermission: "gateway",
    category: "Zero Trust",
  },
  {
    title: "Gateway Network",
    description: "L4 sessions, blocked IPs, posture check failures",
    href: "/gateway-network",
    icon: <Network size={24} />,
    requiredPermission: "gateway",
    category: "Zero Trust",
  },
  {
    title: "Access Audit",
    description: "Login events, app access patterns, policy denials",
    href: "/access-audit",
    icon: <KeyRound size={24} />,
    requiredPermission: "access",
    category: "Zero Trust",
  },
  {
    title: "Shadow IT",
    description: "Discovered SaaS apps, unsanctioned access, usage trends",
    href: "/shadow-it",
    icon: <Eye size={24} />,
    requiredPermission: "gateway",
    category: "Zero Trust",
  },
];

export default function DashboardPage() {
  const { capabilities } = useAuth();
  const permissions = capabilities?.permissions || [];
  const accounts = capabilities?.accounts || [];
  const zones = capabilities?.zones || [];

  const availableReports = reportCards.filter(
    (r) => !r.requiredPermission || permissions.includes(r.requiredPermission)
  );
  const unavailableReports = reportCards.filter(
    (r) => r.requiredPermission && !permissions.includes(r.requiredPermission)
  );

  const categories = [...new Set(availableReports.map((r) => r.category))];

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {accounts.length} account{accounts.length !== 1 ? "s" : ""},{" "}
            {zones.length} zone{zones.length !== 1 ? "s" : ""},{" "}
            {permissions.length} permission{permissions.length !== 1 ? "s" : ""} detected
          </p>
        </div>
      </div>

      {/* Available Reports by Category */}
      {categories.map((category) => (
        <div key={category} className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
            {category}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {availableReports
              .filter((r) => r.category === category)
              .map((report) => (
                <Link
                  key={report.href}
                  href={report.href}
                  className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-all hover:border-zinc-700 hover:bg-zinc-900"
                >
                  <div className="mb-3 text-orange-500">{report.icon}</div>
                  <h3 className="font-medium text-white group-hover:text-orange-400">
                    {report.title}
                  </h3>
                  <p className="mt-1 text-sm text-zinc-500">{report.description}</p>
                </Link>
              ))}
          </div>
        </div>
      ))}

      {/* Unavailable Reports */}
      {unavailableReports.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-600">
            Requires additional permissions
          </h2>
          <div className="grid grid-cols-1 gap-4 opacity-50 md:grid-cols-2 lg:grid-cols-3">
            {unavailableReports.map((report) => (
              <div
                key={report.href}
                className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5"
              >
                <div className="mb-3 text-zinc-600">{report.icon}</div>
                <h3 className="font-medium text-zinc-500">{report.title}</h3>
                <p className="mt-1 text-sm text-zinc-600">{report.description}</p>
                <p className="mt-2 text-xs text-zinc-600">
                  Needs: {report.requiredPermission} permission
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
