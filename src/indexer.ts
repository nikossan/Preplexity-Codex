import { promises as fs } from "fs";
import { ConversationResponse } from "./types/conversation";

const INDEX_FILE = "search-index.json";

export async function updateSearchIndex(id: string, conversation: ConversationResponse, filename: string) {
    let index: any[] = [];

    try {
        const content = await fs.readFile(INDEX_FILE, "utf-8");
        index = JSON.parse(content);
    } catch (e) {
        // Index doesn't exist yet
    }

    const firstEntry = conversation.entries?.[0];
    if (!firstEntry) return;

    // Prioritize Perplexity's AI-generated thread title if available
    const threadTitle = firstEntry.thread_title?.trim();
    const rawQuery = (firstEntry.query_str || "Untitled Conversation").trim();

    let title = "";
    let remainingQuery = "";

    if (threadTitle && threadTitle.length > 0 && threadTitle !== "Untitled Conversation") {
        title = threadTitle;
    } else {
        // Fallback: Split original query logic: Max 15 words or 2 sentences
        const sentences = rawQuery.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [rawQuery];
        const sentencePart = sentences.slice(0, 2).join(" ").trim();
        const words = rawQuery.split(/\s+/);
        const wordPart = (words.length > 15 ? words.slice(0, 15).join(" ") : rawQuery).trim();

        if (words.length <= 15 && sentences.length <= 2) {
            title = rawQuery;
        } else {
            // Use the shorter truncation to keep it concise
            title = wordPart.length < sentencePart.length ? wordPart : sentencePart;
        }

        const isTruncated = title.length < rawQuery.length;
        remainingQuery = isTruncated ? rawQuery.substring(title.length).trim() : "";
        if (remainingQuery.startsWith("?") || remainingQuery.startsWith(".") || remainingQuery.startsWith("!")) {
            // Handle case where title split right before punctuation
            title += remainingQuery[0];
            remainingQuery = remainingQuery.substring(1).trim();
        }
    }

    // Extract first reply
    let firstReplyText = "";
    const firstReplyBlock = (conversation.entries[0]?.blocks || []).find(b => b.intended_usage === "ask_text");
    if (firstReplyBlock && "markdown_block" in firstReplyBlock) {
        firstReplyText = (firstReplyBlock.markdown_block?.answer || "").trim();

        const normalizedQuery = rawQuery.toLowerCase().trim();

        // Split into lines and aggressively strip echoes
        let lines = firstReplyText.split(/\n/);
        let startIndex = 0;

        while (startIndex < lines.length) {
            const line = lines[startIndex].trim();
            if (!line) {
                startIndex++;
                continue;
            }

            // Clean the line of MD markers to see if it's just the query repeating
            const textOnly = line.replace(/[#>*_\[\]!]/g, "").trim().toLowerCase();

            // If the line is short and matches query, or contains the long query almost entirely
            const isRepetition = textOnly === normalizedQuery ||
                (normalizedQuery.length > 20 && textOnly.includes(normalizedQuery)) ||
                (textOnly.length > 20 && normalizedQuery.includes(textOnly));

            // Also check for common "headers" or "callout types"
            const isMetadataLine = line.match(/^#+\s+/i) || line.match(/^>\[!.*?\]/i);

            if (isRepetition || (isMetadataLine && textOnly.includes(normalizedQuery.substring(0, 20)))) {
                startIndex++;
            } else {
                break;
            }
        }

        firstReplyText = lines.slice(startIndex).join("\n").trim();

        // 2. Strip lead-ins like "To answer your question..."
        const preambles = ["to answer your question", "you asked about", "regarding your question", "here is the answer", "according to the search"];
        for (const p of preambles) {
            if (firstReplyText.toLowerCase().startsWith(p)) {
                const nextNewline = firstReplyText.indexOf("\n");
                if (nextNewline !== -1) {
                    firstReplyText = firstReplyText.substring(nextNewline + 1).trim();
                } else if (firstReplyText.length < 100) {
                    // If it's just a short preamble line with no newline, skip it
                    firstReplyText = "";
                }
            }
        }

        // 3. Final check for direct query repetition at the very start (one last pass)
        if (firstReplyText.toLowerCase().startsWith(normalizedQuery)) {
            firstReplyText = firstReplyText.substring(normalizedQuery.length).trim();
            if (firstReplyText.startsWith(":") || firstReplyText.startsWith(".") || firstReplyText.startsWith(",")) {
                firstReplyText = firstReplyText.substring(1).trim();
            }
        }
    }

    // Build snippet: continues from title if truncated, else starts with the reply
    let snippet = (remainingQuery ? "..." + remainingQuery : "") + (firstReplyText ? (remainingQuery ? " " : "") + firstReplyText : "");
    snippet = snippet.trim();

    // Full text for search indexing
    const fullText = (conversation.entries || []).map(e => {
        const block = (e.blocks || []).find((b: any) => b.intended_usage === "ask_text");
        const markdownBlock = block && "markdown_block" in block ? block.markdown_block : null;
        return `${e.query_str || ""}\n${markdownBlock?.answer || ""}`;
    }).join("\n\n");

    const entry = {
        id,
        title,
        snippet,
        content: fullText,
        url: `https://www.perplexity.ai/search/${firstEntry.thread_url_slug}`,
        filename,
        date: firstEntry.updated_datetime
    };

    const existingIndex = index.findIndex(item => item.id === id);
    if (existingIndex >= 0) {
        index[existingIndex] = entry;
    } else {
        index.push(entry);
    }

    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
    console.log(`[IDX] Updated search index for: ${title}`);
}
