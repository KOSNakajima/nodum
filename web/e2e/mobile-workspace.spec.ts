import { devices, expect, test } from "@playwright/test";

import { createNoteInFolderViaApi, signupFreshUser } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("mobile workspace", () => {
  test("drawers open/close, note editable, no horizontal scroll", async ({ page }) => {
    await signupFreshUser(page, "mobile");

    // Top bar visible with hamburger; desktop ribbon hidden
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

    // Left drawer: open → pick a note → drawer auto-closes
    await page.getByRole("button", { name: "Open navigation" }).click();
    const navDrawer = page.getByRole("dialog", { name: "Navigation drawer" });
    await expect(navDrawer).toBeVisible();
    await navDrawer.getByText("Welcome to Nodum", { exact: true }).click();
    await expect(navDrawer).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
      "Welcome to Nodum",
      { timeout: 10_000 },
    );

    // Note is editable on touch layout
    await page.locator(".cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await page.keyboard.type(" Mobile edit.");
    await expect(page.locator(".cm-content").first()).toContainText("Mobile edit.");

    // Right drawer: panels
    await page.getByRole("button", { name: "Open panels" }).click();
    const panelsDrawer = page.getByRole("dialog", { name: "Panels drawer" });
    await expect(panelsDrawer).toBeVisible();
    await expect(panelsDrawer.getByText(/Linked mentions/)).toBeVisible({ timeout: 10_000 });
    // Backdrop click closes
    await page.mouse.click(30, 700);
    await expect(panelsDrawer).not.toBeVisible({ timeout: 5_000 });

    // No horizontal scroll anywhere
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(fits).toBe(true);
  });
});

// A real phone profile: touch, coarse pointer — what the touch-only chrome
// (bottom bar, keyboard toolbar) keys off.
test.describe("mobile chrome (touch)", () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices["iPhone 13"];
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

  test("bottom bar, tab switcher, keyboard toolbar, menu", async ({ page }) => {
    await signupFreshUser(page, "mobile-touch");
    const nav = page.getByRole("navigation", { name: "Workspace" });
    await expect(nav).toBeVisible();

    // Open a note through the drawer.
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page
      .getByRole("dialog", { name: "Navigation drawer" })
      .getByText("Welcome to Nodum", { exact: true })
      .tap();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome to Nodum", {
      timeout: 10_000,
    });

    // Typing: the formatting toolbar replaces the bottom bar, and its buttons
    // act on the editor without stealing focus.
    await page.locator(".cm-content").first().tap();
    const toolbar = page.getByRole("toolbar", { name: "Formatting" });
    await expect(toolbar).toBeVisible();
    await expect(nav).toBeHidden();
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await page.keyboard.type(" plain");
    await toolbar.getByRole("button", { name: "Bold" }).tap();
    await page.keyboard.type("loud");
    await expect(page.locator(".cm-content").first()).toContainText("**loud**");
    await toolbar.getByRole("button", { name: "Hide keyboard" }).tap();
    await expect(toolbar).toBeHidden();
    await expect(nav).toBeVisible();

    // Menu → Graph view: the ribbon's actions are reachable by touch.
    await nav.getByRole("button", { name: "Menu", exact: true }).tap();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("button", { name: "Graph view" }).tap();
    await expect(page.locator("header").getByText("Graph view")).toBeVisible();

    // Tab switcher lists both tabs; picking one switches to it.
    await nav.getByRole("button", { name: "Open tabs (2)" }).tap();
    const tabs = page.getByRole("dialog", { name: "Open tabs" });
    await expect(tabs.getByText("Graph view")).toBeVisible();
    await tabs.getByRole("button", { name: "Welcome to Nodum", exact: true }).tap();
    await expect(tabs).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();

    // Back returns to the graph.
    await nav.getByRole("button", { name: "Navigate back" }).tap();
    await expect(page.locator("header").getByText("Graph view")).toBeVisible();

    // Settings: full-screen list → page → back.
    await nav.getByRole("button", { name: "Menu", exact: true }).tap();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("button", { name: "Settings" }).tap();
    await page.getByRole("button", { name: "Editor" }).tap();
    await expect(page.getByRole("button", { name: "Back to settings" })).toBeVisible();
    await page.getByRole("button", { name: "Back to settings" }).tap();
    await expect(page.getByRole("button", { name: "Appearance" })).toBeVisible();

    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(fits).toBe(true);
  });
});

test.describe("mobile feedback fixes (touch)", () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices["iPhone 13"];
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

  test("new note, explorer state across the drawer, folder graph", async ({ page }) => {
    await signupFreshUser(page, "mobile-fixes");
    await createNoteInFolderViaApi(page, "Projects", "Alpha", "Links to [[Beta]].");
    await createNoteInFolderViaApi(page, "Projects", "Beta");
    await page.reload();
    const nav = page.getByRole("navigation", { name: "Workspace" });

    // New note: names must be legal — the old "Untitled YYYY-MM-DD HH:MM"
    // carried a ":" and every create was a silent 422.
    await nav.getByRole("button", { name: "New note" }).tap();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Untitled", {
      timeout: 10_000,
    });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await nav.getByRole("button", { name: "New note" }).tap();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Untitled 1", {
      timeout: 10_000,
    });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // A collapsed folder stays collapsed after the drawer closes and reopens.
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const drawer = page.getByRole("dialog", { name: "Navigation drawer" });
    await expect(drawer.getByText("Alpha", { exact: true })).toBeVisible();
    await drawer.getByText("Projects", { exact: true }).tap();
    await expect(drawer.getByText("Alpha", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await expect(drawer.getByText("Projects", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Alpha", { exact: true })).toHaveCount(0);

    // The folder's graph button scopes the graph; × goes back to the vault.
    await drawer.getByRole("button", { name: "Graph of Projects", exact: true }).tap();
    await expect(drawer).toBeHidden();
    await expect(page.getByText("Folder:")).toBeVisible();
    await page.getByRole("button", { name: "Show the whole vault" }).tap();
    await expect(page.getByText("Folder:")).toHaveCount(0);

    // And the drawer's own graph button opens the whole-vault graph.
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await drawer.getByRole("button", { name: "Open graph view" }).tap();
    await expect(page.locator("header").getByText("Graph view")).toBeVisible();
  });
});
