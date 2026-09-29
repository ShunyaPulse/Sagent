import { z } from "zod";
import * as cheerio from "cheerio";
import { AgentTool } from "../core/types.js";
import { assertSafeUrl } from "../security/ssrf.js";

const httpFetcherSchema = z.object({
  url: z
    .string()
    .transform((val) => {
      let trimmed = val.trim();
      if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        trimmed = "https://" + trimmed;
      }
      return trimmed;
    })
    .pipe(z.string().url("Must be a valid HTTP or HTTPS URL")),
  maxCharacters: z.coerce.number().int().min(100).max(10000).default(3000),
});

export const httpFetcherTool: AgentTool<typeof httpFetcherSchema> = {
  name: "http_fetcher",
  description:
    "Fetches content from a public web URL, eliminates ads/scripts/HTML tags, and returns clean readable Markdown text.",
  parameters: httpFetcherSchema,
  execute: async ({ url, maxCharacters }, context) => {
    // 1. SSRF Defense: Assert target destination is a safe public IP
    const safeUrl = await assertSafeUrl(url);

    // 2. Fetch with strict timeout and size limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(safeUrl.toString(), {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Sagent-Autonomous-Agent/1.0 (+https://github.com/ShunyaPulse/Sagent)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
      });

      if (!res.ok) {
        return {
          error: `HTTP request failed with status code ${res.status}: ${res.statusText}`,
          url,
        };
      }

      const contentType = res.headers.get("content-type") || "";
      const rawText = await res.text();

      // If already plain text or JSON
      if (!contentType.includes("html")) {
        return {
          url,
          contentType,
          content: rawText.slice(0, maxCharacters),
        };
      }

      // 3. Clean HTML using Cheerio
      const $ = cheerio.load(rawText);

      // Strip unnecessary tags
      $(
        "script, style, nav, footer, header, noscript, svg, iframe, form, button, link",
      ).remove();

      // Extract main text or body
      const mainContent = $("main, article, #content, .content, body").first();
      let cleanedText = mainContent.text().replace(/\s+/g, " ").trim();

      if (cleanedText.length > maxCharacters) {
        cleanedText =
          cleanedText.slice(0, maxCharacters) + "\n... [Content truncated]";
      }

      return {
        url,
        title: $("title").text().trim() || "Untitled Page",
        content: cleanedText,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Timeout: Web request to ${url} exceeded 8 seconds.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
};
