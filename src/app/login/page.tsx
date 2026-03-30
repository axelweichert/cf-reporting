"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Shield, Loader2, AlertCircle, Eye, EyeOff, Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/theme";
import type { UserRole } from "@/types/cloudflare";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole>("operator");
  const [viewerEnabled, setViewerEnabled] = useState(false);
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();

  // Check if viewer role is available
  useEffect(() => {
    fetch("/api/auth/login")
      .then((r) => r.json())
      .then((data) => {
        if (data.viewerEnabled) setViewerEnabled(true);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, role }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Authentication failed");
        setPassword("");
        return;
      }

      // Clear password from memory before redirect
      setPassword("");
      // Full page reload to trigger app-shell re-check of auth state
      window.location.href = "/";
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <button
        onClick={toggleTheme}
        className="absolute right-4 top-4 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/10">
            <Shield className="h-8 w-8 text-orange-500" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Cloudflare Reporting</h1>
          <p className="mt-2 text-lg text-zinc-300">
            Enter the site password to continue
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Role selector – only shown when VIEWER_PASSWORD is configured */}
          {viewerEnabled && (
            <div>
              <label htmlFor="role" className="mb-1.5 block text-sm font-semibold text-zinc-100">
                Sign in as
              </label>
              <select
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                disabled={loading}
              >
                <option value="operator">Operator – Full access</option>
                <option value="viewer">Viewer – Read-only</option>
              </select>
            </div>
          )}

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-zinc-100">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={viewerEnabled && role === "viewer" ? "Enter viewer password" : "Enter site password"}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 pr-10 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                disabled={loading}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Authenticating...
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          This instance is protected with a site password.
        </p>
      </div>
    </div>
  );
}
