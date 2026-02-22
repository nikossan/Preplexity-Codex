import path from "path";
import {
  ConversationResponse,
  ImageModeBlock,
  SourcesModeBlock,
  VideoModeBlock,
  PlanBlock,
  RelatedQueryItem,
  Step,
  SourcesModeRow,
  MediaItem,
} from "./types/conversation";
import { initDebugLog, debug } from "./debug";

const debugRender = (msg: string) => {
  debug(`[RENDER] ${msg}`);
};

export default function renderConversation(
  conversation: ConversationResponse,
  localFiles: Record<string, string> = {}
): string {
  if (!conversation || !conversation.entries) {
    console.warn("[DEBUG] renderConversation called with invalid/missing entries");
    return "";
  }

  const { entries } = conversation;

  if (entries.length === 0) {
    return "";
  }

  let items = [
    `---\nPerplexity URL: https://www.perplexity.ai/search/${conversation.entries[0].thread_url_slug
    }\nLast updated: ${conversation.entries[entries.length - 1].updated_datetime
    }\n---`,
  ];

  entries.forEach((entry, entryIndex) => {
    if (entryIndex > 0) {
      items.push("* * *");
    }

    const queryLines = entry.query_str.split("\n");

    // important to get proper folding
    items.push(`# ${queryLines[0]}`);

    // convenient to read in a callout
    items.push(`>[!important] ${entry.query_str.split("\n").join("\n> ")}`);

    const currentBlocks = entry.blocks || [];

    // 1. Collect all Markdown-based answer blocks (Perplexity often splits these now)
    // We catch anything starting with ask_text_ OR any block that explicitly contains markdown/answer data
    const answerBlocks = currentBlocks.filter(block => {
      const usage = (block.intended_usage || "").toLowerCase();
      const content = JSON.stringify(block);
      const isHandledBySpecial = ["sources_answer_mode", "image_answer_mode", "video_answer_mode", "plan"].includes(usage);

      return !isHandledBySpecial && (
        usage.startsWith("ask_text") ||
        usage.includes("markdown") ||
        usage.includes("answer") ||
        content.includes('"markdown"') ||
        content.includes('"answer"')
      );
    });

    if (answerBlocks.length > 0) {
      debugRender(`Aggregating ${answerBlocks.length} answer blocks for entry ${entryIndex}...`);
    }

    // Handle explicit structural blocks first
    const sourcesBlock = currentBlocks.find(b => b.intended_usage === "sources_answer_mode")?.sources_mode_block;
    const imagesBlock = currentBlocks.find(b => b.intended_usage === "image_answer_mode")?.image_mode_block;
    const videoBlock = currentBlocks.find(b => b.intended_usage === "video_answer_mode")?.video_mode_block;
    const planBlock = currentBlocks.find(b => b.intended_usage === "plan")?.plan_block;
    const proSearchBlock = currentBlocks.find(b => b.intended_usage === "pro_search_steps");
    const proSearchPlan = proSearchBlock ? (proSearchBlock as any).plan_block : null;

    if (planBlock) items.push(renderPlan(planBlock, localFiles));
    if (proSearchPlan && proSearchPlan !== planBlock) items.push(renderPlan(proSearchPlan, localFiles));
    if (imagesBlock) items.push(renderImages(imagesBlock, localFiles));
    if (videoBlock) items.push(renderVideo(videoBlock, localFiles));

    // 2. Render all answer/markdown blocks in sequence (Deduplicated by content)
    const seenTexts = new Set<string>();
    answerBlocks.forEach(block => {
      const textValue = findDeepText(block);
      if (textValue && textValue.trim() && !seenTexts.has(textValue.trim())) {
        items.push(cleanupAnswer(textValue, entryIndex));
        seenTexts.add(textValue.trim());
      }
    });

    if (sourcesBlock) {
      items.push(renderSources(sourcesBlock, entryIndex, localFiles));
    }

    if (entry.related_query_items && entry.related_query_items.length > 0) {
      items.push(renderRelatedQueries(entry.related_query_items));
    }
  });

  // Add supplemental artifacts (those found in DOM but not in blocks)
  const allJsonUrls = new Set(extractAllUrls(conversation));
  const supplementalUrls = Object.keys(localFiles).filter(url => !allJsonUrls.has(url));

  if (supplementalUrls.length > 0) {
    items.push("* * *");
    items.push("## 📎 Supplemental Artifacts");
    supplementalUrls.forEach(url => {
      const localPath = localFiles[url];
      const name = path.basename(localPath);
      items.push(`- [${name}](${localPath})`);
    });
  }

  return items.join("\n\n");
}

function extractAllUrls(obj: any): string[] {
  let urls: string[] = [];
  if (!obj || typeof obj !== "object") return urls;
  if (typeof obj === "string") {
    if (obj.startsWith("http://") || obj.startsWith("https://")) urls.push(obj);
    return urls;
  }
  for (const key in obj) {
    urls = urls.concat(extractAllUrls(obj[key]));
  }
  return urls;
}

function cleanupAnswer(answer: string, entryIndex: number): string {
  return (
    answer
      // every header in the answer has a weird pplx: link, i think for follow-ups
      .replace(/\[(.*?)\]\(pplx:\/\/.*?\)/g, "$1")
      // replace internal numbered refs
      .replace(/\[(\d+)\]/g, (_, num) => ` [[#^${entryIndex + 1}-${num}]] `)
  );
}

function renderSources(sources: SourcesModeBlock, entryIndex: number, localFiles: Record<string, string>): string {
  let sourcesText = `## ${sources.rows.length} Sources\n\n`;
  sources.rows.forEach((row: SourcesModeRow) => {
    const url = row.web_result.url;
    const displayUrl = localFiles[url] || url;
    if (url.startsWith("http")) {
      sourcesText += `- [${row.web_result.name}](${displayUrl}) ${hostLabel(url)}`;
    } else {
      sourcesText += `- ${row.web_result.name} (${displayUrl})`;
    }
    if (row.web_result.snippet) {
      sourcesText += `\n    ${row.web_result.snippet}`;
    }

    if (row.citation) {
      sourcesText += ` ^${entryIndex + 1}-${row.citation}`;
    }
    sourcesText += "\n";
  });

  return sourcesText;
}

function renderImages(images: ImageModeBlock, localFiles: Record<string, string>): string {
  const imagesLine = images.media_items
    .map((item: MediaItem) => {
      const scale = 100 / item.image_height;
      const displayImage = localFiles[item.image] || item.image;
      return `[![${item.name}|${(item.image_width * scale).toFixed(0)}x100](${displayImage})](${item.url})`;
    })
    .join(" ");

  return `${imagesLine}\n`;
}

function renderVideo(video: VideoModeBlock, localFiles: Record<string, string>): string {
  let videosText = "";

  video.media_items.forEach((item) => {
    const displayUrl = localFiles[item.url] || item.url;
    videosText += `- 📺 [${item.name}](${displayUrl}) ${hostLabel(item.url)}\n`;
  });

  return videosText;
}

function renderPlan(plan: PlanBlock, localFiles: Record<string, string> = {}): string {
  let planText = `### 🧠 Pro Search Reasoning\n\n`;

  if (plan.progress) {
    planText += `**Status:** ${plan.progress}\n\n`;
  }

  if (plan.goals && plan.goals.length > 0) {
    planText += `#### Goals\n`;
    plan.goals.forEach(goal => {
      const icon = goal.final ? "✅" : (goal.todo_task_status === "completed" ? "✔️" : "⏳");
      planText += `- ${icon} ${goal.description}\n`;
    });
    planText += `\n`;
  }

  if (plan.steps && plan.steps.length > 0) {
    planText += `#### Steps Taken\n`;
    plan.steps.forEach((step, idx) => {
      planText += `##### Step ${idx + 1}: ${step.step_type}\n`;
      if (step.initial_query_content) {
        planText += `- **Initial Query:** ${step.initial_query_content.query}\n`;
      }
      if (step.search_web_content) {
        planText += `- **Web Searches:**\n`;
        step.search_web_content.queries.forEach(q => {
          planText += `  - \`${q.query}\` (${q.engine})\n`;
        });
      }
      if (step.web_results_content) {
        planText += `- **Found ${step.web_results_content.web_results.length} results**\n`;
      }
      // Render CODE steps with generated file artifacts
      if (step.step_type === "CODE" && step.assets && step.assets.length > 0) {
        for (const asset of step.assets) {
          if (asset.asset_type === "CODE_FILE" && asset.code_file) {
            const cf = asset.code_file;
            const filename = cf.filename || cf.name || "artifact";
            // Check if we have a local copy
            const localKey = `inline://${filename}`;
            const localPath = localFiles[localKey];
            if (localPath) {
              planText += `- **📄 Generated File:** [${filename}](${localPath}) (${cf.file_size} bytes, ${cf.mime_type || "text/html"})\n`;
            } else {
              planText += `- **📄 Generated File:** ${filename} (${cf.file_size} bytes, ${cf.mime_type || "text/html"})\n`;
            }
          }
        }
      }
    });
    planText += `\n`;
  }

  return planText;
}

function renderRelatedQueries(related: RelatedQueryItem[]): string {
  let relatedText = `#### 💡 Related Questions\n\n`;
  related.forEach(item => {
    relatedText += `- ${item.text}\n`;
  });
  return relatedText;
}

function hostLabel(url: string): string {
  try {
    return `(${new URL(url).hostname.replace("www.", "")})`;
  } catch (e) {
    return "";
  }
}

function findDeepText(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;

  // Prefer markdown_block.answer or markdown property
  if (obj.markdown_block?.answer) return obj.markdown_block.answer;
  if (typeof obj.markdown === "string") return obj.markdown;
  if (typeof obj.answer === "string") return obj.answer;
  if (typeof obj.text === "string") return obj.text;

  // Recursively search
  for (const key in obj) {
    if (typeof obj[key] === "object") {
      const found = findDeepText(obj[key]);
      if (found) return found;
    }
  }

  return null;
}
