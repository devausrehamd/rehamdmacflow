// src/agent/parse.ts
//
// Defensive JSON extraction shared across agent LLM calls. 7B models often
// wrap JSON in prose or fences, or emit trailing commentary. This tries
// direct parse, then a fenced block, then the first brace-balanced object.

export function extractJson(raw: string): unknown {
  const text = raw.trim();

  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      return JSON.parse(brace[0]);
    } catch {
      // fall through
    }
  }

  throw new Error("No parseable JSON in model output");
}