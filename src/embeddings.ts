// src/embeddings.ts
//
// Direct fetch against Ollama's OpenAI-compatible embeddings endpoint.
// We don't use the LangChain embeddings wrapper because the Ollama
// support there has lagged behind Ollama's own API at various times.
// A direct fetch is more reliable and trivial to maintain.

import { config } from "./config.js";

let cachedDimension: number | null = null;

/**
 * Embed a single string. Throws on HTTP errors or malformed responses.
 */
export async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${config.ollama.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollama.embedModel,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Embedding failed (${response.status} ${response.statusText}): ${errorBody.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };

  if (!data.data?.[0]?.embedding) {
    throw new Error(
      `Unexpected embedding response shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  return data.data[0].embedding;
}

/**
 * Embed an array of strings with bounded concurrency. Order is preserved.
 * Default concurrency=4 is a reasonable balance for Ollama on Apple
 * Silicon - higher values don't speed it up much because the bottleneck
 * is GPU-bound inference, not request handling.
 */
export async function embedBatch(
  texts: string[],
  concurrency: number = 4,
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += concurrency) {
    const batchEnd = Math.min(i + concurrency, texts.length);
    const batch = texts.slice(i, batchEnd);
    const embeddings = await Promise.all(batch.map((t) => embed(t)));
    embeddings.forEach((e, j) => (results[i + j] = e));
  }

  return results;
}

/**
 * Get the dimension of the configured embedding model by probing it once.
 * Cached after first call so subsequent calls are free.
 *
 * This matters for Qdrant collection creation - the vector size has to
 * match the embedding dimension exactly.
 */
export async function getEmbeddingDimension(): Promise<number> {
  if (cachedDimension !== null) return cachedDimension;
  const vec = await embed("dimension-probe");
  cachedDimension = vec.length;
  return cachedDimension;
}