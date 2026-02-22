import { appendFileSync, writeFileSync } from "fs";

const LOG_FILE = "debug.log";
let _enabled = false;

/**
 * Initialise the debug logger.
 * Call once at startup with the value from config.json.
 * Clears the previous log file on each run.
 */
export function initDebugLog(enabled: boolean): void {
    _enabled = enabled;
    if (_enabled) {
        writeFileSync(LOG_FILE, `--- Debug log started at ${new Date().toISOString()} ---\n`);
    }
}

/**
 * Get a local human-readable timestamp.
 */
function getTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-GB') + '.' + now.getMilliseconds().toString().padStart(3, '0');
}

/**
 * Internal helper to write to file if enabled.
 */
function logToFile(line: string): void {
    if (_enabled) {
        try {
            appendFileSync(LOG_FILE, `${line}\n`);
        } catch (e) {
            // Fallback if file writing fails
            console.error(`[CRITICAL] Failed to write to debug.log: ${e}`);
        }
    }
}

/**
 * Log a debug message.
 */
export function debug(msg: string): void {
    const stamp = getTimestamp();
    const line = `[${stamp}] [DEBUG] ${msg}`;
    if (_enabled) console.log(line);
    logToFile(line);
}

/**
 * Log a warning.
 */
export function debugWarn(msg: string): void {
    const stamp = getTimestamp();
    const line = `[${stamp}] [WARN] ${msg}`;
    if (_enabled) console.warn(line);
    logToFile(line);
}

/**
 * Log an error.
 */
export function debugError(msg: string, error?: any): void {
    const stamp = getTimestamp();
    const errorSuffix = error ? ` | Error: ${error.message || error}` : "";
    const line = `[${stamp}] [ERROR] ${msg}${errorSuffix}`;
    if (_enabled) console.error(line);
    if (error && error.stack) {
        logToFile(`[${stamp}] [STACK] ${error.stack}`);
    }
    logToFile(line);
}
