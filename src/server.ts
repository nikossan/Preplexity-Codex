import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { runAutoExport } from "./auto-export";
import { Browser } from "puppeteer";
import { initDebugLog, debug, debugError } from "./debug";


const app = express();
const PORT = 3000;
const CONFIG_FILE = "config.json";
const INDEX_FILE = "search-index.json";

let sharedBrowser: Browser | null = null;
let lastUsedAt = Date.now();
let inactivityTimer: NodeJS.Timeout | null = null;
let isExporting = false;

app.use(cors());
app.use(express.json());

// Serve static files (exports and viewer)
app.use(express.static("."));
app.use(express.static("export"));

// Get config
app.get("/api/config", async (req, res) => {
    try {
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ error: "Failed to read config" });
    }
});

// Update config
app.post("/api/config", async (req, res) => {
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(req.body, null, 2));
        res.json({ message: "Config updated" });
    } catch (error) {
        res.status(500).json({ error: "Failed to update config" });
    }
});

// Trigger export
app.post("/api/export", async (req, res) => {
    if (isExporting) {
        debug("[SERVER] Export already in progress. Ignoring request.");
        return res.status(429).json({ error: "Export already in progress" });
    }

    debug("[SERVER] Starting auto-export...");
    isExporting = true;
    res.json({ message: "Export triggered" });

    try {
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }

        // Write initial status immediately to bridge the gap until auto-export starts writing
        await fs.writeFile("status.json", JSON.stringify({
            current: 0,
            total: 1,
            message: "Starting environment...",
            active: true,
            timestamp: new Date().toISOString(),
            type: 'export'
        }, null, 2));

        if (sharedBrowser) {
            if (sharedBrowser.isConnected()) {
                debug(`[SERVER] Passing active shared browser (PID: ${sharedBrowser.process()?.pid}) to export.`);
            } else {
                debug("[SERVER] Shared browser exists but is disconnected. Start fresh.");
                sharedBrowser = null;
            }
        } else {
            debug("[SERVER] No shared browser active. Starting a new session.");
        }

        sharedBrowser = await runAutoExport(sharedBrowser || undefined);
        lastUsedAt = Date.now();
        debug("[SERVER] Auto-export completed.");
    } catch (error: any) {
        debugError("[SERVER] Export failed", error);
    } finally {
        isExporting = false;
        resetInactivityTimer();
    }
});

function resetInactivityTimer() {
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }

    fs.readFile(CONFIG_FILE, "utf-8").then(data => {
        const config = JSON.parse(data);
        if (config.keep_browser_open && config.browser_inactivity_timeout_minutes) {
            const timeoutMinutes = config.browser_inactivity_timeout_minutes;
            const timeoutMs = timeoutMinutes * 60 * 1000;

            debug(`[SERVER] Inactivity timer set: browser will close in ${timeoutMinutes} minutes.`);

            inactivityTimer = setTimeout(async () => {
                if (sharedBrowser) {
                    debug(`[SERVER] Inactivity timeout reached. Closing shared browser after ${timeoutMinutes}m...`);
                    try {
                        await sharedBrowser.close();
                        debug("[SERVER] Shared browser closed successfully.");
                    } catch (e: any) {
                        debugError("[SERVER] Error closing browser during timeout", e);
                    }
                    sharedBrowser = null;
                }
            }, timeoutMs);

            // Also attach a one-time disconnect listener if not already present
            if (sharedBrowser && sharedBrowser.isConnected()) {
                sharedBrowser.once('disconnected', () => {
                    if (sharedBrowser) {
                        debug("[SERVER] Shared browser was disconnected (likely closed manually or by OS).");
                        sharedBrowser = null;
                        if (inactivityTimer) {
                            clearTimeout(inactivityTimer);
                            inactivityTimer = null;
                        }
                    }
                });
            }
        }
    }).catch(err => {
        debugError("[SERVER] Failed to read config for inactivity timer", err);
    });
}



// Get status
app.get("/api/status", async (req, res) => {
    try {
        const data = await fs.readFile("status.json", "utf-8");
        res.json(JSON.parse(data));
    } catch (error) {
        res.json({ current: 0, total: 0, message: "No active export", active: false });
    }
});

// Re-index all
app.get("/api/reindex", async (req, res) => {
    debug("[SERVER] Triggering full re-index...");
    try {
        const child = exec("npm run reindex");
        child.on("close", (code) => {
            debug(`[SERVER] Re-indexing exited with code ${code}`);
        });
        res.json({ message: "Re-indexing started" });
    } catch (e) {
        debugError("[SERVER] Failed to start re-indexing", e);
        res.status(500).json({ error: "Failed to start re-indexing" });
    }
});

// Get index
app.get("/api/index", async (req, res) => {
    try {
        const data = await fs.readFile(INDEX_FILE, "utf-8");
        res.json(JSON.parse(data));
    } catch (error) {
        res.json([]); // return empty array if no index
    }
});

app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}/viewer.html`;
    console.log(`[SERVER] Running at ${url}`);

    // Initialize debug log based on config
    try {
        const configData = await fs.readFile(CONFIG_FILE, "utf-8");
        const config = JSON.parse(configData);
        initDebugLog(config.debug ?? false);
        debug("[SERVER] Debug log initialized.");
    } catch (e) {
        initDebugLog(false);
    }

    // Reset status.json on startup to ensure a clean UI
    fs.writeFile("status.json", JSON.stringify({ current: 0, total: 0, message: "Server started", active: false }));

    // Auto-open browser
    const start = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${start} ${url}`);
});
