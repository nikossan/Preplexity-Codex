import { promises as fs } from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import { Browser, Page } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { ConversationSaver } from "./ConversationSaver";
import { login } from "./login";
import { getConversations } from "./listConversations";
import renderConversation from "./renderConversation";
import { loadDoneFile, saveDoneFile, sleep, processedCount, markProcessed } from "./utils";
import { updateSearchIndex } from "./indexer";
import { downloadGeneratedFiles } from "./fileDownloader";
import { initDebugLog, debug, debugWarn, debugError } from "./debug";

puppeteer.use(StealthPlugin());

const CONFIG_FILE = "config.json";
const DONE_FILE = "done.json";
const ERROR_FILE = "errors.json";
const STATUS_FILE = "status.json";
const FOUND_FILE = "found.json";

export interface Config {
    email: string;
    delay_min_ms: number;
    delay_max_ms: number;
    file_prefix: string;
    batch_size: number;
    output_dir: string;
    scroll_delay_ms: number;
    debug: boolean;
    keep_browser_open?: boolean;
    browser_inactivity_timeout_minutes?: number;
    scan_mode?: "full" | "top";
    scan_top_limit?: number;
    sidebar_width?: number;
}

async function loadConfig(): Promise<Config> {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
}

async function logError(url: string, error: string) {
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

async function isLoginPage(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
        if (document.querySelector('input[type="email"]')) return true;
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.some(btn => btn.textContent?.includes('Continue with email'));
    });
}

async function logSkippedFiles(threadId: string, skipped: Array<{ url: string; error: string }>) {
    const SKIPPED_FILE = "skipped.json";
    let allSkipped: any[] = [];
    try {
        const content = await fs.readFile(SKIPPED_FILE, "utf-8");
        allSkipped = JSON.parse(content);
    } catch (e) {
        // ignore
    }
    allSkipped.push({
        threadId,
        skipped,
        timestamp: new Date().toISOString()
    });
    await fs.writeFile(SKIPPED_FILE, JSON.stringify(allSkipped, null, 2));
}

async function updateStatus(current: number, total: number, message: string = "", phase: "initializing" | "scanning" | "downloading" | "complete" | "idle" = "downloading") {
    const status = {
        current,
        total,
        message,
        phase,
        timestamp: new Date().toISOString(),
        active: phase !== 'complete' && phase !== 'idle',
        type: 'export'
    };
    await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2));
}

async function logFoundUrls(conversations: any[]) {
    const data = {
        count: conversations.length,
        timestamp: new Date().toISOString(),
        urls: conversations.map(c => ({ title: c.title, url: c.url }))
    };
    await fs.writeFile(FOUND_FILE, JSON.stringify(data, null, 2));
}

export async function runAutoExport(existingBrowser?: Browser): Promise<Browser | null> {
    const config = await loadConfig();
    initDebugLog(config.debug ?? false);
    debug("Starting runAutoExport pipeline...");
    debug(`Config loaded. Output dir: ${config.output_dir}`);

    await fs.mkdir(config.output_dir, { recursive: true });

    const doneFile = await loadDoneFile(DONE_FILE);
    debug(`Loaded ${processedCount(doneFile)} processed URLs`);

    let browser: Browser;
    if (existingBrowser && existingBrowser.isConnected()) {
        debug(`[BROWSER] Reusing existing browser session (PID: ${existingBrowser.process()?.pid})`);
        browser = existingBrowser;
    } else {
        const reason = !existingBrowser ? "no existing browser" : "existing browser disconnected";
        debug(`[BROWSER] Launching new browser (reason: ${reason})...`);
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--window-position=0,0',
                '--force-device-scale-factor=1',
                '--high-dpi-support=1'
            ]
        });
        debug(`[BROWSER] New browser launched (PID: ${browser.process()?.pid})`);
    }

    try {
        let page: Page;
        const pages = await browser.pages();
        if (pages.length > 0) {
            page = pages[0];
            debug("Using existing browser page...");
        } else {
            page = await browser.newPage();
            debug("New page created.");
        }

        // Try to bring to front twice with a small delay
        await page.bringToFront();
        await sleep(1000);
        await page.bringToFront();

        debug("Delegating login check to login.ts...");
        await login(page, config.email);
        debug("Login step completed (either logged in or already had session).");

        // Get new conversations from library
        const { toProcess, allDiscovered } = await getConversations(
            page,
            doneFile,
            config.scroll_delay_ms,
            config.scan_mode || "full",
            config.scan_top_limit || 10,
            (count) => {
                updateStatus(count, 0, `Searching library... (${count} threads found)`, "scanning");
            }
        );
        debug(`Library scan complete. Total unique threads found on page: ${allDiscovered.length}`);
        await logFoundUrls(allDiscovered);
        debug(`[INFO] Found ${allDiscovered.length} total threads in library.`);
        debug(`[INFO] ${toProcess.length} threads needing attention (new or modified).`);

        if (toProcess.length > 0) {
            const batchLimit = config.batch_size;
            if (toProcess.length > batchLimit) {
                debug(`[INFO] Batch size is ${batchLimit}. Processing first ${batchLimit} of ${toProcess.length} pending threads.`);
            } else {
                debug(`[INFO] Processing all ${toProcess.length} pending threads.`);
            }
        }

        if (toProcess.length === 0) {
            debug("Nothing to do.");
            await updateStatus(0, 0, "Idle - Library up to date", "idle");
            return browser;
        }

        const conversationSaver = new ConversationSaver(page);
        await conversationSaver.initialize();

        const limit = Math.min(toProcess.length, config.batch_size);
        await updateStatus(0, limit, "🚀 Initializing export...", "initializing");
        for (let i = 0; i < limit; i++) {
            const conv = toProcess[i];
            debug(`\n[${i + 1}/${limit}] Processing ${conv.url}`);
            await updateStatus(i, limit, `📂 Saving: ${conv.title}...`, "downloading");

            let threadData;
            let attempts = 0;
            const MAX_ATTEMPTS = 3;

            while (attempts < MAX_ATTEMPTS) {
                attempts++;
                try {
                    threadData = await conversationSaver.loadThreadFromURL(conv.url);
                    break;
                } catch (error: any) {
                    debugError(`Attempt ${attempts} failed for ${conv.url}`, error);

                    if (error.message.includes("Perplexity API Error")) {
                        await logError(conv.url, error.message);
                        threadData = null;
                        break;
                    }

                    const isTimeout = error.message.includes("Timeout waiting for thread data");
                    if (isTimeout) {
                        const loginNeeded = await isLoginPage(page);
                        if (loginNeeded) {
                            await login(page, config.email);
                            continue;
                        }
                        if (attempts >= MAX_ATTEMPTS) {
                            await logError(conv.url, "Timeout waiting for API response");
                            threadData = null;
                            break;
                        }
                        await sleep(3000);
                        continue;
                    }

                    const loginNeeded = await isLoginPage(page);
                    if (loginNeeded) {
                        await login(page, config.email);
                    } else {
                        if (attempts >= MAX_ATTEMPTS) {
                            await logError(conv.url, error.message);
                            threadData = null;
                            break;
                        }
                        await sleep(2000);
                    }
                }
            }

            if (!threadData) continue;

            const threadId = threadData.id;
            const safeTitle = config.file_prefix + threadId;

            // Save JSON
            await fs.writeFile(
                `${config.output_dir}/${safeTitle}.json`,
                JSON.stringify(threadData.conversation, null, 2)
            );

            // Save inline artifacts (CODE_FILE assets embedded in JSON)
            const inlineLocalFiles: Record<string, string> = {};
            if (threadData.inlineArtifacts && threadData.inlineArtifacts.length > 0) {
                const artifactDir = path.join(config.output_dir, "files", threadId);
                await fs.mkdir(artifactDir, { recursive: true });
                for (const artifact of threadData.inlineArtifacts) {
                    const targetPath = path.join(artifactDir, artifact.filename);
                    await fs.writeFile(targetPath, artifact.content, "utf-8");
                    const relativePath = path.relative(config.output_dir, targetPath);
                    // Use filename as key (no URL for inline artifacts)
                    inlineLocalFiles[`inline://${artifact.filename}`] = relativePath;
                    debug(`[ARTIFACT] Saved inline artifact: ${targetPath} (${artifact.content.length} chars)`);
                }
                debug(`[ARTIFACT] Saved ${threadData.inlineArtifacts.length} inline artifact(s) to disk.`);
            }

            // Download generated files (URL-based: images, media, etc.)
            const { localFiles, skippedFiles } = await downloadGeneratedFiles(page, threadData.conversation, config.output_dir, threadId, threadData.domUrls || []);

            // Merge inline artifact files into localFiles
            Object.assign(localFiles, inlineLocalFiles);
            if (skippedFiles.length > 0) {
                debug(`[DL] ${skippedFiles.length} files skipped. Logging to skipped.json`);
                await logSkippedFiles(threadId, skippedFiles);
            }

            // Save Markdown
            const markdown = renderConversation(threadData.conversation, localFiles);
            await fs.writeFile(`${config.output_dir}/${safeTitle}.md`, markdown);

            // Mark as processed — store the latest updated_datetime from the thread
            const latestUpdated = threadData.conversation.entries
                .map(e => e.updated_datetime || e.entry_updated_datetime || "")
                .filter(Boolean)
                .sort()
                .pop() || new Date().toISOString();
            markProcessed(doneFile, conv.url, latestUpdated);
            await saveDoneFile(doneFile, DONE_FILE);

            // Update Search Index
            await updateSearchIndex(threadId, threadData.conversation, safeTitle + ".md");

            // Update Progress
            await updateStatus(i + 1, limit, `Processed ${conv.title}`, "downloading");

            // Random delay
            const delay = Math.floor(Math.random() * (config.delay_max_ms - config.delay_min_ms)) + config.delay_min_ms;
            debug(`Waiting ${(delay / 1000).toFixed(1)}s...`);
            await sleep(delay);
        }

        debug("\n✅ Batch completed!");
        await updateStatus(limit, limit, "Batch completed!", "complete");
        return browser;
    } catch (error: any) {
        debugError("Fatal error in runAutoExport", error);
        // Important: Return the current browser instead of null so the server 
        // doesn't "lose" the window even if this specific run failed.
        return (browser! as Browser) || existingBrowser || null;
    } finally {
        // Only close if we explicitly want to close it after every run
        if (browser! && !config.keep_browser_open) {
            debug("[BROWSER] Closing browser as per config (keep_browser_open = false)");
            await browser.close();
        } else if (browser!) {
            debug("[BROWSER] Keeping browser open for next run.");
        }
    }
}

// Check if run directly
if (require.main === module) {
    runAutoExport().catch(console.error);
}
