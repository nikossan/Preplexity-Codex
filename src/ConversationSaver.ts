import { Page } from "puppeteer";
import { ConversationResponse, StepAsset } from "./types/conversation";
import { debug } from "./debug";
import { sleep } from "./utils";

export interface InlineArtifact {
  filename: string;
  content: string;
  mimeType: string;
  fileSize: number;
  url?: string;
}

interface ThreadData {
  id: string;
  conversation: ConversationResponse;
  domUrls?: string[];
  inlineArtifacts?: InlineArtifact[];
}

export class ConversationSaver {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  private capturedResponses: Map<string, ConversationResponse> = new Map();
  private currentThreadId: string | null = null;
  private artifactUrls: Set<string> = new Set();

  async initialize(): Promise<void> {
    await this.page.setRequestInterception(true);
    // 🛡️ Navigation Guard: Stop any logic that tries to navigate the page away from Perplexity
    this.page.on("request", (req) => {
      const url = req.url();
      const isNav = req.isNavigationRequest();

      // Block navigation to non-perplexity domains during export
      if (isNav && !url.includes("perplexity.ai") &&
        (url.includes("imagedelivery.net") || url.includes("social_preview") || url.includes("s3.amazonaws.com"))) {
        debug(`[NAV-GUARD] Blocking accidental navigation to: ${url}`);
        req.abort().catch(() => { });
        return;
      }
      req.continue().catch(() => { });
    });

    this.page.on("response", async (response) => {
      const url = response.url();
      const method = response.request().method();

      if (method === "GET" && url.includes("/rest/thread/")) {
        const parts = url.split("/rest/thread/");
        if (parts.length < 2) return;
        const threadId = parts[1].split("?")[0];
        if (threadId === "list_recent") return;

        try {
          const data = (await response.json()) as any;
          if (data && data.entries) {
            const keys = Object.keys(data);
            const entryCount = data.entries.length;
            const hasCursor = !!(data.has_next_page || data.next_cursor);
            debug(`[API-HARVEST] Caught response for ${threadId} (Entries: ${entryCount}, hasMore: ${hasCursor}, Keys: [${keys.join(", ")}])`);

            const existing = this.capturedResponses.get(threadId);
            if (!existing) {
              this.capturedResponses.set(threadId, data as ConversationResponse);
            } else {
              // Merge entries instead of replacing the whole object
              const existingUuids = new Set(existing.entries.map(e => e.uuid));
              let addedCount = 0;
              for (const newEntry of data.entries) {
                if (!existingUuids.has(newEntry.uuid)) {
                  existing.entries.push(newEntry);
                  existingUuids.add(newEntry.uuid);
                  addedCount++;
                }
              }
              if (addedCount > 0) {
                debug(`[API-MERGE] Added ${addedCount} new entries to ${threadId}. (Total: ${existing.entries.length})`);
              }

              // Update cursor if found to allow for further pagination
              if (hasCursor) {
                existing.has_next_page = data.has_next_page;
                existing.next_cursor = data.next_cursor;
              }
            }
          }
        } catch (e) { }
      }
    });

    // 🎨 Artifact Interceptor: Catch Perplexity's dedicated artifact API responses
    this.page.on("response", async (response) => {
      const url = response.url();
      const method = response.request().method();

      // Perplexity serves generated files via /rest/artifact or similar
      if (method === "GET" && (
        url.includes("/rest/artifact") ||
        url.includes("/api/v1/artifact") ||
        url.includes("/page/") && url.includes("perplexity.ai")
      )) {
        try {
          const contentType = response.headers()["content-type"] || "";
          // If it returns HTML/JSON that references a file, log it
          if (contentType.includes("text/html") || contentType.includes("application/json")) {
            debug(`[ARTIFACT-INTERCEPT] Caught potential artifact response: ${url}`);
            this.artifactUrls.add(url);
          }
        } catch (e) { }
      }
    });
  }

  private async waitForContent(): Promise<void> {
    debug("Waiting for thread content to become visible...");
    try {
      // Perplexity typically has a main content area, often within a 'main' tag or specific divs
      await this.page.waitForSelector('main, [role="main"], .message-item', { timeout: 10000 });
      debug("Content detected.");
    } catch (e) {
      debug("Timed out waiting for specific content selector, proceeding anyway...");
    }
    await sleep(1000);
  }

  private async dismissPopups(): Promise<void> {
    debug("🧹 Performing DOM Surgery on blocking popups and toasts...");
    await this.page.evaluate(() => {
      // 1. HARD REMOVE any element containing limit/upgrade text
      const blockers = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = (el.textContent || "").toLowerCase();
        return text.includes("limit reached") || text.includes("basic search") || text.includes("upgrade");
      });

      blockers.forEach(el => {
        const container = el.closest('[style*="fixed"], [style*="absolute"], [role="alert"], [role="dialog"], [class*="toast"], [class*="modal"]');
        if (container) {
          console.log("[DOM-SURGERY] Removing blocking container:", container.className);
          container.remove();
        }
      });

      // 2. Clear known blocking overlay patterns by removing them
      const overlays = document.querySelectorAll('[class*="Modal"], [class*="Overlay"], [class*="Popup"]');
      overlays.forEach((el: any) => {
        if (el.textContent?.includes('Upgrade') || el.textContent?.includes('Log in')) {
          el.remove();
        }
      });

      // 3. Ensure no fixed elements are capturing whole-page focus
      const fixed = Array.from(document.querySelectorAll('div')).filter(el => {
        const style = window.getComputedStyle(el);
        return style.position === 'fixed' && parseInt(style.zIndex) > 100;
      });
      fixed.forEach(el => {
        if (el.textContent?.toLowerCase().includes("limit")) el.remove();
      });
    });
    await sleep(300);
  }

  private async clickNativeScrollButton(): Promise<boolean> {
    debug("🖱️ Attempting to trigger Perplexity's native 'Scroll to Latest' button...");
    return await this.page.evaluate(() => {
      // Perplexity's 'Scroll to Latest' button is typically a circle with a down arrow
      // It often has an ARIA label or specific SVG path
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const scrollBtn = buttons.find(b => {
        const svg = b.querySelector('svg');
        const aria = b.getAttribute('aria-label')?.toLowerCase() || "";
        return aria.includes('scroll') || aria.includes('latest') || (svg && svg.innerHTML.includes('M12 18l6-6-1.4-1.4-3.6 3.6V4h-2v10.2l-3.6-3.6L6 12l6 6'));
      });

      if (scrollBtn) {
        (scrollBtn as HTMLElement).click();
        return true;
      }
      return false;
    });
  }

  private async ensureThreadFocus(): Promise<void> {
    debug("🎯 Re-focusing main thread area...");
    try {
      await this.page.bringToFront();

      const mainSelector = 'main, [role="main"], #main-content, .message-area, [class*="messageArea"]';
      const main = await this.page.$(mainSelector);

      if (main) {
        await this.page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) {
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
            el.focus();
          }
        }, mainSelector);

        await main.click({ offset: { x: 50, y: 50 } });
      } else {
        await this.page.click('body', { offset: { x: 2, y: 2 } });
      }

      await this.page.keyboard.press('Escape');
      await sleep(200);
    } catch (e) {
      debug("Focus recovery failed, proceeding anyway...");
    }
  }

  private async scrollToBottom(): Promise<void> {
    debug("🚀 [v0.9.5-FIX] Starting aggressive keyboard-based scroll hunt (with Navigation Guard active)...");

    await this.waitForContent();

    // 1. Initial cleanup
    await this.dismissPopups();
    await this.ensureThreadFocus();

    // 2. Perform JS-driven scrolling loop
    await this.page.evaluate(async () => {
      const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

      const getAllScrollables = () => {
        const els = Array.from(document.querySelectorAll('*'));
        return els.filter(el => {
          const style = window.getComputedStyle(el);
          const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
          return isScrollable || (el.scrollHeight > el.clientHeight && el.clientHeight > 0);
        });
      };

      let lastTotalHeight = 0;
      let scrollAttempts = 0;
      const MAX_SCROLLS = 15;

      const scrollDown = (el?: Element) => {
        if (el) el.scrollTop = el.scrollHeight;
        else window.scrollTo(0, document.body.scrollHeight);
      };

      while (scrollAttempts < MAX_SCROLLS) {
        let scrollables = getAllScrollables();
        let currentTotalHeight = 0;

        scrollables.forEach(el => {
          scrollDown(el);
          currentTotalHeight += el.scrollHeight;
        });

        scrollDown();
        currentTotalHeight += document.body.scrollHeight;

        await delay(800);

        if (currentTotalHeight === lastTotalHeight) {
          await delay(1200);
          if (currentTotalHeight === lastTotalHeight) break;
        }

        lastTotalHeight = currentTotalHeight;
        scrollAttempts++;
      }
    });

    // 3. Persistent Hybrid Simulation (Native Button + Keyboard + Surgery)
    debug("Simulating native button clicks and keyboard 'End' presses...");

    for (let i = 0; i < 8; i++) {
      // A. Remove any new popups
      await this.dismissPopups();

      // B. Re-focus the thread
      await this.ensureThreadFocus();

      // C. Try native 'Scroll to Latest' button first (Primary)
      const clickedNative = await this.clickNativeScrollButton();
      if (clickedNative) {
        debug("  [SCROLL] Used Perplexity's native scroll button.");
        await sleep(800);
      }

      // D. Keyboard fallbacks (Secondary)
      await this.page.keyboard.press('End');
      await sleep(400);
      await this.page.keyboard.press('PageDown');
      await sleep(600);
    }

    /*
    try {
      const timestamp = Date.now();
      await this.page.screenshot({ path: `debug-scroll-${timestamp}.png` });
      debug(`Saved scroll debug screenshot: debug-scroll-${timestamp}.png`);
    } catch (e) { }
    */

    // Final soak time for late API calls
    await sleep(2000);
  }

  /**
   * Extract inline artifacts (CODE_FILE assets) directly from conversation JSON.
   * These are AI-generated files embedded in pro_search_steps and assets_answer_mode blocks.
   * Returns the file content, filename, and metadata — no URL fetching needed.
   */
  private extractInlineArtifacts(conversation: ConversationResponse): InlineArtifact[] {
    const artifacts: InlineArtifact[] = [];
    const seenFilenames = new Set<string>();

    const KNOWN_USAGES = new Set([
      "sources_answer_mode", "image_answer_mode", "video_answer_mode",
      "plan", "media_items", "ask_text", "pro_search_steps",
      "reasoning_plan", "shopping_mode", "web_results",
      "assets_answer_mode", "answer_assets_preview",
      "answer_tabs", "pending_followups"
    ]);

    for (const entry of conversation.entries) {
      for (const block of (entry.blocks || [])) {
        const usage = (block as any).intended_usage || "";

        // Log UNKNOWN block types so we can discover new structures
        if (usage && !KNOWN_USAGES.has(usage) && !usage.startsWith("ask_text")) {
          debug(`[BLOCK-DISCOVERY] Unknown block type: "${usage}" — Full: ${JSON.stringify(block).substring(0, 200)}`);
        }

        // Collect assets from multiple block types
        let assetsToScan: StepAsset[] = [];

        // 1. pro_search_steps: step.assets[]
        if (usage === "pro_search_steps") {
          const planBlock = (block as any).plan_block;
          if (planBlock?.steps) {
            for (const step of planBlock.steps) {
              if (step.assets && Array.isArray(step.assets)) {
                assetsToScan.push(...step.assets);
              }
            }
          }
        }

        // 2. assets_answer_mode: assets_mode_block.assets[]
        if (usage === "assets_answer_mode") {
          const assetsBlock = (block as any).assets_mode_block;
          if (assetsBlock?.assets && Array.isArray(assetsBlock.assets)) {
            assetsToScan.push(...assetsBlock.assets);
          }
        }

        // 3. answer_assets_preview: inline_entity_block.assets_preview_block.assets[]
        if (usage === "answer_assets_preview") {
          const preview = (block as any).inline_entity_block?.assets_preview_block;
          if (preview?.assets && Array.isArray(preview.assets)) {
            assetsToScan.push(...preview.assets);
          }
        }

        // Now extract CODE_FILE assets
        for (const asset of assetsToScan) {
          if (asset.asset_type !== "CODE_FILE" || !asset.code_file) continue;

          const cf = asset.code_file;
          const filename = cf.filename || cf.name || `artifact_${asset.uuid}`;

          // Skip duplicates (same asset appears in multiple block types)
          if (seenFilenames.has(filename)) continue;
          seenFilenames.add(filename);

          let content = cf.content || "";

          // Check if content is truncated (compare with file_size)
          const isTruncated = content.length < (cf.file_size * 0.9);

          if (isTruncated) {
            debug(`[ARTIFACT] Content for "${filename}" appears truncated (${content.length} chars vs ${cf.file_size} bytes). Trying CODE_ASSET fallback...`);

            // Try to extract full content from sibling CODE_ASSET's script field
            const codeAsset = assetsToScan.find(a => a.asset_type === "CODE_ASSET" && a.code?.script);
            if (codeAsset?.code?.script) {
              const extracted = this.extractHtmlFromScript(codeAsset.code.script);
              if (extracted && extracted.length > content.length) {
                content = extracted;
                debug(`[ARTIFACT] Recovered full content from CODE_ASSET script (${content.length} chars)`);
              }
            }
          }

          if (!content || content.length === 0) {
            debug(`[ARTIFACT] WARNING: No content found for "${filename}", skipping.`);
            continue;
          }

          const downloadUrl = cf.url || asset.download_info?.[0]?.url;

          artifacts.push({
            filename,
            content,
            mimeType: cf.mime_type || "text/html",
            fileSize: cf.file_size || content.length,
            url: downloadUrl,
          });

          debug(`[ARTIFACT] Extracted inline artifact: "${filename}" (${content.length} chars, ${cf.mime_type || "unknown"})`);
        }
      }
    }

    return artifacts;
  }

  /**
   * Extract HTML content from a Python script wrapper.
   * Perplexity's CODE_ASSET wraps HTML in: html = r'''...'''\nopen(...).write(html)
   */
  private extractHtmlFromScript(script: string): string | null {
    // Match triple-quoted string: r'''...''' or '''...''' or """..."""
    const tripleQuotePatterns = [
      /r?'''([\s\S]*?)'''/,
      /r?"""([\s\S]*?)"""/,
    ];

    for (const pattern of tripleQuotePatterns) {
      const match = script.match(pattern);
      if (match && match[1] && match[1].includes("<")) {
        return match[1];
      }
    }

    return null;
  }

  private async extractUrlsFromDOM(): Promise<string[]> {
    debug("🕵️ Checking DOM for hidden artifact links...");
    const urls = await this.page.evaluate(() => {
      const found: string[] = [];
      const links = Array.from(document.querySelectorAll('a[href]'));

      const GENERATED_DOMAINS = ["perplexity.ai/page/", "s3.amazonaws.com", "ppl-ai", "imagedelivery.net"];

      links.forEach(link => {
        const href = (link as HTMLAnchorElement).href;
        if (GENERATED_DOMAINS.some(domain => href.includes(domain))) {
          found.push(href);
        }
      });

      const media = Array.from(document.querySelectorAll('img, video, iframe, source'));
      media.forEach(m => {
        const src = (m as any).src || (m as any).srcset;
        if (src && GENERATED_DOMAINS.some(domain => src.includes(domain))) {
          found.push(src);
        }
      });

      return Array.from(new Set(found));
    });

    if (urls.length > 0) {
      debug(`🎯 DOM Extraction: Found ${urls.length} potential artifact/media links.`);
      urls.forEach((u, i) => {
        if (i < 5) debug(`  [${i}] ${u}`);
        else if (i === 5) debug(`  ... and ${urls.length - 5} more.`);
      });
    } else {
      debug("🔍 DOM Extraction: No supplemental links found on this page.");
    }

    return urls;
  }

  /**
   * Fetch additional pages of a thread using the cursor from the API.
   * Runs fetch() inside the page context to reuse the browser session cookies.
   */
  private async fetchNextPages(threadId: string, firstPage: ConversationResponse): Promise<ConversationResponse> {
    let allEntries = [...firstPage.entries];
    const seenUuids = new Set<string>(allEntries.map(e => e.uuid));
    let cursor = firstPage.next_cursor;
    let hasNext = firstPage.has_next_page;
    let pageNum = 1;

    while (hasNext && cursor) {
      pageNum++;
      debug(`Fetching older page ${pageNum} for thread ${threadId} (cursor: ${cursor.substring(0, 20)}...)`);

      await sleep(1000); // Increased delay slightly for stability

      const nextPageData = await this.page.evaluate(async (tId: string, cur: string) => {
        try {
          const url = `https://www.perplexity.ai/rest/thread/${tId}?cursor=${encodeURIComponent(cur)}`;
          const resp = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: {
              "Accept": "application/json",
            },
          });
          if (!resp.ok) {
            return { error: `HTTP ${resp.status}`, entries: [], has_next_page: false, next_cursor: null };
          }
          return await resp.json();
        } catch (e: any) {
          return { error: e.message, entries: [], has_next_page: false, next_cursor: null };
        }
      }, threadId, cursor);

      if (nextPageData.error) {
        debug(`Pagination error on page ${pageNum}: ${nextPageData.error}`);
        break;
      }

      if (!nextPageData.entries || nextPageData.entries.length === 0) {
        debug(`Page ${pageNum} returned 0 entries. Stopping pagination early.`);
        break;
      }

      debug(`Page ${pageNum}: got ${nextPageData.entries.length} entries (hasNext: ${nextPageData.has_next_page})`);

      // Add new entries to the FRONT of the array (older entries come first in final output)
      const newEntries = [];
      for (const entry of nextPageData.entries) {
        if (!seenUuids.has(entry.uuid)) {
          newEntries.push(entry);
          seenUuids.add(entry.uuid);
        }
      }

      if (newEntries.length > 0) {
        allEntries.unshift(...newEntries);
        debug(`Added ${newEntries.length} older entries to the start of the thread.`);
      }

      hasNext = nextPageData.has_next_page;
      cursor = nextPageData.next_cursor;

      if (hasNext && !cursor) {
        debug(`[PAGINATION] API reports has_next_page: true but cursor is null for thread ${threadId}. Stopping pagination.`);
        hasNext = false;
      }
    }

    if (hasNext && !cursor && pageNum === 1) {
      debug(`[PAGINATION] Thread ${threadId} has no next_cursor on page 1. Assuming single-page thread.`);
    }

    debug(`Pagination complete: ${allEntries.length} total unique entries across ${pageNum} page(s)`);

    return {
      ...firstPage,
      entries: allEntries,
      has_next_page: false,
      next_cursor: null,
    };
  }

  /**
   * Navigate to a thread URL, harvest the BEST API response, and fetch all pages.
   */
  async loadThreadFromURL(url: string): Promise<ThreadData> {
    debug(`Navigating to ${url}...`);

    // Extract threadId from URL to correlate harvested data
    // Perplexity uses the last part of the path as the ID in rest calls
    const threadIdFromUrl = url.split("/").pop()?.split("?")[0] || "";
    this.currentThreadId = threadIdFromUrl;

    // Clear previous harvests for this ID to ensure fresh data
    this.capturedResponses.delete(threadIdFromUrl);

    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Trigger lazy loads (This also gives time for ALL API responses to come in)
      await this.scrollToBottom();

    } catch (e: any) {
      debug(`Navigation error: ${e.message} `);
    }

    // After scrolling, we check our harvest for the BEST response
    // If we have nothing yet, we wait a bit longer
    let waitAttempts = 0;
    while (!this.capturedResponses.has(threadIdFromUrl) && waitAttempts < 10) {
      debug(`[API - WAIT] Waiting for at least one thread response for ${threadIdFromUrl}...`);
      await sleep(1000);
      waitAttempts++;
    }

    const conversation = this.capturedResponses.get(threadIdFromUrl);
    if (!conversation) {
      throw new Error(`Timeout waiting for thread data API response for ${threadIdFromUrl}`);
    }

    debug(`[API] Final Selection: Thread ${threadIdFromUrl} with ${conversation.entries.length} entries.`);

    // Extract urls from DOM as well
    const domUrls = await this.extractUrlsFromDOM();
    conversation.domUrls = domUrls;

    // Extract inline artifacts (CODE_FILE assets) from conversation JSON
    const inlineArtifacts = this.extractInlineArtifacts(conversation);
    if (inlineArtifacts.length > 0) {
      debug(`[ARTIFACT] Found ${inlineArtifacts.length} inline artifact(s) in conversation data.`);
    }

    // If there are more pages, fetch them all
    let finalConversation = conversation;
    if (conversation.has_next_page || conversation.next_cursor) {
      debug(`Thread ${threadIdFromUrl} flagged with has_more (Cursor present). Fetching remaining entries...`);
      finalConversation = await this.fetchNextPages(threadIdFromUrl, conversation);
    }

    // Final Sort: Ensure strictly chronological order regardless of how entries were harvested/merged
    finalConversation.entries.sort((a, b) => {
      const timeA = new Date(a.updated_datetime || a.entry_updated_datetime || 0).getTime();
      const timeB = new Date(b.updated_datetime || b.entry_updated_datetime || 0).getTime();
      return timeA - timeB;
    });

    return {
      id: threadIdFromUrl,
      conversation: finalConversation,
      domUrls: domUrls,
      inlineArtifacts,
    };
  }
}
