import { Page } from "puppeteer";
import { sleep } from "./utils";

export async function login(page: Page, email: string): Promise<void> {
  // 1. First, check if we might already have an active session
  // We check /library because that's our ultimate destination and where modals pop up
  console.log("Checking session status at /library...");
  try {
    await page.goto("https://www.perplexity.ai/library", { waitUntil: "networkidle2", timeout: 20000 });
    await sleep(3000); // Wait for potential "Sign in to save" modals to pop up

    const isActuallyLoggedIn = await page.evaluate(() => {
      const hasLibrarySearch = !!document.querySelector('input[placeholder*="Search your threads"]');
      const hasModal = !!document.querySelector('div[role="dialog"]') || !!Array.from(document.querySelectorAll('h2, h3, div')).find(el => el.textContent?.includes('Sign in to save'));
      return hasLibrarySearch && !hasModal;
    });

    if (isActuallyLoggedIn) {
      console.log("Active session detected on /library, skipping login.");
      return;
    }
  } catch (e) {
    console.log("Error checking /library, proceeding to fresh login.");
  }

  console.log("Navigating to Perplexity Home for login...");
  await page.goto("https://www.perplexity.ai/");
  await sleep(2000);

  // Try to accept cookies - if not there, ignore
  try {
    await page.click("button::-p-text('Accept All Cookies')");
    await sleep(500);
  } catch (e) { }

  // Some versions need a "Sign In" click first
  const hasSignIn = await page.evaluate(() => {
    return !!Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Sign In'));
  });
  if (hasSignIn) {
    console.log("Clicking 'Sign In'...");
    await page.click("button::-p-text('Sign In')");
    await sleep(1000);
  }

  // Wait for email input and enter credentials
  console.log("Waiting for email input...");
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.type('input[type="email"]', email);

  // Click the login submit button
  console.log("Clicking 'Continue with email'...");
  await page.click("button::-p-text('Continue with email')");

  console.log("Waiting for code input field...");
  // Wait for the code input to appear
  await page.waitForSelector(
    'input[placeholder*="Code"], input[placeholder*="code"], input[type="text"][inputmode="numeric"], input[placeholder="Enter Code"]',
    { timeout: 60000 }
  );

  console.log(
    "Check your email and enter code in the window.\n" +
    "Waiting for you to enter the email code and login to succeed..."
  );

  // Wait for the main chat input to be ready
  await page.waitForSelector("#ask-input", {
    timeout: 120000,
  });

  console.log("Successfully logged in");
}