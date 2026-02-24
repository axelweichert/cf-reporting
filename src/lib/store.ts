"use client";

import { createContext, useContext, useState, useCallback, createElement, type ReactNode } from "react";
import type { Permission, CloudflareAccount, CloudflareZone, TokenCapabilities } from "@/types/cloudflare";

// ---- Filter Store ----
interface FilterState {
  selectedAccount: string | null;
  setSelectedAccount: (id: string | null) => void;
  selectedZone: string | null;
  setSelectedZone: (id: string | null) => void;
  timeRange: string;
  setTimeRange: (range: string) => void;
  compareEnabled: boolean;
  setCompareEnabled: (enabled: boolean) => void;
  customStart: string | null;
  customEnd: string | null;
  setCustomRange: (start: string, end: string) => void;
}

const FilterContext = createContext<FilterState | null>(null);

export function useFilterStore(): FilterState {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilterStore must be used within FilterProvider");
  return ctx;
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("7d");
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [customStart, setCustomStart] = useState<string | null>(null);
  const [customEnd, setCustomEnd] = useState<string | null>(null);

  const setCustomRange = useCallback((start: string, end: string) => {
    setCustomStart(start);
    setCustomEnd(end);
  }, []);

  return createElement(FilterContext.Provider, {
    value: {
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
    },
  }, children);
}

// ---- Auth Store ----
interface AuthState {
  authenticated: boolean;
  capabilities: TokenCapabilities | null;
  loading: boolean;
  setAuth: (auth: boolean, capabilities: TokenCapabilities | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [capabilities, setCapabilities] = useState<TokenCapabilities | null>(null);
  const [loading, setLoading] = useState(true);

  const setAuth = useCallback((auth: boolean, caps: TokenCapabilities | null) => {
    setAuthenticated(auth);
    setCapabilities(caps);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    setAuthenticated(false);
    setCapabilities(null);
  }, []);

  return createElement(AuthContext.Provider, {
    value: { authenticated, capabilities, loading, setAuth, setLoading, logout },
  }, children);
}

// Helper: get date range from time range string
export function getDateRange(timeRange: string, customStart?: string | null, customEnd?: string | null): { start: string; end: string } {
  const end = new Date();
  const start = new Date();

  if (timeRange === "custom" && customStart && customEnd) {
    return { start: customStart, end: customEnd };
  }

  switch (timeRange) {
    case "1d":
      start.setDate(start.getDate() - 1);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    case "7d":
    default:
      start.setDate(start.getDate() - 7);
      break;
  }

  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}
