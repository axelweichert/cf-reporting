"use client";

import { createContext, useContext, useState, useEffect, useCallback, createElement, type ReactNode } from "react";

type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("cf-reporting-theme") as Theme | null;
    if (stored && stored !== theme) {
      document.documentElement.classList.toggle("light", stored === "light");
      document.documentElement.classList.toggle("dark", stored === "dark");
      // Deferred to avoid synchronous setState in effect body
      queueMicrotask(() => setTheme(stored));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("cf-reporting-theme", next);
      document.documentElement.classList.toggle("light", next === "light");
      document.documentElement.classList.toggle("dark", next === "dark");
      return next;
    });
  }, []);

  return createElement(ThemeContext.Provider, {
    value: { theme, toggleTheme },
  }, children);
}
