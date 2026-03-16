"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Globe,
  Shield,
  Zap,
  Bot,
  Server,
  FileText,
  ShieldCheck,
  Network,
  KeyRound,
  Eye,
  Monitor,
  ChevronDown,
  ChevronRight,
  Gauge,
  Lock,
  ShieldEllipsis,
  HeartPulse,
  Settings,
  Database,
} from "lucide-react";
import { useState } from "react";
import type { Permission, UserRole } from "@/types/cloudflare";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  requiredPermission?: Permission;
  operatorOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: <LayoutDashboard size={18} /> },
    ],
  },
  {
    label: "Web / App Security",
    items: [
      { label: "Traffic", href: "/traffic", icon: <Globe size={18} />, requiredPermission: "zone_analytics" },
      { label: "Security Posture", href: "/security", icon: <Shield size={18} />, requiredPermission: "firewall" },
      { label: "DDoS & Rate Limiting", href: "/ddos", icon: <Zap size={18} />, requiredPermission: "zone_analytics" },
      { label: "Bot Analysis", href: "/bots", icon: <Bot size={18} />, requiredPermission: "firewall" },
      { label: "Performance", href: "/performance", icon: <Gauge size={18} />, requiredPermission: "zone_analytics" },
      { label: "SSL / TLS", href: "/ssl", icon: <Lock size={18} />, requiredPermission: "zone_analytics" },
      { label: "API Shield", href: "/api-shield", icon: <ShieldEllipsis size={18} />, requiredPermission: "zone_analytics" },
      { label: "Origin Health", href: "/origin-health", icon: <HeartPulse size={18} />, requiredPermission: "zone_analytics" },
    ],
  },
  {
    label: "DNS",
    items: [
      { label: "DNS Analytics", href: "/dns", icon: <Server size={18} />, requiredPermission: "dns_read" },
    ],
  },
  {
    label: "Zero Trust",
    items: [
      { label: "ZT Summary", href: "/zt-summary", icon: <ShieldCheck size={18} />, requiredPermission: "zero_trust" },
      { label: "Gateway DNS & HTTP", href: "/gateway-dns", icon: <Network size={18} />, requiredPermission: "gateway" },
      { label: "Gateway Network", href: "/gateway-network", icon: <Network size={18} />, requiredPermission: "gateway" },
      { label: "Access Audit", href: "/access-audit", icon: <KeyRound size={18} />, requiredPermission: "access" },
      { label: "Shadow IT", href: "/shadow-it", icon: <Eye size={18} />, requiredPermission: "gateway" },
      { label: "Devices & Users", href: "/devices-users", icon: <Monitor size={18} />, requiredPermission: "zero_trust" },
    ],
  },
  {
    label: "Reports",
    items: [
      { label: "Executive Report", href: "/executive", icon: <FileText size={18} /> },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Data History", href: "/history", icon: <Database size={18} />, operatorOnly: true },
      { label: "Settings", href: "/settings", icon: <Settings size={18} />, operatorOnly: true },
    ],
  },
];

interface SidebarProps {
  collapsed: boolean;
  permissions: Permission[];
  role: UserRole;
}

export default function Sidebar({ collapsed, permissions, role }: SidebarProps) {
  const pathname = usePathname();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(navGroups.map((g) => g.label))
  );

  const toggleGroup = (label: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const isVisible = (item: NavItem) => {
    if (item.operatorOnly && role === "viewer") return false;
    if (!item.requiredPermission) return true;
    return permissions.includes(item.requiredPermission);
  };

  return (
    <aside
      className={`fixed left-0 top-0 z-30 h-screen border-r border-zinc-800 bg-zinc-950 transition-all duration-200 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex h-14 items-center border-b border-zinc-800 px-4">
        {!collapsed && (
          <span className="text-lg font-semibold text-white">cf-reporting</span>
        )}
      </div>

      <nav className="mt-2 space-y-1 overflow-y-auto px-2" style={{ height: "calc(100vh - 3.5rem)" }}>
        {navGroups.map((group) => {
          const visibleItems = group.items.filter(isVisible);
          if (visibleItems.length === 0) return null;
          const expanded = expandedGroups.has(group.label);

          return (
            <div key={group.label} className="mb-1">
              {!collapsed && (
                <button
                  onClick={() => toggleGroup(group.label)}
                  className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {group.label}
                </button>
              )}

              {(collapsed || expanded) &&
                visibleItems.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? "bg-orange-500/10 text-orange-400"
                          : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      } ${collapsed ? "justify-center" : ""}`}
                      title={collapsed ? item.label : undefined}
                    >
                      {item.icon}
                      {!collapsed && <span>{item.label}</span>}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
