import { test, expect } from "@playwright/test";

const BASE = "http://localhost:3099";

test.describe("Setup page", () => {
  test.beforeEach(async ({ page, context }) => {
    // Authenticate via API to get site session cookie
    const loginResp = await context.request.post(`${BASE}/api/auth/login`, {
      headers: { "Content-Type": "application/json", "Origin": BASE },
      data: { password: "test123" },
    });
    expect(loginResp.ok()).toBeTruthy();

    // Delete the CF token from session so app-shell routes us to /setup
    await context.request.delete(`${BASE}/api/auth/session`);

    // Now visit setup page
    await page.goto(`${BASE}/setup`);
    await expect(page.locator("h1")).toBeVisible({ timeout: 10000 });
  });

  test("renders setup page with all elements", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("cf-reporting");
    await expect(page.locator('input[id="token"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect to Cloudflare" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Required permissions" })).toBeVisible();
  });

  test("shows token type toggle with User and Account options", async ({ page }) => {
    await expect(page.getByRole("button", { name: "User API Token" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account API Token" })).toBeVisible();
  });

  test("shows guided token creation link for User token type", async ({ page }) => {
    const link = page.getByRole("link", { name: /Create token on Cloudflare/i });
    await expect(link).toBeVisible();

    const href = await link.getAttribute("href");
    expect(href).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(href).toContain("permissionGroupKeys");
    expect(href).toContain("account_settings");
    expect(href).toContain("analytics");
    expect(href).toContain("firewall_services");
    expect(href).toContain("zone_dns");
    expect(href).toContain("access");
    expect(href).not.toContain("access_acct");
    expect(href).toContain("name=cf-reporting");
    expect(href).toContain("accountId=*");
    expect(href).toContain("zoneId=all");

    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("hides guided token creation link for Account token type", async ({ page }) => {
    await page.getByRole("button", { name: "Account API Token" }).click();
    await expect(page.getByRole("link", { name: /Create token on Cloudflare/i })).not.toBeVisible();
  });

  test("shows account token help text when Account type selected", async ({ page }) => {
    await page.getByRole("button", { name: "Account API Token" }).click();
    await expect(page.getByText(/Account tokens are created under/)).toBeVisible();
  });

  test("re-shows guided link when switching back to User type", async ({ page }) => {
    await page.getByRole("button", { name: "Account API Token" }).click();
    await expect(page.getByRole("link", { name: /Create token on Cloudflare/i })).not.toBeVisible();

    await page.getByRole("button", { name: "User API Token" }).click();
    await expect(page.getByRole("link", { name: /Create token on Cloudflare/i })).toBeVisible();
  });

  test("lists all required and optional permissions", async ({ page }) => {
    for (const perm of [
      "Account Settings (read)",
      "Zone Analytics (read)",
      "Firewall Services (read)",
      "DNS (read)",
      "Access: Apps and Policies (read)",
    ]) {
      await expect(page.getByText(perm)).toBeVisible();
    }
    // Zero Trust listed in permissions (use locator to avoid matching hint text too)
    await expect(page.locator("li", { hasText: "Zero Trust (read)" })).toBeVisible();
    // Zero Trust note
    await expect(page.getByText("includes Gateway")).toBeVisible();
    // Manual add note
    await expect(page.getByText(/must be added manually/)).toBeVisible();
  });

  test("submit button is disabled when token input is empty", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Connect to Cloudflare" })).toBeDisabled();
  });

  test("submit button becomes enabled when token is entered", async ({ page }) => {
    await page.locator('input[id="token"]').fill("test-token-value");
    await expect(page.getByRole("button", { name: "Connect to Cloudflare" })).toBeEnabled();
  });

  test("shows security notice about encrypted cookie", async ({ page }) => {
    await expect(page.getByText(/encrypted in an httpOnly cookie/)).toBeVisible();
  });
});
