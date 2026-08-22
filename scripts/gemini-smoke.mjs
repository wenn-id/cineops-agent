// Verifies the Gemini wiring with one real API call.
// Usage: GEMINI_API_KEY=... npm run check:gemini
import { callGemini, geminiAvailable, DEFAULT_MODEL } from '../server/gemini.mjs';

if (!geminiAvailable()) {
  console.error('GEMINI_API_KEY is not set — nothing to check.');
  process.exit(1);
}

const response = await callGemini({
  contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
  generationConfig: { maxOutputTokens: 10, temperature: 0 },
});

const text = response?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
if (/^ok\.?$/i.test(text)) {
  console.log(`Gemini (${DEFAULT_MODEL}) replied: ${JSON.stringify(text)}`);
  console.log('Wiring OK — the agent service will run the Gemini engine.');
} else {
  console.error(`Expected exactly "ok" but Gemini replied: ${JSON.stringify(text) || '(empty)'}`);
  console.error('Full response:', JSON.stringify(response).slice(0, 300));
  process.exit(1);
}
