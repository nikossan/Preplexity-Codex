import { promises as fs } from "fs";
import { DoneFile } from "./types";

/**
 * Load done.json with backward-compatible migration.
 * Old format: { processedUrls: string[] }
 * New format: { processed: { [url]: { lastUpdated, downloadedAt } } }
 */
export async function loadDoneFile(doneFilePath: string): Promise<DoneFile> {
  try {
    const content = await fs.readFile(doneFilePath, "utf-8");
    const raw = JSON.parse(content);

    // New format already
    if (raw.processed && typeof raw.processed === "object" && !Array.isArray(raw.processed)) {
      return raw as DoneFile;
    }

    // Old format — migrate
    if (raw.processedUrls && Array.isArray(raw.processedUrls)) {
      console.log(`[MIGRATE] Converting old done.json format (${raw.processedUrls.length} URLs) to new format...`);
      const processed: DoneFile["processed"] = {};
      const now = new Date().toISOString();
      for (const url of raw.processedUrls) {
        processed[url] = {
          lastUpdated: now,   // We don't know the real date, use now as placeholder
          downloadedAt: now,
        };
      }
      const migrated: DoneFile = { processed };
      await fs.writeFile(doneFilePath, JSON.stringify(migrated, null, 2));
      console.log(`[MIGRATE] Done. Saved new format.`);
      return migrated;
    }

    return { processed: {} };
  } catch (error) {
    console.error(`Error loading done file ${doneFilePath}:`, error);
    return { processed: {} };
  }
}

export async function saveDoneFile(
  doneFile: DoneFile,
  doneFilePath: string
): Promise<void> {
  await fs.writeFile(doneFilePath, JSON.stringify(doneFile, null, 2));
}

/** Helper: check if a URL has been processed */
export function isProcessed(doneFile: DoneFile, url: string): boolean {
  return url in doneFile.processed;
}

/** Helper: get the number of processed threads */
export function processedCount(doneFile: DoneFile): number {
  return Object.keys(doneFile.processed).length;
}

/** Helper: mark a URL as processed with timestamps */
export function markProcessed(
  doneFile: DoneFile,
  url: string,
  lastUpdated: string
): void {
  doneFile.processed[url] = {
    lastUpdated,
    downloadedAt: new Date().toISOString(),
  };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
