import { test, expect, type Page } from "@playwright/test";

const BASE_URL = "http://localhost:3000";

// =============================================================================
// Scoped locator helpers
// =============================================================================

/**
 * The contract line items section on /settings is a rounded-xl div whose
 * heading is "Contract Line Items". We scope all settings-page contract
 * interactions to this section so we don't accidentally hit other tables.
 */
function contractSection(page: Page) {
  return page.locator("div.rounded-xl", { hasText: "Contract Line Items" }).first();
}

/**
 * On /contract-usage the main content area is the max-w-7xl div.
 * The month period select is in main content (not the filter bar header select).
 */
function mainContent(page: Page) {
  return page.getByRole("main");
}

// =============================================================================
// Authenticated Test Suite (storageState provided by setup project)
// =============================================================================

test.describe("Contract Usage / License Tracking", () => {

  // =========================================================================
  // 1. Login verification
  // =========================================================================
  test("01 - Login succeeds and reaches dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await expect(page).toHaveURL(/\/(dashboard)?$/);
    await expect(page.locator("body")).toContainText(/dashboard|cf-reporting/i);
  });

  // =========================================================================
  // 2. Sidebar navigation - License group
  // =========================================================================
  test("02 - Sidebar shows License group with Contract Usage link", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    await expect(sidebar.getByText("License", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Contract Usage")).toBeVisible();
  });

  // =========================================================================
  // 3. Contract Usage page - initial empty state
  // =========================================================================
  test("03 - Contract Usage page loads with empty state", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await cleanupAllLineItems(page);

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    const main = mainContent(page);

    // Disclaimer banner
    await expect(
      main.getByText("Usage estimates based on analytics data"),
    ).toBeVisible();

    // Month selector (in main content, not filter bar)
    const monthSelect = main.locator("select");
    await expect(monthSelect).toBeVisible();

    const options = await monthSelect.locator("option").allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options[0]).toMatch(/\w+ \d{4}/);

    // Empty state
    await expect(
      main.getByText("No contract line items configured"),
    ).toBeVisible();

    // Hint text mentioning Settings (scoped to main, avoids sidebar "Settings" link)
    await expect(
      main.getByText(/Settings.*Contract/),
    ).toBeVisible();

    reportErrors(consoleErrors, "03");
  });

  // =========================================================================
  // 4. Recalculate button visible for operator
  // =========================================================================
  test("04 - Recalculate button is visible for operator", async ({ page }) => {
    await ensureLineItem(page, "cdn-data-transfer", 100);

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    await expect(
      mainContent(page).getByRole("button", { name: /Recalculate/i }),
    ).toBeVisible();
  });

  // =========================================================================
  // 5. Settings - Contract Line Items section
  // =========================================================================
  test("05 - Settings page shows Contract Line Items section", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByText("Contract Line Items")).toBeVisible();
    await expect(section.getByText("Configure your Cloudflare contract entitlements")).toBeVisible();
    await expect(section.getByRole("button", { name: /Detect Available Products/i })).toBeVisible();
    await expect(section.getByRole("button", { name: /Add from Catalog/i })).toBeVisible();

    reportErrors(consoleErrors, "05");
  });

  // =========================================================================
  // 6. Detect Available Products
  // =========================================================================
  test("06 - Detect Available Products shows results", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    await section.getByRole("button", { name: /Detect Available Products/i }).click();

    await expect(section.getByText("Detected Products")).toBeVisible({ timeout: 15_000 });

    const checkboxes = section.locator('input[type="checkbox"]');
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThan(0);

    const badges = await section.locator("span:has-text('detected')").count();
    console.log(`Detection: ${checkboxCount} products, ${badges} with "detected" badge`);

    await expect(section.getByRole("button", { name: /Cancel/i })).toBeVisible();
    await expect(section.getByRole("button", { name: /Add.*Selected/i })).toBeVisible();
  });

  // =========================================================================
  // 7. Add from Catalog shows dropdown
  // =========================================================================
  test("07 - Add from Catalog shows product dropdown grouped by category", async ({ page }) => {
    await cleanupAllLineItems(page);

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    await section.getByRole("button", { name: /Add from Catalog/i }).click();

    await expect(section.getByText("Add Line Item")).toBeVisible();

    const productSelect = section.locator("select").filter({ has: page.locator("optgroup") });
    await expect(productSelect).toBeVisible();

    const optgroups = productSelect.locator("optgroup");
    const groupCount = await optgroups.count();
    expect(groupCount).toBeGreaterThan(0);
    console.log(`Catalog dropdown: ${groupCount} category groups`);

    await expect(section.locator('input[placeholder="e.g. 40"]')).toBeVisible();
    await expect(section.locator('input[min="0.01"][max="1"]')).toBeVisible();

    const addBtn = section.getByRole("button", { name: "Add", exact: true });
    await expect(addBtn).toBeVisible();
    await expect(addBtn).toBeDisabled();
  });

  // =========================================================================
  // 8. Add a line item via catalog form
  // =========================================================================
  test("08 - Add a contract line item from catalog", async ({ page }) => {
    await cleanupAllLineItems(page);

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    await section.getByRole("button", { name: /Add from Catalog/i }).click();
    await expect(section.getByText("Add Line Item")).toBeVisible();

    const productSelect = section.locator("select").filter({ has: page.locator("optgroup") });
    await productSelect.selectOption("cdn-data-transfer");

    await section.locator('input[placeholder="e.g. 40"]').fill("100");

    const addBtn = section.getByRole("button", { name: "Add", exact: true });
    await expect(addBtn).toBeEnabled();
    await addBtn.click();

    await expect(section.getByText("Line item added")).toBeVisible({ timeout: 10_000 });

    // Table visible in the contract section
    await expect(section.locator("th:has-text('Product')")).toBeVisible();
    await expect(section.locator("th:has-text('Committed')")).toBeVisible();
  });

  // =========================================================================
  // 9. Add multiple line items and verify table
  // =========================================================================
  test("09 - Add multiple line items and verify table", async ({ page }) => {
    await cleanupAllLineItems(page);

    await addLineItemViaApi(page, "cdn-data-transfer", 100);
    await addLineItemViaApi(page, "cdn-requests", 500);
    await addLineItemViaApi(page, "dns-queries", 200);

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    const rows = section.locator("tbody tr");
    await expect(rows).toHaveCount(3, { timeout: 5_000 });
    console.log("Table has 3 line item rows as expected");
  });

  // =========================================================================
  // 10. Edit a line item inline
  // =========================================================================
  test("10 - Edit a contract line item committed amount", async ({ page }) => {
    await cleanupAllLineItems(page);
    await addLineItemViaApi(page, "cdn-data-transfer", 100);

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    const firstRow = section.locator("tbody tr").first();
    await expect(firstRow).toBeVisible();

    // Click edit (pencil) button -- first button in the Actions cell
    const actionsCell = firstRow.locator("td").last();
    const editBtn = actionsCell.locator("button").first();
    await editBtn.click();

    // Number input appears for committed amount
    const amountInput = firstRow.locator('input[type="number"]').first();
    await expect(amountInput).toBeVisible();
    await amountInput.fill("150");

    // Save
    const saveBtn = firstRow.getByRole("button", { name: "Save" });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Save dismisses
    await expect(saveBtn).not.toBeVisible({ timeout: 5_000 });

    // Value updated
    await expect(firstRow).toContainText("150");
  });

  // =========================================================================
  // 11. Toggle enabled/disabled
  // =========================================================================
  test("11 - Toggle line item enabled/disabled", async ({ page }) => {
    await cleanupAllLineItems(page);
    await addLineItemViaApi(page, "cdn-data-transfer", 100);

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    const firstRow = section.locator("tbody tr").first();
    await expect(firstRow).toBeVisible();

    // The Enabled column (6th col, index 5)
    const enabledCell = firstRow.locator("td").nth(5);
    const toggleBtn = enabledCell.locator("button");
    await expect(toggleBtn).toBeVisible();

    // Toggle off and back on
    await toggleBtn.click();
    await page.waitForTimeout(500);
    await expect(firstRow).toBeVisible();

    await toggleBtn.click();
    await page.waitForTimeout(500);
    await expect(firstRow).toBeVisible();
  });

  // =========================================================================
  // 12. Delete a line item
  // =========================================================================
  test("12 - Delete a contract line item", async ({ page }) => {
    await cleanupAllLineItems(page);
    await addLineItemViaApi(page, "cdn-data-transfer", 100);
    await addLineItemViaApi(page, "cdn-requests", 500);

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    await expect(section.locator("tbody tr")).toHaveCount(2, { timeout: 5_000 });

    // Delete first row
    const firstRow = section.locator("tbody tr").first();
    const actionsCell = firstRow.locator("td").last();
    const deleteBtn = actionsCell.locator("button").last();
    await deleteBtn.click();

    await expect(section.locator("tbody tr")).toHaveCount(1, { timeout: 5_000 });
  });

  // =========================================================================
  // 13. Contract Usage page with configured items
  // =========================================================================
  test("13 - Contract Usage page shows items after configuration", async ({ page }) => {
    await cleanupAllLineItems(page);
    await addLineItemViaApi(page, "cdn-data-transfer", 100);
    await addLineItemViaApi(page, "cdn-requests", 500);

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    const main = mainContent(page);

    await expect(main.getByText("Usage estimates based on analytics data")).toBeVisible();

    // Summary cards
    await expect(main.getByText("Items Tracked")).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText("At Warning")).toBeVisible();
    await expect(main.getByText("Over Limit")).toBeVisible();
    await expect(main.getByText("Health", { exact: true })).toBeVisible();

    // CDN category
    await expect(main.locator("text=CDN").first()).toBeVisible();
  });

  // =========================================================================
  // 14. Recalculate usage
  // =========================================================================
  test("14 - Recalculate button triggers usage calculation", async ({ page }) => {
    await ensureLineItem(page, "cdn-data-transfer", 100);

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    const main = mainContent(page);
    const recalcBtn = main.getByRole("button", { name: /Recalculate/i });
    await expect(recalcBtn).toBeVisible();
    await recalcBtn.click();

    // Wait for completion
    await expect(recalcBtn).toContainText("Recalculate", { timeout: 15_000 });
    await expect(main.getByText("Items Tracked")).toBeVisible();
  });

  // =========================================================================
  // 15. Month selector changes period
  // =========================================================================
  test("15 - Month selector changes the displayed period", async ({ page }) => {
    await ensureLineItem(page, "cdn-data-transfer", 100);

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    const main = mainContent(page);
    const monthSelect = main.locator("select");
    await expect(monthSelect).toBeVisible();

    const options = await monthSelect.locator("option").allInnerTexts();
    expect(options.length).toBeGreaterThanOrEqual(2);

    // Select previous month
    const secondVal = await monthSelect.locator("option").nth(1).getAttribute("value");
    if (secondVal) {
      await monthSelect.selectOption(secondVal);
      await page.waitForTimeout(1_500);
      await expect(main.getByText("Items Tracked")).toBeVisible();
    }
  });

  // =========================================================================
  // 16. API: GET /api/contract/catalog
  // =========================================================================
  test("16 - API: GET /api/contract/catalog returns product catalog", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/contract/catalog`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("catalog");
    expect(Array.isArray(data.catalog)).toBe(true);
    expect(data.catalog.length).toBeGreaterThan(0);

    const first = data.catalog[0];
    expect(first).toHaveProperty("key");
    expect(first).toHaveProperty("displayName");
    expect(first).toHaveProperty("category");
    expect(first).toHaveProperty("unit");
    expect(first).toHaveProperty("description");

    const categories = new Set(data.catalog.map((c: { category: string }) => c.category));
    console.log(`Catalog: ${data.catalog.length} products, categories: ${Array.from(categories).join(", ")}`);
    expect(categories.has("CDN")).toBe(true);
  });

  // =========================================================================
  // 17. API: GET /api/contract/line-items
  // =========================================================================
  test("17 - API: GET /api/contract/line-items returns items list", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/contract/line-items`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBe(true);
    console.log(`Line items count: ${data.items.length}`);
  });

  // =========================================================================
  // 18. API: GET /api/contract/usage
  // =========================================================================
  test("18 - API: GET /api/contract/usage returns usage data", async ({ page }) => {
    const period = currentPeriodStr();
    const response = await page.request.get(`${BASE_URL}/api/contract/usage?period=${period}`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("period", period);
    expect(data).toHaveProperty("entries");
    expect(data).toHaveProperty("summary");
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.summary).toHaveProperty("totalItems");
    expect(data.summary).toHaveProperty("atWarning");
    expect(data.summary).toHaveProperty("overLimit");
    expect(data.summary).toHaveProperty("healthPct");

    console.log(`Usage for ${period}: ${data.entries.length} entries, summary:`, data.summary);
  });

  // =========================================================================
  // 19. API: Invalid period format
  // =========================================================================
  test("19 - API: Invalid period format returns 400", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/contract/usage?period=invalid`);
    expect(response.status()).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid period format");
  });

  // =========================================================================
  // 20. API: POST empty items
  // =========================================================================
  test("20 - API: POST line-items with empty items returns 400", async ({ page }) => {
    const response = await page.request.post(`${BASE_URL}/api/contract/line-items`, {
      data: { items: [] },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });
    expect(response.status()).toBe(400);
  });

  // =========================================================================
  // 21. API: POST creates item
  // =========================================================================
  test("21 - API: POST line-items creates item successfully", async ({ page }) => {
    await deleteLineItemByKey(page, "waf-data-transfer");

    const response = await page.request.post(`${BASE_URL}/api/contract/line-items`, {
      data: {
        item: { productKey: "waf-data-transfer", committedAmount: 50, warningThreshold: 0.8 },
      },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });

    expect(response.status()).toBe(201);
    const data = await response.json();
    expect(data.created.length).toBe(1);
    expect(data.created[0]).toHaveProperty("productKey", "waf-data-transfer");
    console.log("Created:", data.created[0]);
  });

  // =========================================================================
  // 22. API: PATCH updates item
  // =========================================================================
  test("22 - API: PATCH line-items updates committed amount", async ({ page }) => {
    await ensureLineItem(page, "cdn-data-transfer", 100);

    const listRes = await page.request.get(`${BASE_URL}/api/contract/line-items`);
    const listData = await listRes.json();
    const item = listData.items.find((i: { productKey: string }) => i.productKey === "cdn-data-transfer");
    expect(item).toBeDefined();

    const response = await page.request.patch(`${BASE_URL}/api/contract/line-items`, {
      data: { id: item.id, committedAmount: 200 },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });

    expect(response.status()).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  // =========================================================================
  // 23. API: POST recalculate
  // =========================================================================
  test("23 - API: POST recalculate returns calculation results", async ({ page }) => {
    await ensureLineItem(page, "cdn-data-transfer", 100);

    const period = currentPeriodStr();
    const response = await page.request.post(`${BASE_URL}/api/contract/usage/recalculate`, {
      data: { period },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("period", period);
    expect(data).toHaveProperty("calculated");
    expect(data).toHaveProperty("crossings");
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBe(true);

    console.log(`Recalculated: ${data.calculated} items, ${data.crossings} crossings`);
    if (data.items.length > 0) console.log("First item:", data.items[0]);
  });

  // =========================================================================
  // 24. Sidebar navigation
  // =========================================================================
  test("24 - Sidebar Contract Usage link navigates correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("aside");
    const contractLink = sidebar.getByText("Contract Usage");
    await expect(contractLink).toBeVisible();
    await contractLink.click();

    await expect(page).toHaveURL(/\/contract-usage/);
    await expect(
      mainContent(page).getByText("Usage estimates based on analytics data"),
    ).toBeVisible();
  });

  // =========================================================================
  // 25. Full flow: detect, add, view, recalculate
  // =========================================================================
  test("25 - Full flow: detect, add, view usage, recalculate", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await cleanupAllLineItems(page);

    // Step 1: Detect
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("networkidle");

    const section = contractSection(page);
    await section.scrollIntoViewIfNeeded();

    await section.getByRole("button", { name: /Detect Available Products/i }).click();
    await expect(section.getByText("Detected Products")).toBeVisible({ timeout: 15_000 });

    // Each detected product row is a flex div with a checkbox, name, unit, and amount input.
    // The rows are inside a scrollable container.
    const productRows = section.locator('div.flex.items-center.gap-3');
    const rowCount = await productRows.count();

    let addedCount = 0;
    for (let i = 0; i < Math.min(rowCount, 4); i++) {
      const row = productRows.nth(i);
      const cb = row.locator('input[type="checkbox"]');
      if (!(await cb.isVisible())) continue;
      if (await cb.isChecked()) {
        const amountInput = row.locator('input[type="number"]');
        if (await amountInput.isVisible() && await amountInput.isEnabled()) {
          await amountInput.fill(String(50 + i * 25));
          addedCount++;
        }
        if (addedCount >= 2) break;
      }
    }

    if (addedCount > 0) {
      await section.getByRole("button", { name: /Add.*Selected/i }).click();
      await page.waitForTimeout(2_000);
      const successMsg = await section.getByText(/Added \d+ line item/).isVisible().catch(() => false);
      console.log(`Batch add success: ${successMsg}`);
    }

    // Step 2: View usage
    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    const main = mainContent(page);
    await expect(main.getByText("Usage estimates based on analytics data")).toBeVisible();

    const hasItems = await main.getByText("Items Tracked").isVisible().catch(() => false);
    if (hasItems) {
      console.log("Full flow: Items visible on usage page");

      // Step 3: Recalculate
      const recalcBtn = main.getByRole("button", { name: /Recalculate/i });
      if (await recalcBtn.isVisible()) {
        await recalcBtn.click();
        await page.waitForTimeout(3_000);
        await expect(main.getByText("Items Tracked")).toBeVisible();
        console.log("Full flow: Recalculate completed");
      }
    } else {
      console.log("Full flow: No items visible");
    }

    reportErrors(consoleErrors, "25");
  });

  // =========================================================================
  // 26. API: POST /api/contract/detect
  // =========================================================================
  test("26 - API: POST /api/contract/detect returns product detection", async ({ page }) => {
    const response = await page.request.post(`${BASE_URL}/api/contract/detect`, {
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("products");
    expect(Array.isArray(data.products)).toBe(true);
    expect(data.products.length).toBeGreaterThan(0);

    const detected = data.products.filter((p: { detected: boolean }) => p.detected);
    console.log(`Detected ${detected.length}/${data.products.length} products with data`);

    for (const p of data.products) {
      expect(p).toHaveProperty("key");
      expect(p).toHaveProperty("displayName");
      expect(p).toHaveProperty("detected");
    }
  });

  // =========================================================================
  // 27. API: DELETE line-items
  // =========================================================================
  test("27 - API: DELETE line-items removes item", async ({ page }) => {
    await ensureLineItem(page, "bot-mgmt-requests", 300);

    const listRes = await page.request.get(`${BASE_URL}/api/contract/line-items`);
    const listData = await listRes.json();
    const item = listData.items.find((i: { productKey: string }) => i.productKey === "bot-mgmt-requests");
    expect(item).toBeDefined();

    const response = await page.request.delete(`${BASE_URL}/api/contract/line-items?id=${item.id}`, {
      headers: { "Origin": BASE_URL },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).ok).toBe(true);

    // Verify deletion
    const verifyRes = await page.request.get(`${BASE_URL}/api/contract/line-items`);
    const verifyData = await verifyRes.json();
    const still = verifyData.items.find((i: { productKey: string }) => i.productKey === "bot-mgmt-requests");
    expect(still).toBeUndefined();
  });

  // =========================================================================
  // 28. API: PATCH with invalid warningThreshold
  // =========================================================================
  test("28 - API: PATCH with invalid warningThreshold returns 400", async ({ page }) => {
    await ensureLineItem(page, "cdn-data-transfer", 100);

    const listRes = await page.request.get(`${BASE_URL}/api/contract/line-items`);
    const listData = await listRes.json();
    const item = listData.items.find((i: { productKey: string }) => i.productKey === "cdn-data-transfer");

    const response = await page.request.patch(`${BASE_URL}/api/contract/line-items`, {
      data: { id: item.id, warningThreshold: 5.0 },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });
    expect(response.status()).toBe(400);
  });

  // =========================================================================
  // 29. Usage gauges render
  // =========================================================================
  test("29 - Usage gauges render with correct structure", async ({ page }) => {
    await cleanupAllLineItems(page);
    await addLineItemViaApi(page, "cdn-data-transfer", 100);
    await addLineItemViaApi(page, "cdn-requests", 500);

    // Recalculate
    const period = currentPeriodStr();
    await page.request.post(`${BASE_URL}/api/contract/usage/recalculate`, {
      data: { period },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");

    const main = mainContent(page);

    // Gauges are in .group divs within main content
    const gauges = main.locator(".group");
    const gaugeCount = await gauges.count();
    console.log(`Found ${gaugeCount} usage gauge components`);

    if (gaugeCount > 0) {
      const text = await gauges.first().textContent();
      console.log("First gauge content:", text);
      expect(text).toMatch(/(%|No data)/);
    }
  });

  // =========================================================================
  // 30. No JS runtime errors
  // =========================================================================
  test("30 - Contract Usage page renders without JS errors", async ({ page }) => {
    const jsErrors: string[] = [];
    page.on("pageerror", (err) => jsErrors.push(err.message));

    await ensureLineItem(page, "cdn-data-transfer", 100);

    await page.goto(`${BASE_URL}/contract-usage`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);

    if (jsErrors.length > 0) {
      console.log("JS RUNTIME ERRORS:", jsErrors);
    }
    expect(jsErrors).toHaveLength(0);
  });
});

// =============================================================================
// Unauthenticated access tests
// =============================================================================
test.describe("Contract Usage - Unauthenticated access", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("31 - API routes require authentication", async ({ request }) => {
    const catalogRes = await request.get(`${BASE_URL}/api/contract/catalog`);
    expect(catalogRes.status()).toBe(401);

    const lineItemsRes = await request.get(`${BASE_URL}/api/contract/line-items`);
    expect(lineItemsRes.status()).toBe(401);

    const usageRes = await request.get(`${BASE_URL}/api/contract/usage?period=2026-03`);
    expect(usageRes.status()).toBe(401);
  });

  test("32 - Mutation routes require authentication", async ({ request }) => {
    const postRes = await request.post(`${BASE_URL}/api/contract/line-items`, {
      data: { item: { productKey: "cdn-data-transfer", committedAmount: 100 } },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });
    expect(postRes.status()).toBe(401);

    const recalcRes = await request.post(`${BASE_URL}/api/contract/usage/recalculate`, {
      data: { period: "2026-03" },
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });
    expect(recalcRes.status()).toBe(401);

    const detectRes = await request.post(`${BASE_URL}/api/contract/detect`, {
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });
    expect(detectRes.status()).toBe(401);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function currentPeriodStr(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function reportErrors(errors: string[], context: string) {
  const critical = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("hydration") && !e.includes("DevTools"),
  );
  if (critical.length > 0) {
    console.log(`Console errors [${context}]:`, critical);
  }
}

async function cleanupAllLineItems(page: Page) {
  const res = await page.request.get(`${BASE_URL}/api/contract/line-items`);
  if (res.status() !== 200) return;
  const data = await res.json();
  for (const item of data.items || []) {
    await page.request.delete(`${BASE_URL}/api/contract/line-items?id=${item.id}`, {
      headers: { "Origin": BASE_URL },
    });
  }
}

async function deleteLineItemByKey(page: Page, key: string) {
  const res = await page.request.get(`${BASE_URL}/api/contract/line-items`);
  if (res.status() !== 200) return;
  const data = await res.json();
  for (const item of data.items || []) {
    if (item.productKey === key) {
      await page.request.delete(`${BASE_URL}/api/contract/line-items?id=${item.id}`, {
        headers: { "Origin": BASE_URL },
      });
    }
  }
}

async function addLineItemViaApi(page: Page, productKey: string, committedAmount: number) {
  await page.request.post(`${BASE_URL}/api/contract/line-items`, {
    data: { item: { productKey, committedAmount } },
    headers: { "Content-Type": "application/json", "Origin": BASE_URL },
  });
}

async function ensureLineItem(page: Page, productKey: string, committedAmount: number) {
  const res = await page.request.get(`${BASE_URL}/api/contract/line-items`);
  if (res.status() !== 200) {
    await addLineItemViaApi(page, productKey, committedAmount);
    return;
  }
  const data = await res.json();
  const existing = data.items?.find((i: { productKey: string }) => i.productKey === productKey);
  if (!existing) {
    await addLineItemViaApi(page, productKey, committedAmount);
  }
}
