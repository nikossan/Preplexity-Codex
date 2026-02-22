import { promises as fs } from "fs";
import puppeteer from "puppeteer-extra";
import { Browser, Page } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { ConversationSaver } from "./ConversationSaver";
import { login } from "./login";
import renderConversation from "./renderConversation";
import { loadDoneFile, saveDoneFile, sleep, processedCount, isProcessed, markProcessed } from "./utils";

puppeteer.use(StealthPlugin());

const EMAIL = "nikssen@gmail.com";
const OUTPUT_DIR = ".";
const DONE_FILE = "done.json";
const URLS_FILE = "urls.json";
const CONFIG_FILE = "config.json";

/**
 * Check if the current page is a login screen (either email input or "Continue with email" button).
 * Returns true if login is required.
 */
async function isLoginPage(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    // Direct email input
    if (document.querySelector('input[type="email"]')) return true;
    // "Continue with email" button
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(btn => btn.textContent?.includes('Continue with email'));
  });
}

/**
 * Ensure we are logged in. If not, call login() and return true.
 */
async function ensureLoggedIn(page: Page, email: string): Promise<boolean> {
  if (await isLoginPage(page)) {
    console.log("Login screen detected – re-authenticating...");
    await login(page, email);
    return true;
  }
  return false;
}

async function manualExport() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const doneFile = await loadDoneFile(DONE_FILE);
  console.log(`Loaded ${processedCount(doneFile)} processed URLs`);

  let manualUrls: string[] = [];
  try {
    const data = await fs.readFile(URLS_FILE, "utf-8");
    manualUrls = JSON.parse(data);
    console.log(`Loaded ${manualUrls.length} URLs from ${URLS_FILE}`);
  } catch (err) {
    console.error(`Could not read ${URLS_FILE}. Please create it with an array of conversation URLs.`);
    process.exit(1);
  }

  const newUrls = manualUrls.filter((url) => !isProcessed(doneFile, url));
  console.log(`Found ${newUrls.length} new conversations to process`);

  if (newUrls.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const browser: Browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    // slowMo: 50, // uncomment to slow down actions for debugging
  });

  try {
    const page = await browser.newPage();

    // Load config
    let config = { delay_min_ms: 7000, delay_max_ms: 14000 };
    try {
      const configRaw = await fs.readFile(CONFIG_FILE, "utf-8");
      config = JSON.parse(configRaw);
      console.log(`[DEBUG] Loaded config: min=${config.delay_min_ms}ms, max=${config.delay_max_ms}ms`);
    } catch (e) {
      console.log("[DEBUG] No config.json found, using defaults (7-14s)");
    }

    // Initial login – you'll enter the code manually
    await login(page, EMAIL);

    const conversationSaver = new ConversationSaver(page);
    await conversationSaver.initialize();

    for (let i = 0; i < newUrls.length; i++) {
      const url = newUrls[i];
      console.log(`\n[${i + 1}/${newUrls.length}] Processing ${url}`);

      // Use ConversationSaver to load the thread – it handles navigation and response capture
      let threadData;
      let attempts = 0;
      const MAX_ATTEMPTS = 3;

      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
          threadData = await conversationSaver.loadThreadFromURL(url);
          break; // success
        } catch (error: any) {
          console.error(`Attempt ${attempts} failed:`, error.message);

          // Check for Perplexity API specific errors (e.g. SERIALIZATION_ERROR)
          if (error.message.includes("Perplexity API Error")) {
            console.error(`[FATAL API ERROR] ${error.message} for ${url}. Skipping immediately.`);
            await logError(url, error.message);
            threadData = null;
            break; // Skip retries for fatal API errors
          }

          // Check if the error is due to a login page (timeout while waiting for API response)
          // Also check for our explicit timeout error
          const isTimeout = error.message.includes("Timeout waiting for thread data");

          if (isTimeout) {
            console.log(`[DEBUG] Timeout occurred for ${url}. This means the specific API request was not captured within 30s.`);
            const loginNeeded = await isLoginPage(page);
            if (loginNeeded) {
              console.log("Login screen detected during timeout retry – re-authenticating...");
              await login(page, EMAIL);
              continue; // retry
            }

            if (attempts >= MAX_ATTEMPTS) {
              console.error(`Failed to process ${url} after ${MAX_ATTEMPTS} attempts (Timeout). Skipping.`);
              await logError(url, "Timeout waiting for API response");
              threadData = null;
              break;
            }
            console.log("Retrying...");
            await sleep(3000);
            continue;
          }

          const loginNeeded = await isLoginPage(page);
          if (loginNeeded) {
            console.log("Login required during processing – re-authenticating...");
            await login(page, EMAIL);
            // loop will retry
          } else {
            // If it's the last attempt, rethrow to move to next URL (or crash if we want strictness, but better to skip)
            if (attempts >= MAX_ATTEMPTS) {
              console.error(`Failed to process ${url} after ${MAX_ATTEMPTS} attempts. Skipping.`);
              await logError(url, error.message);
              threadData = null; // Mark as failed
              break;
            }
            await sleep(2000);
          }
        }
      }

      if (!threadData) {
        continue; // Skip to next URL
      }

      // Save JSON
      const jsonPath = `${OUTPUT_DIR}/${threadData.id}.json`;
      await fs.writeFile(jsonPath, JSON.stringify(threadData.conversation, null, 2));
      console.log(`Saved JSON: ${jsonPath}`);

      // Save Markdown
      const markdown = renderConversation(threadData.conversation);
      const mdPath = `${OUTPUT_DIR}/${threadData.id}.md`;
      await fs.writeFile(mdPath, markdown);
      console.log(`Saved Markdown: ${mdPath}`);

      const latestUpdated = threadData.conversation.entries
        .map((e: any) => e.updated_datetime || e.entry_updated_datetime || "")
        .filter(Boolean)
        .sort()
        .pop() || new Date().toISOString();
      markProcessed(doneFile, url, latestUpdated);
      await saveDoneFile(doneFile, DONE_FILE);

      // Update search-index.json
      await updateSearchIndex(threadData.id, threadData.conversation);

      // Random delay to avoid rate limiting
      const minDelay = config.delay_min_ms;
      const maxDelay = config.delay_max_ms;
      const delay = Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
      console.log(`[DEBUG] Waiting ${(delay / 1000).toFixed(1)}s before next download...`);
      await sleep(delay);
    }

    console.log("\n✅ All done!");
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    await browser.close();
  }
}

async function logError(url: string, error: string) {
  const ERROR_FILE = "errors.json";
  let errors: any[] = [];
  try {
    const content = await fs.readFile(ERROR_FILE, "utf-8");
    errors = JSON.parse(content);
  } catch (e) {
    // ignore
  }
  errors.push({
    url,
    error,
    timestamp: new Date().toISOString()
  });
  await fs.writeFile(ERROR_FILE, JSON.stringify(errors, null, 2));
}

async function updateSearchIndex(id: string, conversation: any) {
  const INDEX_FILE = "search-index.json";
  let index: any[] = [];

  try {
    const content = await fs.readFile(INDEX_FILE, "utf-8");
    index = JSON.parse(content);
  } catch (e) {
    // Index doesn't exist yet
  }

  const firstEntry = conversation.entries?.[0];
  if (!firstEntry) return;

  const title = firstEntry.query_str || "Untitled Conversation";
  const snippet = firstEntry.blocks?.find((b: any) => b.intended_usage === "ask_text")?.markdown_block?.answer?.substring(0, 200) || "";

  const entry = {
    id,
    title,
    snippet: snippet + "...",
    url: `https://www.perplexity.ai/search/${firstEntry.thread_url_slug}`,
    filename: `${id}.md`,
    date: firstEntry.updated_datetime
  };

  // Replace existing or add new
  const existingIndex = index.findIndex(item => item.id === id);
  if (existingIndex >= 0) {
    index[existingIndex] = entry;
  } else {
    index.push(entry);
  }

  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`[DEBUG] Updated search index with: ${title}`);
}

manualExport().catch(console.error);