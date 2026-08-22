// Minimal REST adapter for the Gemini API — deliberately dependency-free.
// Swap this file for the official SDK without touching the agent loop.

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 30_000;

export function geminiAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// request: { model?, systemInstruction, contents, tools?, generationConfig? }
// Returns the parsed generateContent response. Throws on HTTP errors.
export async function callGemini(request, { apiKey = process.env.GEMINI_API_KEY, signal } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const response = await fetch(`${API_BASE}/${request.model ?? DEFAULT_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.systemInstruction }] },
      contents: request.contents,
      ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools }] } : {}),
      generationConfig: request.generationConfig,
    }),
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json();
}
