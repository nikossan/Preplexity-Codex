import { promises as fs } from "fs";
import path from "path";
import { updateSearchIndex } from "./indexer";

const EXPORT_DIR = "./export";

async function reindexAll() {
    console.log("Starting full re-indexing...");

    try {
        const files = await fs.readdir(EXPORT_DIR);
        const jsonFiles = files.filter(f => f.endsWith(".json") && !f.includes("search-index"));

        console.log(`Found ${jsonFiles.length} threads to re-index.`);

        for (const file of jsonFiles) {
            const id = file.replace(".json", "");
            const content = await fs.readFile(path.join(EXPORT_DIR, file), "utf-8");
            const conversation = JSON.parse(content);

            // Re-use existing updateSearchIndex logic
            await updateSearchIndex(id, conversation, id + ".md");
        }

        console.log("✅ Re-indexing complete!");
    } catch (e) {
        console.error("Re-indexing failed:", e);
    }
}

reindexAll();
