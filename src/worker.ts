// Web Crypto API is available globally in Cloudflare Workers

interface Env {
  NOTION_CMS_USERS: KVNamespace;
  NOTION_CMS_WEBHOOKS: KVNamespace;
}

interface UserData {
  verification_secret: string;
  // other user data...
  webhook_url: string;
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
        userData.verification_secret
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
      const payload = JSON.parse(body);

      // Generate a unique ID for this webhook event
      const eventId = crypto.randomUUID();

      // Store the webhook payload in KV with user context
      await env.NOTION_CMS_WEBHOOKS.put(
        `webhook:${userId}:${eventId}`,
        JSON.stringify({
          userId,
          payload,
          timestamp: Date.now(),
          eventId,
        }),
        {
          // Optional: set expiration time (e.g., 180 days)
          expirationTtl: 180 * 24 * 60 * 60,
        }
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: "Webhook received and stored",
          eventId,
          userId,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
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
