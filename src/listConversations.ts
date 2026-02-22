import { Page } from "puppeteer";
import { Conversation, DoneFile } from "./types";
import { sleep, isProcessed } from "./utils";
import { debug, debugWarn } from "./debug";

/**
 * Discover which link selector matches thread links on the library page.
 */
async function discoverThreadSelector(page: Page): Promise<{ selector: string; count: number }> {
  const candidates = [
    'a[href*="/search/"]',
    'a[href*="/thread/"]',
    'a[href*="/page/"]',
  ];

  for (const sel of candidates) {
    const count = await page.evaluate((s: string) => {
      return document.querySelectorAll(s).length;
    }, sel);
    if (count > 0) {
      return { selector: sel, count };
    }
  }

  return { selector: "", count: 0 };
}

/**
 * Parse a library page timestamp string to a Date.
 * Handles:
 *  - Relative: "13 hours ago", "2 minutes ago", "just now"
 *  - Absolute: "Feb 20, 2026", "Jan 5, 2025"
 * Returns null if parsing fails.
 */
export function parseLibraryTimestamp(text: string): Date | null {
  if (!text) return null;
  // Clean debris: Perplexity sometimes appends "CCL" (Copy Link button label) to timestamps
  const t = text.trim().replace(/CCL$/i, "").trim().toLowerCase();

  // Handle shorthands "1h", "2m", "13h", etc.
  const shortRelMatch = t.match(/^(\d+)([smhd])\b/);
  if (shortRelMatch) {
    const amount = parseInt(shortRelMatch[1], 10);
    const unit = shortRelMatch[2];
    const now = new Date();
    switch (unit) {
      case "s": now.setSeconds(now.getSeconds() - amount); break;
      case "m": now.setMinutes(now.getMinutes() - amount); break;
      case "h": now.setHours(now.getHours() - amount); break;
      case "d": now.setDate(now.getDate() - amount); break;
    }
    return now;
  }

  // Relative timestamps → treat as "today" (now minus the offset)
  const relMatch = t.match(/^(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago$/);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    switch (unit) {
      case "second": now.setSeconds(now.getSeconds() - amount); break;
      case "minute": now.setMinutes(now.getMinutes() - amount); break;
      case "hour": now.setHours(now.getHours() - amount); break;
      case "day": now.setDate(now.getDate() - amount); break;
      case "week": now.setDate(now.getDate() - amount * 7); break;
      case "month": now.setMonth(now.getMonth() - amount); break;
    }
    return now;
  }

  if (t === "just now" || t === "now") return new Date();

  // Absolute date: "Feb 20, 2026" or "February 20, 2026"
  const d = new Date(text.trim());
  if (!isNaN(d.getTime())) {
    // If it's just a date (like "Feb 21, 2026") without a time, 
    // it defaults to midnight. If that's today's date, it might look "older" than our last download.
    // We'll set it to the END of that day if it's missing time, to be safe for same-day checks.
    if (!text.includes(":") && !text.toLowerCase().includes("am") && !text.toLowerCase().includes("pm")) {
      d.setHours(23, 59, 59, 999);
    }
    return d;
  }

  return null;
}

/**
 * Scroll the library page to load all threads via lazy-loading.
 */
export async function scrollToBottomOfConversations(
  page: Page,
  threadSelector: string,
  scrollDelayMs: number = 2000,
  scanMode: "full" | "top" = "full",
  scanLimit: number = 10,
  onProgress?: (count: number) => void
): Promise<void> {
  let scrollRounds = 0;
  let previousCount = 0;
  let stableRounds = 0;
  const MAX_STABLE_ROUNDS = 3;

  debug(`Starting ${scanMode} scroll (limit: ${scanLimit})...`);

  while (true) {
    scrollRounds++;

    await page.evaluate(() => {
      // 1. Try to find a scrollable container first
      const scrollable = Array.from(document.querySelectorAll('*')).find(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });

      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
      } else {
        // 2. Fallback to main window scroll
        window.scrollTo(0, document.body.scrollHeight);
      }
    });

    await sleep(scrollDelayMs);

    const currentCount = await page.evaluate((sel: string) => {
      if (sel === "__broad__") {
        const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        return links.filter(a =>
          a.href.includes("perplexity.ai/") && /\/[a-z0-9-]{20,}$/i.test(a.href)
        ).length;
      }
      return document.querySelectorAll(sel).length;
    }, threadSelector);

    if (currentCount === previousCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }

    if (scrollRounds % 5 === 0 || currentCount !== previousCount) {
      debug(`Scroll round ${scrollRounds}: ${currentCount} links loaded (was ${previousCount})`);
    }

    previousCount = currentCount;
    if (onProgress) onProgress(currentCount);

    if (stableRounds >= MAX_STABLE_ROUNDS) {
      debug(`No new links after ${MAX_STABLE_ROUNDS} consecutive rounds. Stopping scroll.`);
      break;
    }

    if (scanMode === "top" && currentCount >= scanLimit) {
      debug(`Scan limit reached (${currentCount} >= ${scanLimit}). Stopping scroll.`);
      break;
    }

    if (scrollRounds > 100) { // Reduced from 500 for sanity but still very deep
      debugWarn(`Hit scroll safety limit (${scrollRounds} rounds). Stopping.`);
      break;
    }
  }

  debug(`Scrolling done after ${scrollRounds} round(s). Total links: ${previousCount}`);
}

/**
 * Determine if a thread should be re-downloaded based on timestamps.
 * Returns true if the thread's library timestamp is newer than when we last downloaded it.
 */
function shouldReDownload(doneFile: DoneFile, url: string, libraryTimestamp: string | undefined): boolean {
  if (!isProcessed(doneFile, url)) return true; // Never downloaded
  if (!libraryTimestamp) return false; // Can't compare, skip

  const record = doneFile.processed[url];
  const libDate = parseLibraryTimestamp(libraryTimestamp);
  if (!libDate) {
    debugWarn(`Could not parse library timestamp: "${libraryTimestamp}" for ${url}`);
    return false;
  }

  const downloadedDate = new Date(record.downloadedAt);

  // Re-download if the library shows the thread was modified after we downloaded it
  // Add a small 1-minute buffer to handle "just now" / "1 minute ago" edge cases 
  // where the scrape might happen slightly after the record's downloadedAt timestamp
  const isNewer = libDate.getTime() > (downloadedDate.getTime() + 1000);

  if (isNewer) {
    debug(`Change detected for ${url}: libDate=${libDate.toISOString()}, downloadedDate=${downloadedDate.toISOString()}`);
  }

  return isNewer;
}

export async function getConversations(
  page: Page,
  doneFile: DoneFile,
  scrollDelayMs: number = 2000,
  scanMode: "full" | "top" = "full",
  scanLimit: number = 10,
  onProgress?: (count: number) => void
): Promise<{ toProcess: Conversation[], allDiscovered: Conversation[] }> {
  // Check if we are already on library (possibly from login check)
  if (!page.url().includes("/library")) {
    console.log("Navigating to library...");
    await page.goto("https://www.perplexity.ai/library", { waitUntil: "networkidle2", timeout: 60000 });
  } else {
    debug("Already on library page, skipping navigation.");
  }

  const landedUrl = page.url();
  debug(`Landed on: ${landedUrl}`);

  // Wait extra time for any lazy-auth modals to settle or appear
  await sleep(5000);

  // Dump a sample of <a> hrefs for diagnostics
  const allHrefs: string[] = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    return links.map(a => a.href).slice(0, 30);
  });
  debug(`Sample of <a> hrefs on page (${allHrefs.length}):`);
  allHrefs.forEach((h, i) => debug(`  [${i}] ${h}`));

  // Discover the right thread selector
  let { selector: threadSelector, count: initialCount } = await discoverThreadSelector(page);
  if (threadSelector) {
    debug(`Selector "${threadSelector}" matched ${initialCount} link(s) before scroll.`);
  }

  if (!threadSelector) {
    debug("No known selector matched. Trying broad perplexity link pattern...");
    const broadCount = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      return links.filter(a => {
        const href = a.href;
        return href.includes("perplexity.ai/") && /\/[a-z0-9-]{20,}$/i.test(href);
      }).length;
    });
    if (broadCount > 0) {
      debug(`Broad pattern matched ${broadCount} link(s). Using broad match.`);
      threadSelector = "__broad__";
    } else {
      /*
      try {
        await page.screenshot({ path: "debug-library-page.png", fullPage: true });
        debug("Saved screenshot to debug-library-page.png for inspection.");
      } catch (e) {
        debug(`Could not save screenshot: ${e}`);
      }
      */
      debugWarn("Could not find any thread links on the library page.");
      return { toProcess: [], allDiscovered: [] };
    }
  }

  if (threadSelector !== "__broad__") {
    try {
      await page.waitForSelector(threadSelector, { timeout: 15000 });
    } catch (e) {
      debugWarn(`waitForSelector("${threadSelector}") timed out.`);
    }
  }

  // Scroll to load all threads
  await scrollToBottomOfConversations(page, threadSelector, scrollDelayMs, scanMode, scanLimit, onProgress);

  // Scrape thread links + timestamps from the page
  const conversations: Conversation[] = await page.evaluate((sel: string) => {
    let items: HTMLAnchorElement[];
    if (sel === "__broad__") {
      const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      items = links.filter(a => {
        const href = a.href;
        return href.includes("perplexity.ai/") && /\/[a-z0-9-]{20,}$/i.test(href);
      });
    } else {
      items = Array.from(document.querySelectorAll(sel)) as HTMLAnchorElement[];
    }

    // Deduplicate by href
    const seen = new Set<string>();
    const unique: HTMLAnchorElement[] = [];
    for (const item of items) {
      if (!seen.has(item.href)) {
        seen.add(item.href);
        unique.push(item);
      }
    }

    return unique.map((item) => {
      // Try to find a timestamp near this link
      // Perplexity shows timestamps as small text near each thread card
      let libraryTimestamp = "";

      // Look wider: Parents up to 4 levels
      let current: HTMLElement | null = item;
      for (let depth = 0; depth < 4; depth++) {
        if (!current) break;

        const timeEl = current.querySelector("time");
        if (timeEl) {
          libraryTimestamp = timeEl.textContent?.trim() || timeEl.getAttribute("datetime") || "";
          if (libraryTimestamp) break;
        }

        // Search all text-heavy elements in this container
        const textElements = Array.from(current.querySelectorAll("span, div, p"));
        for (const el of textElements) {
          const text = el.textContent?.trim() || "";
          // Avoid matching the title itself or very long snippets
          if (text.length > 50) continue;

          if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text) ||
            /\d+[smhd]\b/i.test(text) || // Shorthand like "1h"
            /\d+\s+(second|minute|hour|day|week|month)s?\s+ago/i.test(text) ||
            /just now|now/i.test(text)) {
            // Strip "CCL" even here for better logs
            libraryTimestamp = text.replace(/CCL$/i, "").trim();
            break;
          }
        }
        if (libraryTimestamp) break;
        current = current.parentElement;
      }

      return {
        title: item.textContent?.trim() || "Untitled",
        url: item.href,
        libraryTimestamp,
      };
    });
  }, threadSelector);

  debug(`Found ${conversations.length} total unique thread links.`);

  // Filter: include threads that are new OR have been modified since last download
  const toProcess = conversations.filter((conv) => {
    if (!isProcessed(doneFile, conv.url)) return true; // New thread
    if (shouldReDownload(doneFile, conv.url, conv.libraryTimestamp)) {
      debug(`Thread modified since last download, will re-download: ${conv.url} (lib timestamp: ${conv.libraryTimestamp})`);
      return true;
    }
    return false;
  });

  const modifiedCount = toProcess.filter(c => isProcessed(doneFile, c.url)).length;
  if (modifiedCount > 0) {
    debug(`${modifiedCount} previously downloaded thread(s) will be re-downloaded (modified since last export).`);
  }

  return { toProcess, allDiscovered: conversations };
}