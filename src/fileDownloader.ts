import { promises as fs } from "fs";
import path from "path";
import { Page } from "puppeteer";
import { ConversationResponse } from "./types/conversation";
import { DownloadManager } from "./DownloadManager";

export async function downloadGeneratedFiles(
    page: Page,
    conversation: ConversationResponse,
    baseOutputDir: string,
    threadId: string,
    extraUrls: string[] = []
): Promise<{ localFiles: Record<string, string>; skippedFiles: Array<{ url: string; error: string }> }> {
    const localFiles: Record<string, string> = {};
    const skippedFiles: Array<{ url: string; error: string }> = [];
    const filesDir = path.join(baseOutputDir, "files", threadId);
    await fs.mkdir(filesDir, { recursive: true });

    const downloadManager = await DownloadManager.create(page, filesDir);

    // Recursive function to find all URLs in the conversation object
    function extractAllUrls(obj: any): string[] {
        let urls: string[] = [];
        if (!obj || typeof obj !== "object") return urls;

        if (typeof obj === "string") {
            if (obj.startsWith("http://") || obj.startsWith("https://")) {
                urls.push(obj);
            }
            return urls;
        }

        for (const key in obj) {
            urls = urls.concat(extractAllUrls(obj[key]));
        }
        return urls;
    }

    const allUrls = extractAllUrls(conversation).concat(extraUrls);

    // FILTER: Only download files that are clearly Perplexity-generated (S3 or Perplexity domains)
    const GENERATED_DOMAINS = ["perplexity.ai", "s3.amazonaws.com", "ppl-ai", "imagedelivery.net"];
    const uniqueUrls = Array.from(new Set(allUrls)).filter(url => {
        // Skip common web references that aren't artifacts
        const skipPatterns = ["google.com", "bing.com", "youtube.com", "twitter.com", "facebook.com", "linkedin.com"];
        const matchesDomain = GENERATED_DOMAINS.some(domain => url.toLowerCase().includes(domain.toLowerCase()));
        const isNotSkipped = !skipPatterns.some(p => url.toLowerCase().includes(p));
        return matchesDomain && isNotSkipped;
    });

    for (const url of uniqueUrls) {
        try {
            console.log(`[DL] Downloading generated file: ${url}`);
            let filename: string | null = null;

            // Pre-emptively start waiting for a download event in case navigation is aborted
            const downloadPromise = downloadManager.waitForDownload().catch(() => null);

            try {
                // NEVER use page.goto() for media artifacts as it navigates the main tab away from the conversation.
                // Instead, perform a fetch directly in the page context.
                const downloadData = await page.evaluate(async (fetchUrl) => {
                    try {
                        const r = await fetch(fetchUrl);
                        if (!r.ok) return { error: `HTTP ${r.status}` };

                        const contentType = r.headers.get("content-type") || "";
                        const blob = await r.blob();
                        const arrBuffer = await blob.arrayBuffer();

                        // Convert to base64 to pass back to Node
                        const uint8 = new Uint8Array(arrBuffer);
                        let binary = '';
                        const len = uint8.byteLength;
                        for (let i = 0; i < len; i++) {
                            binary += String.fromCharCode(uint8[i]);
                        }
                        return {
                            base64: btoa(binary),
                            type: contentType
                        };
                    } catch (e: any) {
                        return { error: e.message };
                    }
                }, url);

                if (downloadData && !downloadData.error && downloadData.base64) {
                    const buffer = Buffer.from(downloadData.base64, "base64");
                    const contentType = downloadData.type || "";

                    const isMedia = contentType.includes("image") ||
                        contentType.includes("video") ||
                        contentType.includes("pdf") ||
                        contentType.includes("application/octet-stream") ||
                        (contentType.includes("text/html") && url.includes("perplexity.ai"));

                    if (isMedia) {
                        const urlObj = new URL(url);
                        let baseName = path.basename(urlObj.pathname);

                        if (!baseName || baseName === "/" || baseName.length < 3 || !baseName.includes(".")) {
                            const timestamp = Date.now();
                            if (contentType.includes("text/html")) baseName = `artifact_${timestamp}.html`;
                            else baseName = `file_${timestamp}`;
                        }

                        if (!path.extname(baseName)) {
                            if (contentType.includes("png")) baseName += ".png";
                            else if (contentType.includes("jpeg")) baseName += ".jpg";
                            else if (contentType.includes("pdf")) baseName += ".pdf";
                            else if (contentType.includes("webp")) baseName += ".webp";
                            else if (contentType.includes("text/html")) baseName += ".html";
                            else if (contentType.includes("image")) baseName += ".png";
                        }

                        const targetPath = path.join(filesDir, baseName);
                        await fs.writeFile(targetPath, buffer);
                        filename = targetPath;
                        console.log(`[DL] Saved content (${contentType}): ${filename}`);
                    }
                } else if (downloadData?.error) {
                    throw new Error(downloadData.error);
                }
            } catch (e: any) {
                // Fallback for real downloads that trigger navigation/dialogs
                if (e.message.includes("net::ERR_ABORTED") || e.message.includes("download")) {
                    console.log(`[DL] Possible file download detected for ${url}, attempting capture...`);
                    filename = await Promise.race([
                        downloadPromise,
                        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Download timeout")), 15000))
                    ]) as string | null;
                } else {
                    throw e;
                }
            }

            if (filename) {
                const relativePath = path.relative(baseOutputDir, filename);
                localFiles[url] = relativePath;
                console.log(`[DL] Completed ${url}`);
            } else {
                throw new Error("Could not capture file via buffer or download event");
            }
        } catch (error: any) {
            console.warn(`[DL] Skipped ${url}: ${error.message}`);
            skippedFiles.push({ url, error: error.message });
        }
    }

    return { localFiles, skippedFiles };
}
