interface Env {
  NOTION_CMS_KV: KVNamespace;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Only allow POST requests

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      // Get the secret from headers
      const secret = request.headers.get("x-notion-secret");
      if (!secret) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Missing webhook secret",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Check if user exists with this secret
      const userData = await env.NOTION_CMS_KV.get(`user:${secret}`);
      if (!userData) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Invalid webhook secret",
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Parse the webhook payload
      const payload = await request.json();

      // Generate a unique ID for this webhook event
      const eventId = crypto.randomUUID();

      // Store the webhook payload in KV with user context somewhere?

      // Return success response
      return new Response(
        JSON.stringify({
          success: true,
          message: "Webhook received and stored",
          eventId,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    } catch (error) {
      // Log the error
      console.error("Error processing webhook:", error);

      // Return error response
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to process webhook",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
  },
};
