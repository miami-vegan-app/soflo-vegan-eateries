import { chromium, devices } from "playwright";

const BASE = process.env.BASE || "http://localhost:4178";
const iphone = devices["iPhone 13"];

const browser = await chromium.launch();
const context = await browser.newContext({ ...iphone });
const page = await context.newPage();

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(BASE, { waitUntil: "networkidle" });

// 1. First-run setup screen should be visible.
const setupVisible = await page.isVisible("#setup-screen");
console.log("setup screen visible on first run:", setupVisible);

// 2. iPhone should be auto-selected (iPhone UA).
const iosSelected = await page.getAttribute("#tab-ios", "aria-selected");
console.log("iPhone tab auto-selected:", iosSelected);
const firstStep = (await page.textContent("#steps li")) || "";
console.log("first iOS step mentions Share:", /share/i.test(firstStep));

// 3. Switch to Android -> browser picker appears.
await page.click("#tab-android");
const browserPickVisible = await page.isVisible("#browser-pick");
console.log("android browser picker visible:", browserPickVisible);

// 4. "I already did this" dismisses setup and reveals app.
await page.click("#btn-done");
await page.waitForSelector("#setup-screen", { state: "hidden" });
console.log("setup dismissed:", !(await page.isVisible("#setup-screen")));

// 5. Cards render.
await page.waitForSelector(".card", { timeout: 5000 });
const cardCount = await page.locator(".card").count();
const countText = await page.textContent("#result-count");
console.log("cards rendered:", cardCount, "| count label:", countText.trim());

// 6. Search filters.
await page.fill("#search", "pizza");
await page.waitForTimeout(150);
const afterSearch = await page.locator(".card").count();
console.log("cards after searching 'pizza':", afterSearch);

// 7. County filter.
await page.fill("#search", "");
await page.selectOption("#filter-county", "Broward County");
await page.waitForTimeout(150);
const headers = await page.locator(".county-head").allTextContents();
console.log("county headers after Broward filter:", headers);

// 8. Feedback + credit links present.
const fb = await page.getAttribute('a[href="https://www.facebook.com/dschwartzberg"]', "href");
const mail = await page.getAttribute('a[href^="mailto:"]', "href");
const credit = await page.getAttribute('a[href="https://www.linkedin.com/in/abdunal"]', "href");
console.log("facebook link:", fb);
console.log("mailto link:", mail);
console.log("credit link:", credit);

// 9. Reload -> setup should NOT reappear (localStorage persisted).
await page.reload({ waitUntil: "networkidle" });
console.log("setup hidden after reload:", !(await page.isVisible("#setup-screen")));

console.log("CONSOLE ERRORS:", errors.length ? errors : "none");

await browser.close();
process.exit(errors.length ? 1 : 0);
