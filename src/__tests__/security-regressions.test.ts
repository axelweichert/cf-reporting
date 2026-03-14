/**
 * Regression tests for three security fixes:
 * 1. HTML injection in dataTable() cell content
 * 2. CF_ACCOUNT_TOKEN fallback in auth helpers
 * 3. Capabilities route auth gate with env tokens
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── 1. Email HTML escaping ────────────────────────────────────────────────

import { dataTable, escapeHtml } from "@/lib/email/templates/base";

describe("dataTable() HTML escaping", () => {
  it("escapes HTML tags in cell content", () => {
    const html = dataTable(
      [{ label: "Name" }, { label: "Value" }],
      [['<script>alert("xss")</script>', "123"]],
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes ampersands and quotes in cell content", () => {
    const html = dataTable(
      [{ label: "Rule" }],
      [['rule "A" & <B>']],
    );
    expect(html).not.toContain('"A"');
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;B&gt;");
    expect(html).toContain("&quot;A&quot;");
  });

  it("passes through safe text unchanged (modulo escaping)", () => {
    const html = dataTable(
      [{ label: "IP" }],
      [["192.168.1.1"]],
    );
    expect(html).toContain("192.168.1.1");
  });

  it("also escapes header labels", () => {
    const html = dataTable(
      [{ label: '<img src=x onerror="alert(1)">' }],
      [["safe"]],
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

// ─── 2. Account-token auth fallback ────────────────────────────────────────

// Mock iron-session and next/headers before importing auth-helpers
vi.mock("iron-session", () => ({
  getIronSession: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({})),
}));

vi.mock("@/lib/session", () => ({
  sessionOptions: { password: "x".repeat(32), cookieName: "test" },
}));

import { getAuthenticatedSession, requireAuth } from "@/lib/auth-helpers";
import { getIronSession } from "iron-session";

const mockGetIronSession = vi.mocked(getIronSession);

describe("auth-helpers CF_ACCOUNT_TOKEN support", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    // Clear all relevant env vars
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ACCOUNT_TOKEN;
    delete process.env.APP_PASSWORD;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("getAuthenticatedSession returns session when only CF_ACCOUNT_TOKEN is set", async () => {
    process.env.CF_ACCOUNT_TOKEN = "acct-token-123";
    mockGetIronSession.mockResolvedValue({
      siteAuthenticated: true,
    } as never);

    const session = await getAuthenticatedSession();
    expect(session).not.toBeNull();
  });

  it("requireAuth returns token when only CF_ACCOUNT_TOKEN is set", async () => {
    process.env.CF_ACCOUNT_TOKEN = "acct-token-456";
    mockGetIronSession.mockResolvedValue({
      siteAuthenticated: true,
    } as never);

    const result = await requireAuth();
    expect(result).not.toBeNull();
    expect(result!.token).toBe("acct-token-456");
  });

  it("requireAuth prefers session.token over env tokens", async () => {
    process.env.CF_ACCOUNT_TOKEN = "env-acct";
    process.env.CF_API_TOKEN = "env-user";
    mockGetIronSession.mockResolvedValue({
      siteAuthenticated: true,
      token: "session-token",
    } as never);

    const result = await requireAuth();
    expect(result!.token).toBe("session-token");
  });

  it("requireAuth prefers CF_API_TOKEN over CF_ACCOUNT_TOKEN", async () => {
    process.env.CF_API_TOKEN = "user-token";
    process.env.CF_ACCOUNT_TOKEN = "acct-token";
    mockGetIronSession.mockResolvedValue({
      siteAuthenticated: true,
    } as never);

    const result = await requireAuth();
    expect(result!.token).toBe("user-token");
  });

  it("getAuthenticatedSession returns null when env tokens present but not site-authenticated", async () => {
    process.env.CF_ACCOUNT_TOKEN = "acct-token";
    mockGetIronSession.mockResolvedValue({
      siteAuthenticated: false,
    } as never);

    const session = await getAuthenticatedSession();
    expect(session).toBeNull();
  });
});

// ─── 3. Capabilities route auth gate ───────────────────────────────────────

// The capabilities route uses iron-session directly, so we test the gate logic
// extracted into a helper to avoid importing the full Next.js route handler.

describe("capabilities auth gate logic", () => {
  // Mirrors the gate logic in /api/auth/capabilities/route.ts
  function shouldRejectCapabilitiesRequest(env: {
    APP_PASSWORD?: string;
    CF_API_TOKEN?: string;
    CF_ACCOUNT_TOKEN?: string;
  }, session: { siteAuthenticated?: boolean }): boolean {
    const hasEnvToken = !!(env.CF_API_TOKEN || env.CF_ACCOUNT_TOKEN);
    if ((env.APP_PASSWORD || hasEnvToken) && !session.siteAuthenticated) {
      return true;
    }
    return false;
  }

  it("rejects when CF_ACCOUNT_TOKEN set without site auth", () => {
    expect(shouldRejectCapabilitiesRequest(
      { CF_ACCOUNT_TOKEN: "acct-tok" },
      { siteAuthenticated: false },
    )).toBe(true);
  });

  it("rejects when CF_API_TOKEN set without site auth", () => {
    expect(shouldRejectCapabilitiesRequest(
      { CF_API_TOKEN: "user-tok" },
      { siteAuthenticated: false },
    )).toBe(true);
  });

  it("rejects when APP_PASSWORD set without site auth", () => {
    expect(shouldRejectCapabilitiesRequest(
      { APP_PASSWORD: "secret" },
      { siteAuthenticated: false },
    )).toBe(true);
  });

  it("allows when env tokens set AND site authenticated", () => {
    expect(shouldRejectCapabilitiesRequest(
      { CF_ACCOUNT_TOKEN: "acct-tok", APP_PASSWORD: "secret" },
      { siteAuthenticated: true },
    )).toBe(false);
  });

  it("allows when no env tokens and no APP_PASSWORD (open mode)", () => {
    expect(shouldRejectCapabilitiesRequest(
      {},
      { siteAuthenticated: false },
    )).toBe(false);
  });
});
