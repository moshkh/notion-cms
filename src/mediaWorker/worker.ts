interface Env {
  MEDIA_CDN: R2Bucket;
  MEDIA_SECRET_KEY: string;
  R2_PUBLIC_URL: string;
}

interface UploadRequest {
  url: string;
  mediaType: "image" | "video";
  userId: string;
  blockId: string;
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

    // Verify secret key
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.MEDIA_SECRET_KEY}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      // Parse request body
      const body: UploadRequest = await request.json();

      if (!body.url || !body.mediaType || !body.userId || !body.blockId) {
        return new Response(
          "Missing required fields: url, mediaType, and userId",
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Validate userId format (assuming it should be non-empty and alphanumeric)
      if (!/^[a-zA-Z0-9-_]+$/.test(body.userId)) {
        return new Response("Invalid userId format", {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate mediaType
      if (!["image", "video"].includes(body.mediaType)) {
        return new Response('Invalid mediaType. Must be "image" or "video"', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Fetch the media from the provided URL
      const mediaResponse = await fetch(body.url);
      if (!mediaResponse.ok) {
        return new Response("Failed to fetch media from provided URL", {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Get content type and generate a unique filename
      const contentType =
        mediaResponse.headers.get("Content-Type") ||
        (body.mediaType === "image" ? "image/jpeg" : "video/mp4");

      const fileExtension =
        contentType.split("/")[1] ||
        (body.mediaType === "image" ? "jpg" : "mp4");

      const uniqueId = crypto.randomUUID();
      const key = `${body.userId}/${body.mediaType}s/${body.blockId}.${fileExtension}`;

      // Upload to R2
      await env.MEDIA_CDN.put(key, mediaResponse.body, {
        httpMetadata: {
          contentType: contentType,
        },
      });

      // Generate public URL
      const publicUrl = `${env.R2_PUBLIC_URL}/${key}`;

      return new Response(
        JSON.stringify({
          success: true,
          url: publicUrl,
          key: key,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      console.error("Error processing media upload:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to process media upload",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
};
