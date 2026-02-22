export interface Conversation {
  title: string;
  url: string;
  /** Timestamp text scraped from the library page (e.g. "Feb 20, 2026" or "13 hours ago") */
  libraryTimestamp?: string;
}

/** Per-thread record stored in done.json */
export interface ProcessedThread {
  /** ISO date string from the thread API's latest entry updated_datetime */
  lastUpdated: string;
  /** ISO date string when we downloaded this thread */
  downloadedAt: string;
}

/**
 * New done.json format: a map of URL → ProcessedThread.
 * Backward-compatible: loadDoneFile auto-migrates the old array format.
 */
export interface DoneFile {
  processed: Record<string, ProcessedThread>;
}
