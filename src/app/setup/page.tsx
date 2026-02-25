"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/store";
import type { TokenType } from "@/types/cloudflare";
import { Shield, Eye, EyeOff, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

export default function SetupPage() {
  const [tokenType, setTokenType] = useState<TokenType>("user");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { setAuth, setLoading: setAuthLoading } = useAuth();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), tokenType }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to validate token");
        return;
      }

      setAuth(true, data.capabilities);
      setAuthLoading(false);
      router.replace("/dashboard");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const tokenLabel = tokenType === "user" ? "User API Token" : "Account API Token";
  const tokenPlaceholder =
    tokenType === "user"
      ? "Enter your Cloudflare User API token"
      : "Enter your Cloudflare Account API token";

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/10">
            <Shield className="h-8 w-8 text-orange-500" />
          </div>
          <h1 className="text-2xl font-bold text-white">cf-reporting</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Enter your Cloudflare API token to get started
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Token type toggle */}
          <div className="flex rounded-lg border border-zinc-700 bg-zinc-900 p-1">
            {(["user", "account"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setTokenType(type);
                  setToken("");
                  setError(null);
                }}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  tokenType === type
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-300"
                }`}
                disabled={loading}
              >
                {type === "user" ? "User API Token" : "Account API Token"}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="token" className="mb-1.5 block text-sm font-medium text-zinc-300">
              {tokenLabel}
            </label>
            <div className="relative">
              <input
                id="token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tokenPlaceholder}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 pr-10 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                disabled={loading}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                tabIndex={-1}
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {tokenType === "account" && (
              <p className="mt-1.5 text-xs text-zinc-500">
                Account tokens are created under Manage Account &rarr; Account API Tokens in the Cloudflare dashboard.
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Validating token...
              </>
            ) : (
              "Connect to Cloudflare"
            )}
          </button>
        </form>

        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-2 text-sm font-medium text-zinc-300">Required permissions</h3>
          <ul className="space-y-1.5 text-xs text-zinc-500">
            {[
              "Account Settings (read)",
              "Zone Analytics (read)",
              "Firewall Services (read)",
              "DNS (read)",
              "Zero Trust (read) – optional",
              "Access: Apps and Policies (read) – optional",
              "Gateway (read) – optional",
            ].map((p) => (
              <li key={p} className="flex items-center gap-2">
                <CheckCircle2 size={12} className="text-zinc-600" />
                {p}
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-4 text-center text-xs text-zinc-600">
          Your token is encrypted in an httpOnly cookie – it never reaches client-side JavaScript and is never stored on disk. The server only decrypts it in memory per request.
        </p>
      </div>
    </div>
  );
}
