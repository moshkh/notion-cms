// Web Crypto API is available globally in Cloudflare Workers
import { Client } from "@notionhq/client";
import {
  Heading1BlockObjectResponse,
  TextRichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";

interface Env {
  NOTION_CMS_USERS: KVNamespace;
  NOTION_CMS_WEBHOOKS: KVNamespace;
}

interface NotionMapping {
  statusProperty: {
    id: string;
    draft: string;
    published: string;
    republish: string;
  };
  parentBlocks: {
    schemas: string;
    blogCopy: string;
  };
}

interface UserData {
  verificationSecret: string;
  // other user data...
  notionToken: string;
  webhookUrl?: string;
  notionMapping?: NotionMapping;
  htmlMapping?: object;
}

interface NotionWebhookPayload {
  type: string;
  entity: {
    type: string;
    id: string;
    [key: string]: any; // This is to allow for other properties that may be added to the payload
  };
  [key: string]: any; // This is to allow for other properties that may be added to the payload
}

interface ProcessedBlock {
  blockID: string;
  type: string;
  content: string | null;
  children: ProcessedBlock[] | null;
  html: string;
}

// Allowed block types for processing
const ALLOWED_BLOCK_TYPES = [
  "heading_1",
  "heading_2",
  "heading_3",
  "paragraph",
  "quote",
  "image",
  "video",
  "bulleted_list_item",
  "numbered_list_item",
  "divider",
  "code",
];

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      // Extract user ID from URL path
      const url = new URL(request.url);
      const pathParts = url.pathname.split("/").filter(Boolean);

      // Expecting URL like: /webhook/{userId}
      if (pathParts.length !== 2 || pathParts[0] !== "notion-webhook") {
        return new Response(
          JSON.stringify({
            success: false,
            error:
              "Invalid webhook URL format. Expected: /notion-webhook/{userId}",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const userId = pathParts[1];

      // Get user data from KV store
      const userDataStr = await env.NOTION_CMS_USERS.get(`user:${userId}`);
      if (!userDataStr) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "User not found",
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const userData: UserData = JSON.parse(userDataStr);

      // Check if notion mapping is configured
      if (!userData.notionMapping) {
        return new Response(
          JSON.stringify({
            success: true,
            message: "No notion mapping configured - ignoring webhook",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const notionMapping: NotionMapping = userData.notionMapping;

      // Get the request body for signature validation
      const body = await request.text();
      const notionSignature = request.headers.get("X-Notion-Signature");

      if (!notionSignature) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Missing X-Notion-Signature header",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Validate the webhook signature
      const isTrustedPayload = await validateWebhookSignature(
        body,
        notionSignature,
        userData.verificationSecret
      );

      if (!isTrustedPayload) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Invalid signature - webhook not from Notion",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Parse the validated payload
      const payload: NotionWebhookPayload = JSON.parse(body);

      // Only process properties_updated webhooks
      if (payload.type !== "page.properties_updated") {
        return new Response(
          JSON.stringify({
            success: true,
            message: "Webhook received but not relevant type",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Only process page entity type
      if (payload.entity?.type !== "page") {
        return new Response(
          JSON.stringify({
            success: true,
            message: "Webhook received but entity type is not 'page'",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Get the pageId from the payload
      const pageId: string = payload.entity.id;

      // 1. Check if page exists in our system first
      const pageExists =
        (
          await env.NOTION_CMS_WEBHOOKS.list({
            prefix: `webhook:${userId}-pageId:${pageId}`,
          })
        ).keys.length > 0;

      // Initialize Notion client
      const notion = new Client({
        auth: userData.notionToken,
        fetch: fetch.bind(globalThis),
      });

      try {
        // 2. Get and validate the status property
        const pageStatusProperty = await notion.pages.properties.retrieve({
          page_id: pageId,
          property_id: notionMapping.statusProperty.id,
        });

        // Type guard to ensure we have a status property
        if (pageStatusProperty.type !== "status") {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Expected status property but got different type - ignoring webhook",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        const statusValue = pageStatusProperty.status?.name;

        // Validate status exists
        if (!statusValue) {
          return new Response(
            JSON.stringify({
              success: true,
              message: "Status value is empty - ignoring webhook",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Ignore if status is 'published' as that's set by the worker
        if (statusValue === notionMapping.statusProperty.published) {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Status is 'published' which is worker-controlled - ignoring webhook",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // If page doesn't exist, only allow draft status
        if (
          !pageExists &&
          (statusValue === notionMapping.statusProperty.republish ||
            statusValue === notionMapping.statusProperty.published)
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Cannot set republish/published status on non-existent page - ignoring webhook",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Add this after the existing status checks
        if (pageExists && statusValue === notionMapping.statusProperty.draft) {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Existing page changed to draft status - ignoring webhook",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Validate status value is one of the accepted values
        if (
          ![
            notionMapping.statusProperty.draft,
            notionMapping.statusProperty.published,
            notionMapping.statusProperty.republish,
          ].includes(statusValue)
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              message: `Invalid status value "${statusValue}" - ignoring webhook`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Generate a unique webhook ID and store the webhook
        const uniqueWebhookId = crypto.randomUUID();
        await env.NOTION_CMS_WEBHOOKS.put(
          `webhook:${userId}-pageId:${pageId}-webhookId:${uniqueWebhookId}`,
          JSON.stringify({
            userId,
            uniqueWebhookId,
            payload,
            timestamp: Date.now(),
            pageId,
            status: statusValue,
          }),
          {
            expirationTtl: 180 * 24 * 60 * 60, // 180 days
          }
        );

        // 3. If everything is okay, get the page blocks
        const pageBlocks = await notion.blocks.children.list({
          block_id: pageId,
        });

        const parentBlocks = pageBlocks.results
          .filter(
            (block): block is Heading1BlockObjectResponse =>
              "type" in block &&
              block.type === "heading_1" &&
              ((block.heading_1.rich_text[0] as TextRichTextItemResponse).text
                .content === notionMapping.parentBlocks.schemas ||
                (block.heading_1.rich_text[0] as TextRichTextItemResponse).text
                  .content === notionMapping.parentBlocks.blogCopy)
          )
          .reduce((acc, block) => {
            const content = (
              block.heading_1.rich_text[0] as TextRichTextItemResponse
            ).text.content;
            return {
              ...acc,
              [content]: block,
            };
          }, {} as Record<string, Heading1BlockObjectResponse>);

        // Get parent blocks and their children
        const blogCopyBlock = parentBlocks[notionMapping.parentBlocks.blogCopy];
        const schemasBlock = parentBlocks[notionMapping.parentBlocks.schemas];

        if (!blogCopyBlock || !schemasBlock) {
          return new Response(
            JSON.stringify({
              success: true,
              message: `Missing required sections: ${
                !blogCopyBlock ? "Blog Copy" : ""
              } ${!schemasBlock ? "Schemas" : ""}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Fetch all children of schemas block (handling pagination)
        let schemaBlocks = [];
        let nextCursor = undefined;

        do {
          const response = await notion.blocks.children.list({
            block_id: schemasBlock.id,
            start_cursor: nextCursor,
            page_size: 100, // Maximum allowed by Notion API
          });

          schemaBlocks.push(...response.results);
          nextCursor = response.next_cursor;
        } while (nextCursor);

        // Fetch all children of blogCopy block (handling pagination)
        let blogCopyBlocks = [];
        nextCursor = undefined;

        do {
          const response = await notion.blocks.children.list({
            block_id: blogCopyBlock.id,
            start_cursor: nextCursor,
            page_size: 100, // Maximum allowed by Notion API
          });

          blogCopyBlocks.push(...response.results);
          nextCursor = response.next_cursor;
        } while (nextCursor);

        // Process the blog copy blocks
        const processedBlocks = await processBlocksRecursively(
          blogCopyBlocks,
          notion
        );

        // Generate complete HTML
        const blogHtml = generateCompleteHtml(processedBlocks);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Webhook processed successfully",
            userId,
            pageId,
            status: statusValue,
            pageExists,
            blocksCount: pageBlocks.results.length,
            processedBlocks: processedBlocks,
            completeHtml: blogHtml, // Add this line
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        console.error("Error retrieving page:", error);
        return new Response(
          JSON.stringify({
            success: false,
            error: "Failed to retrieve Notion page",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } catch (error) {
      console.error("Error processing webhook:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to process webhook",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
};

async function validateWebhookSignature(
  body: string,
  notionSignature: string,
  verificationToken: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(verificationToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const calculatedSignature = `sha256=${Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  return calculatedSignature === notionSignature;
}

// Helper function to extract text content from rich text arrays
function extractTextContent(richText: any[]): string {
  if (!richText || !Array.isArray(richText)) {
    return "";
  }

  return richText
    .map((item) => {
      if (item.type === "text") {
        return item.text?.content || "";
      }
      return "";
    })
    .join("");
}

// Helper function to get URL from image or video blocks
function extractMediaUrl(block: any): string | null {
  if (block.type === "image") {
    if (block.image?.type === "external") {
      return block.image.external?.url || null;
    } else if (block.image?.type === "file") {
      return block.image.file?.url || null;
    }
  } else if (block.type === "video") {
    if (block.video?.type === "external") {
      return block.video.external?.url || null;
    } else if (block.video?.type === "file") {
      return block.video.file?.url || null;
    }
  }
  return null;
}

// Helper function to convert rich text to HTML with formatting preservation
function richTextToHtml(richText: any[]): string {
  if (!richText || !Array.isArray(richText)) {
    return "";
  }

  return richText
    .map((item) => {
      if (item.type === "text") {
        let text = item.text?.content || "";
        const annotations = item.annotations || {};

        // Apply formatting in order: bold, italic, strikethrough, underline, code
        if (annotations.code) {
          text = `<code>${text}</code>`;
        }
        if (annotations.bold) {
          text = `<strong>${text}</strong>`;
        }
        if (annotations.italic) {
          text = `<em>${text}</em>`;
        }
        if (annotations.strikethrough) {
          text = `<s>${text}</s>`;
        }
        if (annotations.underline) {
          text = `<u>${text}</u>`;
        }

        // Apply hyperlink if present
        if (item.href) {
          text = `<a href="${item.href}">${text}</a>`;
        }

        return text;
      }
      return "";
    })
    .join("");
}

// Helper function to check if a video URL is a YouTube embed
function isYouTubeUrl(url: string): boolean {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

// Helper function to convert YouTube URL to embed URL
function getYouTubeEmbedUrl(url: string): string {
  // Handle youtube.com/watch?v= format
  const watchMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/
  );
  if (watchMatch) {
    return `https://www.youtube.com/embed/${watchMatch[1]}`;
  }
  return url;
}

// Helper function to generate HTML for a block
function generateBlockHtml(
  block: any,
  children: ProcessedBlock[] | null = null
): string {
  switch (block.type) {
    case "heading_1":
      return `<h1>${richTextToHtml(block.heading_1?.rich_text || [])}</h1>`;

    case "heading_2":
      return `<h2>${richTextToHtml(block.heading_2?.rich_text || [])}</h2>`;

    case "heading_3":
      return `<h3>${richTextToHtml(block.heading_3?.rich_text || [])}</h3>`;

    case "paragraph":
      return `<p>${richTextToHtml(block.paragraph?.rich_text || [])}</p>`;

    case "quote":
      return `<blockquote>${richTextToHtml(
        block.quote?.rich_text || []
      )}</blockquote>`;

    case "code":
      const language = block.code?.language || "";
      const codeContent = extractTextContent(block.code?.rich_text || []);
      return `<pre><code class="${language}">${codeContent}</code></pre>`;

    case "image":
      const imageUrl = extractMediaUrl(block);
      if (imageUrl) {
        const caption = richTextToHtml(block.image?.caption || []);
        return caption
          ? `<img src="${imageUrl}" alt="${caption}" />`
          : `<img src="${imageUrl}" alt="" />`;
      }
      return "";

    case "video":
      const videoUrl = extractMediaUrl(block);
      if (videoUrl) {
        if (isYouTubeUrl(videoUrl)) {
          const embedUrl = getYouTubeEmbedUrl(videoUrl);
          return `<iframe src="${embedUrl}" frameborder="0" allowfullscreen></iframe>`;
        } else {
          return `<video src="${videoUrl}" controls></video>`;
        }
      }
      return "";

    case "divider":
      return "<hr>";

    case "bulleted_list_item":
      const bulletContent = richTextToHtml(
        block.bulleted_list_item?.rich_text || []
      );
      if (children && children.length > 0) {
        const childrenHtml = children.map((child) => child.html).join("");
        return `<ul><li>${bulletContent}${childrenHtml}</li></ul>`;
      }
      return `<ul><li>${bulletContent}</li></ul>`;

    case "numbered_list_item":
      const numberedContent = richTextToHtml(
        block.numbered_list_item?.rich_text || []
      );
      if (children && children.length > 0) {
        const childrenHtml = children.map((child) => child.html).join("");
        return `<ol><li>${numberedContent}${childrenHtml}</li></ol>`;
      }
      return `<ol><li>${numberedContent}</li></ol>`;

    default:
      return "";
  }
}

// Recursive function to process blocks with children (up to 4 levels deep)
async function processBlocksRecursively(
  blocks: any[],
  notion: Client,
  currentDepth: number = 0,
  maxDepth: number = 4
): Promise<ProcessedBlock[]> {
  const processedBlocks: ProcessedBlock[] = [];

  for (const block of blocks) {
    // Skip blocks that don't have the required properties
    if (!block.id || !block.type) {
      continue;
    }

    // Check if block type is allowed
    if (!ALLOWED_BLOCK_TYPES.includes(block.type)) {
      continue;
    }

    let content: string | null = null;
    let children: ProcessedBlock[] | null = null;

    // Process content based on block type
    switch (block.type) {
      case "heading_1":
      case "heading_2":
      case "heading_3":
        content = extractTextContent(block[block.type]?.rich_text);
        break;

      case "paragraph":
        content = extractTextContent(block.paragraph?.rich_text);
        break;

      case "quote":
        content = extractTextContent(block.quote?.rich_text);
        break;

      case "code":
        content = extractTextContent(block.code?.rich_text);
        break;

      case "image":
      case "video":
        content = extractMediaUrl(block);
        break;

      case "divider":
        content = null;
        break;

      case "bulleted_list_item":
        content = extractTextContent(block.bulleted_list_item?.rich_text);
        // Process children if we haven't reached max depth
        if (currentDepth < maxDepth && block.has_children) {
          try {
            const childBlocks = await notion.blocks.children.list({
              block_id: block.id,
            });
            children = await processBlocksRecursively(
              childBlocks.results,
              notion,
              currentDepth + 1,
              maxDepth
            );
          } catch (error) {
            console.error(
              `Error fetching children for block ${block.id}:`,
              error
            );
            children = null;
          }
        }
        break;

      case "numbered_list_item":
        content = extractTextContent(block.numbered_list_item?.rich_text);
        // Process children if we haven't reached max depth
        if (currentDepth < maxDepth && block.has_children) {
          try {
            const childBlocks = await notion.blocks.children.list({
              block_id: block.id,
            });
            children = await processBlocksRecursively(
              childBlocks.results,
              notion,
              currentDepth + 1,
              maxDepth
            );
          } catch (error) {
            console.error(
              `Error fetching children for block ${block.id}:`,
              error
            );
            children = null;
          }
        }
        break;

      default:
        // Skip unknown block types
        continue;
    }

    // Generate HTML for the block
    const html = generateBlockHtml(block, children);

    processedBlocks.push({
      blockID: block.id,
      type: block.type,
      content,
      children,
      html,
    });
  }

  return processedBlocks;
}

// Function to generate complete HTML from processed blocks
function generateCompleteHtml(processedBlocks: ProcessedBlock[]): string {
  const result: string[] = [];
  let i = 0;

  function processListItems(
    blocks: ProcessedBlock[],
    listType: "ul" | "ol"
  ): string {
    const listItems: string[] = [];

    for (const item of blocks) {
      let content = item.content || "";

      // Process children recursively if they exist
      if (item.children && item.children.length > 0) {
        const childListType =
          item.children[0].type === "bulleted_list_item" ? "ul" : "ol";
        content += processListItems(item.children, childListType);
      }

      listItems.push(`<li>${content}</li>`);
    }

    return `<${listType}>${listItems.join("")}</${listType}>`;
  }

  while (i < processedBlocks.length) {
    const block = processedBlocks[i];

    if (block.type === "bulleted_list_item") {
      const consecutiveItems: ProcessedBlock[] = [];
      while (
        i < processedBlocks.length &&
        processedBlocks[i].type === "bulleted_list_item"
      ) {
        consecutiveItems.push(processedBlocks[i]);
        i++;
      }
      result.push(processListItems(consecutiveItems, "ul"));
    } else if (block.type === "numbered_list_item") {
      const consecutiveItems: ProcessedBlock[] = [];
      while (
        i < processedBlocks.length &&
        processedBlocks[i].type === "numbered_list_item"
      ) {
        consecutiveItems.push(processedBlocks[i]);
        i++;
      }
      result.push(processListItems(consecutiveItems, "ol"));
    } else {
      result.push(block.html);
      i++;
    }
  }

  return result.join("\n");
}
