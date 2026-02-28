"use client";

import { useFilterStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { exportPDF, exportHTML } from "@/lib/export";
import { PAGE_TITLES } from "@/lib/report-pages";
import {
  PanelLeftClose,
  PanelLeft,
  Calendar,
  Sun,
  Moon,
  Download,
  Loader2,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { CloudflareAccount, CloudflareZone } from "@/types/cloudflare";
import { useState, useRef, useEffect } from "react";

interface FilterBarProps {
  accounts: CloudflareAccount[];
  zones: CloudflareZone[];
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

const TIME_RANGES = [
  { label: "1D", value: "1d" },
  { label: "7D", value: "7d" },
  { label: "30D", value: "30d" },
] as const;

type TimeRange = (typeof TIME_RANGES)[number]["value"] | "custom";

export default function FilterBar({
  accounts,
  zones,
  sidebarCollapsed,
  onToggleSidebar,
}: FilterBarProps) {
  const {
    selectedAccount,
    setSelectedAccount,
    selectedZone,
    setSelectedZone,
    timeRange,
    setTimeRange,
    compareEnabled,
    setCompareEnabled,
    customStart,
    customEnd,
    setCustomRange,
  } = useFilterStore();
  const { theme, toggleTheme } = useTheme();
  const pathname = usePathname();

  const [showCustom, setShowCustom] = useState(false);
  const [zoneSearch, setZoneSearch] = useState("");
  const [showZoneDropdown, setShowZoneDropdown] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const zoneDropdownRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const selectedZoneName = zones.find((z) => z.id === selectedZone)?.name;
  const selectedAccountName = accounts.find((a) => a.id === selectedAccount)?.name;

  const handlePdfExport = async () => {
    setPdfLoading(true);
    setShowExportMenu(false);
    try {
      await exportPDF({
        pathname,
        zone: selectedZone,
        account: selectedAccount,
        timeRange,
        customStart,
        customEnd,
        zoneName: selectedZoneName,
        accountName: selectedAccountName,
      });
    } finally {
      setPdfLoading(false);
    }
  };

  const isReportPage = pathname !== "/" && pathname !== "/setup" && pathname !== "/dashboard" && pathname !== "/settings" && pathname !== "/login";

  const filteredZones = zones.filter((z) => {
    if (selectedAccount && z.account.id !== selectedAccount) return false;
    if (zoneSearch) return z.name.toLowerCase().includes(zoneSearch.toLowerCase());
    return true;
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (zoneDropdownRef.current && !zoneDropdownRef.current.contains(e.target as Node)) {
        setShowZoneDropdown(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 print:hidden">
      {/* Left side */}
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          aria-label="Toggle sidebar"
        >
          {sidebarCollapsed ? <PanelLeft size={20} /> : <PanelLeftClose size={20} />}
        </button>

        {/* Account picker */}
        <select
          value={selectedAccount || ""}
          onChange={(e) => {
            setSelectedAccount(e.target.value || null);
          }}
          className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200 outline-none focus:border-orange-500"
        >
          {accounts.length <= 1 ? (
            accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))
          ) : (
            <>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </>
          )}
        </select>

        {/* Zone picker with search */}
        <div className="relative" ref={zoneDropdownRef}>
          <button
            onClick={() => setShowZoneDropdown(!showZoneDropdown)}
            className="flex h-9 min-w-[160px] items-center justify-between rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200 hover:border-zinc-600"
          >
            <span className={selectedZone ? "text-zinc-200" : "text-zinc-500"}>
              {selectedZoneName || "Select zone"}
            </span>
            <svg className="ml-2 h-4 w-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showZoneDropdown && (
            <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
              <input
                type="text"
                placeholder="Search zones..."
                value={zoneSearch}
                onChange={(e) => setZoneSearch(e.target.value)}
                className="w-full border-b border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
                autoFocus
              />
              <div className="max-h-60 overflow-y-auto">
                <button
                  onClick={() => { setSelectedZone(null); setShowZoneDropdown(false); }}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-800 ${
                    !selectedZone ? "text-orange-400" : "text-zinc-300"
                  }`}
                >
                  All zones
                </button>
                {filteredZones.map((z) => (
                  <button
                    key={z.id}
                    onClick={() => { setSelectedZone(z.id); setShowZoneDropdown(false); setZoneSearch(""); }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-800 ${
                      selectedZone === z.id ? "text-orange-400" : "text-zinc-300"
                    }`}
                  >
                    {z.name}
                  </button>
                ))}
                {filteredZones.length === 0 && (
                  <p className="px-3 py-2 text-sm text-zinc-500">No zones found</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        {TIME_RANGES.map((t) => (
          <button
            key={t.value}
            onClick={() => { setTimeRange(t.value); setShowCustom(false); }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              timeRange === t.value && !showCustom
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}

        {/* Custom date range */}
        <div className="relative">
          <button
            onClick={() => {
              setShowCustom(!showCustom);
              if (!showCustom) setTimeRange("custom" as TimeRange);
            }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              timeRange === "custom"
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            <Calendar size={14} />
            Custom
          </button>
          {showCustom && (
            <div className="absolute right-0 top-full z-50 mt-1 rounded-md border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={customStart || ""}
                  onChange={(e) => setCustomRange(e.target.value, customEnd || "")}
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
                />
                <span className="text-zinc-500">to</span>
                <input
                  type="date"
                  value={customEnd || ""}
                  onChange={(e) => setCustomRange(customStart || "", e.target.value)}
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
                />
              </div>
            </div>
          )}
        </div>

        {/* Export dropdown */}
        {isReportPage && (
          <>
            <div className="mx-1 h-6 w-px bg-zinc-700" />
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => !pdfLoading && setShowExportMenu(!showExportMenu)}
                disabled={pdfLoading}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors print:hidden disabled:opacity-60"
                aria-label="Download report"
              >
                {pdfLoading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                {pdfLoading ? "Generating..." : "Export"}
              </button>
              {showExportMenu && !pdfLoading && (
                <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                  <button
                    onClick={handlePdfExport}
                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  >
                    Download as PDF
                  </button>
                  <button
                    onClick={() => { exportHTML(PAGE_TITLES[pathname] || "Report", selectedAccountName, selectedZoneName); setShowExportMenu(false); }}
                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  >
                    Download as HTML
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Divider */}
        <div className="mx-1 h-6 w-px bg-zinc-700" />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* Divider */}
        <div className="mx-1 h-6 w-px bg-zinc-700" />

        {/* Compare toggle */}
        <label className="flex cursor-pointer items-center gap-2">
          <div
            className={`relative h-5 w-9 rounded-full transition-colors ${
              compareEnabled ? "bg-orange-500" : "bg-zinc-700"
            }`}
            onClick={() => setCompareEnabled(!compareEnabled)}
          >
            <div
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                compareEnabled ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </div>
          <span className="text-sm text-zinc-400">Compare</span>
        </label>
      </div>
    </div>
  );
}
