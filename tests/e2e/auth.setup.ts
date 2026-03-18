import { test as setup } from "@playwright/test";

const APP_PASSWORD = "Baumhaus1";
const BASE_URL = "http://localhost:3000";
const AUTH_FILE = "/tmp/pw-auth-state.json";

setup("authenticate", async ({ page }) => {
  // Authenticate via API POST directly (avoids UI hydration timing issues)
  const response = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { password: APP_PASSWORD, role: "operator" },
    headers: {
      "Content-Type": "application/json",
      "Origin": BASE_URL,
    },
  });

  const data = await response.json();
  console.log("Login response:", response.status(), JSON.stringify(data));

  if (response.status() !== 200) {
    throw new Error(`Login failed: ${response.status()} - ${JSON.stringify(data)}`);
  }

  // Navigate to dashboard to verify the session works
  await page.goto(`${BASE_URL}/dashboard`);
  // If not authenticated, it would redirect to /login
  await page.waitForLoadState("networkidle");
  console.log("Post-login URL:", page.url());

  // Save auth state (cookies)
  await page.context().storageState({ path: AUTH_FILE });
  console.log("Auth state saved to", AUTH_FILE);
});
