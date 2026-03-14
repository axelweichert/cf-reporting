"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/store";
import type { TokenType } from "@/types/cloudflare";
import { Shield, Eye, EyeOff, Loader2, AlertCircle, CheckCircle2, Sun, Moon, ExternalLink } from "lucide-react";
import { useTheme } from "@/lib/theme";

const TOKEN_PERMISSIONS = [
  { key: "account_settings", type: "read" },
  { key: "account_analytics", type: "read" },
  { key: "analytics", type: "read" },
  { key: "firewall_services", type: "read" },
  { key: "zone_dns", type: "read" },
  { key: "access", type: "read" },
  { key: "access_acct", type: "read" },
  { key: "access_audit_log", type: "read" },
  { key: "account_api_gateway", type: "read" },
  { key: "api_gateway", type: "read" },
  { key: "bot_management", type: "read" },
  { key: "teams", type: "read" },
  { key: "account_ssl_and_certificates", type: "read" },
  { key: "ssl_and_certificates", type: "read" },
  { key: "ddos_protection", type: "read" },
  { key: "healthcheck", type: "read" },
  { key: "load_balancers", type: "read" },
  { key: "load_balancers_account", type: "read" },
  { key: "load_balancing_monitors_and_pools", type: "read" },
];

const TOKEN_TEMPLATE_URL =
  `https://dash.cloudflare.com/profile/api-tokens?` +
  `permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))}` +
  `&accountId=*&zoneId=all` +
  `&name=${encodeURIComponent("cf-reporting")}`;

export default function SetupPage() {
  const [tokenType, setTokenType] = useState<TokenType>("user");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { setAuth, setLoading: setAuthLoading } = useAuth();
  const { theme, toggleTheme } = useTheme();

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
    <div className="relative flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <button
        onClick={toggleTheme}
        className="absolute right-4 top-4 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/10">
            <Shield className="h-8 w-8 text-orange-500" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">cf-reporting</h1>
          <p className="mt-2 text-lg text-zinc-300">
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
                className={`flex-1 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                  tokenType === type
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
                disabled={loading}
              >
                {type === "user" ? "User API Token" : "Account API Token"}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="token" className="mb-1.5 block text-sm font-semibold text-zinc-100">
              {tokenLabel}
            </label>
            <div className="relative">
              <input
                id="token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tokenPlaceholder}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 pr-10 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
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
              <p className="mt-1.5 text-sm text-zinc-400">
                Account tokens are created under Manage Account &rarr; Account API Tokens in the Cloudflare dashboard.
              </p>
            )}
          </div>

          {tokenType === "user" && (
            <a
              href={TOKEN_TEMPLATE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-orange-500/50 hover:text-white"
            >
              <ExternalLink size={14} />
              Create token on Cloudflare with pre-filled permissions
            </a>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
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
          <h3 className="mb-3 text-sm font-semibold text-zinc-100">Required permissions</h3>
          <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed">
            {[
              { name: "Account Settings", optional: false },
              { name: "Account Analytics", optional: false },
              { name: "Analytics", optional: false },
              { name: "Firewall Services", optional: false },
              { name: "DNS", optional: false },
              { name: "Access: Apps and Policies", optional: true },
              { name: "Access: Organizations, IdP, and Groups", optional: true },
              { name: "Access: Audit Logs", optional: true },
              { name: "Zero Trust", optional: true },
              { name: "API Gateway", optional: true },
              { name: "Bot Management", optional: true },
              { name: "SSL and Certificates", optional: true },
              { name: "DDoS Protection", optional: true },
              { name: "Health Checks", optional: true },
              { name: "Load Balancers", optional: true },
            ].map((p) => (
              <li key={p.name} className="flex items-center gap-2">
                <CheckCircle2 size={14} className={p.optional ? "shrink-0 text-zinc-500" : "shrink-0 text-emerald-500/70"} />
                <span>
                  {p.name}
                  <span className="ml-1 text-zinc-500">{p.optional ? "– optional" : "– read"}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-4 text-center text-sm leading-relaxed text-zinc-400">
          Your token is sent to the server and stored in an encrypted httpOnly cookie – it is never stored on disk or logged. The server decrypts it in memory per request.
        </p>
      </div>
    </div>
  );
}
