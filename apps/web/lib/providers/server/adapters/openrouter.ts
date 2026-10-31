import "server-only";
import { createOpenAICompatibleAdapter } from "@/lib/providers/server/adapters/openai-compatible";
import { applyLocalReasoningLevel } from "@/lib/providers/server/adapters/local-reasoning";
import {
  listOpenAIModels,
  listOpenRouterImageModels,
} from "@/lib/providers/server/http";

// OpenRouter does not report per-model effort levels or defaults, so thinking
// levels come from an administrator's override, as with other chat endpoints.
export const openRouterAdapter = createOpenAICompatibleAdapter("openrouter", {
  acceptsReasoningLevel: true,
  // Dedicated image models are absent from the chat listing.
  listModels: (connection, options) =>
    options?.modelType === "image"
      ? listOpenRouterImageModels(connection.baseUrl, connection.apiKey)
      : listOpenAIModels(connection.baseUrl, connection.apiKey),
  transformRequestBody: (body, config) =>
    applyLocalReasoningLevel(
      body,
      config.reasoningLevel,
      config.reasoningRequest,
    ),
});
