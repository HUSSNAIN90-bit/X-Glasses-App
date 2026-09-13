import axios from "axios";

export type AssistantStatus =
  | "idle"
  | "listening"
  | "capturing"
  | "processing"
  | "speaking"
  | "error";

const REPLY_FIELDS = [
  "reply",
  "answer",
  "message",
  "text",
  "response",
  "content",
  "final_answer",
  "finalAnswer",
] as const;

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  for (const key of REPLY_FIELDS) {
    const candidate = (value as Record<string, unknown>)[key];
    const extracted = extractText(candidate);
    if (extracted) return extracted;
  }

  return "";
}

function stripThinkBlocks(text: string): string {
  const withoutClosedBlocks = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, " ");
  return withoutClosedBlocks.replace(/<think\b[^>]*>[\s\S]*$/gi, " ");
}

function stripJsonWrapper(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const extracted = extractText(parsed);
      if (extracted) return extracted;
    } catch {}
  }

  return trimmed;
}

export function cleanAssistantText(value: unknown): string {
  let text = extractText(value);

  if (!text && typeof value === "string") {
    text = value;
  }

  text = stripThinkBlocks(text);
  text = text.replace(/```[\w-]*\n?/g, " ").replace(/```/g, " ");
  text = stripJsonWrapper(text);
  text = text.replace(/^\s*(?:final answer|answer|response|assistant)\s*:\s*/i, "");
  text = text.replace(/^\s*(?:analysis|reasoning|thinking|think)\s*:\s*/i, "");
  text = text.replace(/\s+/g, " ").trim();

  if (!text) return "";

  const jsonLikeMatch = text.match(
    /"(?:reply|answer|message|text|response|content|final_answer|finalAnswer)"\s*:\s*"([^"]+)"/i,
  );

  if (jsonLikeMatch?.[1]) {
    return jsonLikeMatch[1].replace(/\s+/g, " ").trim();
  }

  return text;
}

function extractBackendErrorText(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";

  const record = data as Record<string, unknown>;

  for (const key of ["detail", "error", "message", "reply"]) {
    const value = record[key];
    const text = typeof value === "string" ? value : extractText(value);
    if (text) return text;
  }

  return extractText(data);
}

export function toUserFacingAssistantError(
  error: unknown,
  fallback = "Sorry, I couldn't analyze that image.",
): string {
  if (axios.isAxiosError(error)) {
    if (error.code === "ERR_CANCELED") return "";

    if (!error.response) {
      return "Unable to connect to the assistant.";
    }

    const backendText = cleanAssistantText(extractBackendErrorText(error.response.data));
    const lowerText = backendText.toLowerCase();

    if (
      /no usable frame|no valid frame|no good frame|unable to find.*frame|frame.*not usable/.test(
        lowerText,
      )
    ) {
      return "Please hold the camera steady and try again.";
    }

    if (
      /openai|gpt|astra|llm|model|vision model|analysis failed|couldn't analyze|could not analyze/.test(
        lowerText,
      )
    ) {
      return "Sorry, I couldn't analyze that image.";
    }

    if (
      /connect|network|timed out|timeout|unreachable|econnrefused|failed to fetch/.test(
        lowerText,
      )
    ) {
      return "Unable to connect to the assistant.";
    }

    return backendText || fallback;
  }

  const message = cleanAssistantText(error instanceof Error ? error.message : "");
  const lowerMessage = message.toLowerCase();

  if (
    /camera is not ready|camera did not return a frame|capture failed|no usable frame/.test(
      lowerMessage,
    )
  ) {
    return "Please hold the camera steady and try again.";
  }

  return message || fallback;
}
