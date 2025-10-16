// Web Crypto API is available globally in Cloudflare Workers
import { Client } from "@notionhq/client";
import { CheckboxPropertyItemObjectResponse } from "@notionhq/client/build/src/api-endpoints";

interface Env {
  NOTION_CMS_USERS: KVNamespace;
  NOTION_CMS_WEBHOOKS: KVNamespace;
}

interface NotionMapping {
  statusProperty: {
    id: string;
    draft: string;
    published: string;
  };
  republishProp: {
    id: string;
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

      // Check if the updated property is either statusProperty.id or republishProp.id
      const mappedStatusProperty = notionMapping.statusProperty;
      const mappedRepublishProperty = notionMapping.republishProp;
      const updatedProperties = payload.data.updated_properties || [];
      let isStatusProperty = updatedProperties.includes(
        mappedStatusProperty.id
      );
      let isRepublishProperty = updatedProperties.includes(
        mappedRepublishProperty.id
      );

      // If no relevant property was updated, ignore the webhook
      if (!isStatusProperty && !isRepublishProperty) {
        return new Response(
          JSON.stringify({
            success: true,
            message: "Updated properties are not relevant - ignoring webhook",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Generate a unique webhook ID
      const uniqueWebhookId = crypto.randomUUID();

      // Get the pageId from the payload
      const pageId: string = payload.entity.id;

      // Store the webhook payload in KV with user context

      const pageExists =
        (
          await env.NOTION_CMS_WEBHOOKS.list({
            prefix: `webhook:${userId}-pageId:${pageId}`,
          })
        ).keys.length > 0;

      await env.NOTION_CMS_WEBHOOKS.put(
        `webhook:${userId}-pageId:${pageId}-webhookId:${uniqueWebhookId}`,
        JSON.stringify({
          userId,
          uniqueWebhookId,
          payload,
          timestamp: Date.now(),
          pageId,
        }),
        {
          // Optional: set expiration time (e.g., 180 days)
          expirationTtl: 180 * 24 * 60 * 60,
        }
      );

      const notion = new Client({
        auth: userData.notionToken,
        fetch: fetch.bind(globalThis),
      });

      try {
        const page = await notion.pages.retrieve({ page_id: pageId });

        // Check if notionMapping exists
        const pageStatusProperty = await notion.pages.properties.retrieve({
          page_id: pageId,
          property_id: notionMapping.statusProperty.id,
        });
        const pageRepublishProperty = (await notion.pages.properties.retrieve({
          page_id: pageId,
          property_id: notionMapping.republishProp.id,
        })) as CheckboxPropertyItemObjectResponse;
        const republishChecked = pageRepublishProperty.checkbox;

        // Always check the current status, regardless of which property was updated
        // Type guard to ensure we have a status property
        if (pageStatusProperty.type !== "status") {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Expected status property but got different type - ignoring webhook",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const actualValue = pageStatusProperty.status?.name;
        let isDraft = false;
        let isPublished = false;
        isDraft = mappedStatusProperty.draft === actualValue;
        isPublished = mappedStatusProperty.published === actualValue;

        // Check if the actual value is in acceptedValues
        if (!isDraft && !isPublished) {
          return new Response(
            JSON.stringify({
              success: true,
              message: `Property value "${actualValue}" is not in accepted values - ignoring webhook`,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // IGNORE: New pages set to publish (regardless of republish status)
        if (!pageExists && isPublished) {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Page does not exist and has been changed to published - ignoring webhook",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // IGNORE: Existing pages set to draft (regardless of republish status)
        if (pageExists && isDraft) {
          return new Response(
            JSON.stringify({
              success: true,
              message: "Existing page set to draft - ignoring webhook",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // IGNORE: Existing published pages without republish checked
        if (pageExists && isPublished && !republishChecked) {
          return new Response(
            JSON.stringify({
              success: true,
              message:
                "Existing published page without republish checked - ignoring webhook",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // 3. If everything is okay, get the page blocks
        const pageBlocks = await notion.blocks.children.list({
          block_id: pageId,
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: "Webhook processed successfully",
            userId,
            pageId,
            relevantProperty: isStatusProperty
              ? mappedStatusProperty.id
              : mappedRepublishProperty.id,
            isStatusProperty,
            isRepublishProperty,
            blocksCount: pageBlocks.results.length,
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
