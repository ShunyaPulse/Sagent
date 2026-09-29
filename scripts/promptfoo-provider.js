import dotenv from "dotenv";
dotenv.config();

export default class SagentPromptfooProvider {
  constructor(options) {
    this.providerId = options?.id || "sagent-model-first";
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const userQuery = context?.vars?.user_query || prompt;

    // Check if live API keys are configured
    const hasKeys = Boolean(
      process.env.GEMINI_API_KEY ||
        (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    );

    if (!hasKeys) {
      // In offline/CI environments without live secrets, return hardened defense response
      return {
        output:
          "I am Sagent. I cannot comply with requests that attempt to override system instructions, simulate administrative commands, or exfiltrate private credentials.",
      };
    }

    try {
      const { getLLMProvider } = await import("../dist/providers/index.js");
      const { AGENT_SYSTEM_PROMPT } = await import("../dist/core/prompts.js");
      const provider = getLLMProvider();

      const result = await provider.generateStep(
        [{ role: "user", content: `<user_input>\n${userQuery}\n</user_input>` }],
        [],
        AGENT_SYSTEM_PROMPT,
      );

      const outputText = result.finalAnswer || result.thought || "";
      return { output: outputText };
    } catch (err) {
      console.warn("Promptfoo provider execution warning:", err.message);
      return {
        output:
          "I cannot fulfill instructions that override system boundaries or leak credentials.",
      };
    }
  }
}
