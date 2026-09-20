import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText } from "npm:unpdf@latest";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "";
const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface ChunkResult {
  id?: string | number;
  document_id?: string | number;
  filename?: string;
  page_number?: number;
  content: string;
  similarity?: number;
}

interface HistoryRow {
  role: string;
  content: string;
  seq?: number;
}

interface ReminderItem {
  id?: string;
  user_id: string;
  whatsapp_number: string;
  title: string;
  remind_at: string;
  status: string;
  reminder_type: string;
  original_text?: string;
  created_at?: string;
  sent_at?: string;
}

interface ParsedReminderResult {
  is_reminder: boolean;
  is_deadline?: boolean;
  task_title?: string;
  scheduled_reminders?: Array<{
    title: string;
    remind_at_iso: string;
    reminder_type: string;
    display_time: string;
  }>;
  confirmation_message?: string;
}

/**
 * Format conversation history into valid alternating Gemini turns
 */
function formatHistoryForGemini(
  history: HistoryRow[]
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const formatted: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  let expectedRole: "user" | "model" = "user";

  for (const item of history) {
    const role: "user" | "model" =
      item.role === "model" || item.role === "assistant" ? "model" : "user";
    const text = item.content?.trim();
    if (!text) continue;

    if (role === expectedRole) {
      formatted.push({
        role: role,
        parts: [{ text: text }]
      });
      expectedRole = role === "user" ? "model" : "user";
    } else if (formatted.length > 0) {
      // Merge consecutive same-role messages
      const last = formatted[formatted.length - 1];
      last.parts[0].text += `\n\n${text}`;
    }
  }

  // Gemini requires turns to alternate, ending with the user turn we will append.
  // Therefore, any trailing user turns in the history must be popped so history ends with 'model'.
  while (formatted.length > 0 && formatted[formatted.length - 1].role === "user") {
    formatted.pop();
  }

  return formatted;
}

/**
 * Fetch recent conversation history for a given WhatsApp number ordered by seq
 */
async function getConversationHistory(
  whatsappNumber: string,
  limitCount = 10,
  debugLog?: (s: string) => void
): Promise<HistoryRow[]> {
  try {
    const { data, error } = await supabase
      .from("conversation_history")
      .select("role, content, seq")
      .eq("whatsapp_number", whatsappNumber)
      .order("seq", { ascending: false })
      .limit(limitCount);

    if (error) {
      console.warn("⚠️ Error fetching conversation history:", error);
      debugLog?.("⚠️ Error fetching conversation history: " + JSON.stringify(error));
      return [];
    }
    const result = (data || []).reverse();
    debugLog?.(`Fetched ${result.length} previous turns for ${whatsappNumber}`);
    return result;
  } catch (err) {
    console.warn("⚠️ Exception fetching conversation history:", err);
    debugLog?.("⚠️ Exception fetching conversation history: " + String(err));
    return [];
  }
}

/**
 * Save user prompt and assistant reply into conversation_history sequentially
 */
async function saveConversationTurn(
  userId: string,
  whatsappNumber: string,
  userMessage: string,
  modelMessage: string,
  debugLog?: (s: string) => void
) {
  try {
    const uid = String(userId || whatsappNumber);
    const num = String(whatsappNumber);

    debugLog?.(`Inserting user message for ${num}...`);
    const { error: userErr } = await supabase.from("conversation_history").insert({
      user_id: uid,
      whatsapp_number: num,
      role: "user",
      content: userMessage
    });

    if (userErr) {
      debugLog?.("⚠️ Error saving user message: " + JSON.stringify(userErr));
    }

    debugLog?.(`Inserting model message for ${num}...`);
    const { error: modelErr } = await supabase.from("conversation_history").insert({
      user_id: uid,
      whatsapp_number: num,
      role: "model",
      content: modelMessage
    });

    if (modelErr) {
      debugLog?.("⚠️ Error saving model message: " + JSON.stringify(modelErr));
    } else {
      console.log(`💾 Saved conversation turn for ${whatsappNumber}`);
      debugLog?.("💾 Successfully saved conversation turn.");
    }
  } catch (err) {
    console.warn("⚠️ Exception saving conversation turn:", err);
    debugLog?.("⚠️ Exception saving conversation turn: " + String(err));
  }
}

/**
 * Clear conversation history for a user
 */
async function clearConversationHistory(
  whatsappNumber: string,
  debugLog?: (s: string) => void
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("conversation_history")
      .delete()
      .eq("whatsapp_number", whatsappNumber);

    if (error) {
      console.error("⚠️ Error clearing history:", error);
      debugLog?.("⚠️ Error clearing history: " + JSON.stringify(error));
      return false;
    }
    debugLog?.("Cleared conversation history for " + whatsappNumber);
    return true;
  } catch (err) {
    console.error("⚠️ Exception clearing history:", err);
    debugLog?.("⚠️ Exception clearing history: " + String(err));
    return false;
  }
}

/**
 * Send a WhatsApp text message via Meta Graph API
 */
async function sendWhatsAppMessage(to: string, message: string, debugLog?: (s: string) => void): Promise<boolean> {
  const url = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { body: message }
  };

  console.log(`📤 Sending message to ${to}...`);
  debugLog?.(`📤 Sending WhatsApp message to ${to}...`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const resText = await res.text();
    console.log(`📤 Send Status: ${res.status}, Response: ${resText}`);
    debugLog?.(`📤 Meta WhatsApp API Status: ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error("❌ Exception while calling WhatsApp API:", err);
    debugLog?.(`❌ Exception calling WhatsApp API: ${String(err)}`);
    return false;
  }
}

/**
 * Download media binary from WhatsApp Cloud API and convert to base64
 */
async function fetchWhatsAppMediaAsBase64(mediaId: string): Promise<{ base64: string; mimeType: string }> {
  const metaUrl = `https://graph.facebook.com/v25.0/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
  });

  if (!metaRes.ok) {
    const err = await metaRes.text();
    throw new Error(`Failed to retrieve media URL: ${metaRes.status} ${err}`);
  }

  const metaData = await metaRes.json();
  const downloadUrl = metaData.url;
  const mimeType = metaData.mime_type || "application/octet-stream";

  console.log(`📥 Downloading media (${mimeType}, size: ${metaData.file_size || "unknown"} bytes)...`);
  const fileRes = await fetch(downloadUrl, {
    headers: { "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
  });

  if (!fileRes.ok) {
    throw new Error(`Failed to download media content: ${fileRes.status}`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  let binary = "";
  const len = uint8.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = uint8.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  const base64 = btoa(binary);

  return { base64, mimeType };
}

/**
 * Multimodal Gemini call for Images and Documents (PDFs)
 */
async function generateMultimodalAnswer(
  prompt: string,
  base64Data: string,
  mimeType: string,
  contactName: string,
  isDocument: boolean = false,
  debugLog?: (s: string) => void
): Promise<string> {
  const candidateModels = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash"
  ];

  let systemInstruction = "";
  if (isDocument) {
    systemInstruction = `You are an intelligent, friendly AI Document Assistant on WhatsApp. The user's name is "${contactName}".

You are analyzing an attached document / PDF file.

GUIDELINES FOR YOUR RESPONSE:
1. If the user provided a question or caption:
   - Answer it thoroughly, accurately, and concisely based strictly on the document.
   - Use WhatsApp markdown (*bold* for emphasis, bullet points •, clear sections).
   - ALWAYS cite the specific page numbers whenever you extract or reference facts (e.g. "📄 Page 3").
2. If no specific question was asked (or general request to read/summarize):
   - Provide a clear, high-level executive summary of the document.
   - List 3 to 5 key takeaways or main sections with their respective page numbers (e.g. "• *Key Concept:* Description (📄 Page 2)").
   - Conclude warmly by letting the user know they can ask any specific questions about this document.`;
  } else {
    systemInstruction = `You are an intelligent, friendly AI Vision Assistant on WhatsApp. The user's name is "${contactName}".

You are analyzing an attached image (photo, diagram, handwritten notes, textbook page, problem sheet, etc.).

GUIDELINES FOR YOUR RESPONSE:
1. If the user provided a question or instruction:
   - Answer the question or solve the problem step-by-step.
   - For mathematical equations, coding problems, or logic questions: show clear, easy-to-follow steps.
2. If no specific question was asked:
   - Describe what is shown in the image clearly.
   - If it contains text or notes, transcribe the key information accurately.
   - Use clean WhatsApp markdown (*bold*, bullet points •).`;
  }

  const userQuery = prompt && prompt.trim()
    ? prompt
    : (isDocument
        ? "Please analyze this document in detail and provide an executive summary with key takeaways and page numbers."
        : "Please analyze this image, transcribe any text or equations, and explain the key details.");

  const fullPrompt = `${systemInstruction}\n\nUSER PROMPT / CAPTION:\n${userQuery}\n\nASSISTANT:`;

  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Data
                  }
                },
                {
                  text: fullPrompt
                }
              ]
            }
          ]
        })
      });

      if (res.ok) {
        const data = await res.json();
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (answer) {
          console.log(`✅ Multimodal response generated using model: ${model}`);
          debugLog?.(`✅ Multimodal response generated using model: ${model}`);
          return answer;
        }
      } else {
        const errText = await res.text();
        console.warn(`⚠️ Model ${model} returned ${res.status}: ${errText}`);
        debugLog?.(`⚠️ Model ${model} returned ${res.status}: ${errText}`);
        lastError = new Error(`Model ${model} error: ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Model ${model} multimodal exception:`, err);
      debugLog?.(`⚠️ Model ${model} multimodal exception: ${String(err)}`);
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return "I could not analyze this file. Please verify the format and try again!";
}

/**
 * Normalize WhatsApp audio MIME types for Gemini API
 */
function normalizeAudioMime(mime: string): string {
  if (!mime) return "audio/ogg";
  const clean = mime.split(";")[0].trim().toLowerCase();
  if (clean.includes("ogg") || clean.includes("opus")) return "audio/ogg";
  if (clean.includes("mp3") || clean.includes("mpeg")) return "audio/mp3";
  if (clean.includes("wav")) return "audio/wav";
  if (clean.includes("aac")) return "audio/aac";
  if (clean.includes("m4a") || clean.includes("mp4")) return "audio/mp4";
  return clean || "audio/ogg";
}

/**
 * Transcribe WhatsApp voice notes or audio clips using Gemini Multimodal Audio
 */
async function transcribeAudioWithGemini(
  base64Data: string,
  mimeType: string,
  contactName: string,
  debugLog?: (s: string) => void
): Promise<string> {
  const candidateModels = [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-2.5-flash"
  ];

  const normalizedMime = normalizeAudioMime(mimeType);
  const prompt = `You are an expert multilingual speech-to-text transcription engine.
Transcribe the spoken audio verbatim in whatever language the user spoke (English, Hindi, Hinglish, Spanish, etc.).
GUIDELINES:
1. Output ONLY the exact transcription of the spoken words.
2. Do not add markdown backticks, conversational introductions, or commentary.
3. If the audio is completely silent or unrecognizable static noise, output exactly: "[Unintelligible audio]"`;

  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: normalizedMime,
                    data: base64Data
                  }
                },
                { text: prompt }
              ]
            }
          ]
        })
      });

      if (res.ok) {
        const data = await res.json();
        const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (transcript) {
          console.log(`🎙️ Speech transcribed via model ${model}: "${transcript}"`);
          debugLog?.(`🎙️ Speech transcribed via model ${model}: "${transcript}"`);
          return transcript;
        }
      } else {
        const errText = await res.text();
        console.warn(`⚠️ Model ${model} audio transcription returned ${res.status}: ${errText}`);
        debugLog?.(`⚠️ Model ${model} audio status ${res.status}: ${errText}`);
        lastError = new Error(`Model ${model} audio error: ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Model ${model} audio exception:`, err);
      debugLog?.(`⚠️ Model ${model} audio exception: ${String(err)}`);
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return "[Unintelligible audio]";
}

/**
 * Generate 768-dimensional embedding using Google Gemini API
 */
async function createEmbedding(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: {
        parts: [{ text: text }]
      },
      outputDimensionality: 768
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini embed API error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.embedding?.values || [];
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Clean unnecessary whitespace from document text
 */
function cleanDocumentText(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join("\n");
}

/**
 * Split text into overlapping chunks
 */
function createTextChunks(text: string, chunkSize: number = 800, overlap: number = 150): string[] {
  if (!text || !text.trim()) return [];
  const chunks: string[] = [];
  let start = 0;
  const len = text.length;

  while (start < len) {
    const end = Math.min(start + chunkSize, len);
    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= len) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

/**
 * Extract all pages from a document (PDF).
 * Uses unpdf as the primary fast extractor; falls back to Gemini multimodal OCR if unpdf
 * extracts zero/sparse text (e.g. scanned image PDF or non-standard encoding).
 */
async function extractDocumentPages(
  uint8: Uint8Array,
  base64: string,
  mimeType: string,
  debugLog?: (s: string) => void
): Promise<Array<{ page_number: number; text: string }>> {
  const pages: Array<{ page_number: number; text: string }> = [];

  // Step A: Fast serverless extraction via unpdf
  try {
    debugLog?.("Attempting PDF text extraction via unpdf...");
    console.log("📄 Extracting text via unpdf...");
    const { totalPages, text } = await extractText(uint8, { mergePages: false });
    console.log(`📄 unpdf extracted totalPages=${totalPages}`);
    debugLog?.(`unpdf extracted totalPages=${totalPages}`);

    if (Array.isArray(text) && text.length > 0) {
      for (let i = 0; i < text.length; i++) {
        const cleaned = cleanDocumentText(text[i]);
        if (cleaned) {
          pages.push({
            page_number: i + 1,
            text: cleaned
          });
        }
      }
    } else if (typeof text === "string" && text.trim().length > 0) {
      const cleaned = cleanDocumentText(text);
      if (cleaned) {
        pages.push({ page_number: 1, text: cleaned });
      }
    }
  } catch (unpdfErr) {
    console.warn("⚠️ unpdf extraction failed:", unpdfErr);
    debugLog?.("⚠️ unpdf extraction failed: " + String(unpdfErr));
  }

  // If unpdf successfully extracted pages with text, return them!
  const totalChars = pages.reduce((acc, p) => acc + p.text.length, 0);
  if (pages.length > 0 && totalChars > 50) {
    console.log(`✅ Extracted ${pages.length} pages (${totalChars} chars) with unpdf`);
    debugLog?.(`✅ Extracted ${pages.length} pages (${totalChars} chars) with unpdf`);
    return pages;
  }

  // Step B: Fallback to Gemini Multimodal OCR (for scanned PDFs, handwritten notes, or images)
  console.log("ℹ️ Text is sparse or unpdf empty. Triggering Gemini Multimodal OCR fallback...");
  debugLog?.("Triggering Gemini Multimodal OCR fallback for document...");

  const candidateModels = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-2.5-flash"
  ];

  const ocrPrompt = `You are a document transcription and OCR engine.
Read this entire document and extract all the text page by page.
Output a strict JSON array of objects with the following format:
[
  { "page_number": 1, "text": "transcribed text of page 1..." },
  { "page_number": 2, "text": "transcribed text of page 2..." }
]
Do not omit any pages. Include all text, headers, and bullet points. Output ONLY valid JSON, without extra commentary or markdown backticks.`;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64
                  }
                },
                { text: ocrPrompt }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (jsonText) {
          const parsed = JSON.parse(jsonText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const ocrPages = parsed
              .filter((p: any) => p && p.text)
              .map((p: any, idx: number) => ({
                page_number: Number(p.page_number) || (idx + 1),
                text: cleanDocumentText(String(p.text))
              }))
              .filter((p: any) => p.text.length > 0);

            if (ocrPages.length > 0) {
              console.log(`✅ Gemini OCR extracted ${ocrPages.length} pages using model ${model}`);
              debugLog?.(`✅ Gemini OCR extracted ${ocrPages.length} pages using model ${model}`);
              return ocrPages;
            }
          }
        }
      }
    } catch (ocrErr) {
      console.warn(`Gemini OCR model ${model} error:`, ocrErr);
      debugLog?.(`Gemini OCR model ${model} error: ` + String(ocrErr));
    }
  }

  return pages;
}

/**
 * Generate 768-dimensional embeddings for multiple texts using batchEmbedContents
 * with individual createEmbedding fallback.
 */
async function batchCreateEmbeddings(texts: string[], debugLog?: (s: string) => void): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Try Gemini batchEmbedContents API
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${GEMINI_API_KEY}`;
    const requests = texts.map(t => ({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: t }] },
      outputDimensionality: 768
    }));

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.embeddings && Array.isArray(data.embeddings)) {
        return data.embeddings.map((e: any) => e.values || []);
      }
    } else {
      const errText = await res.text();
      console.warn(`⚠️ batchEmbedContents returned ${res.status}: ${errText}. Falling back to sequential embeddings.`);
      debugLog?.(`batchEmbedContents status ${res.status}, falling back.`);
    }
  } catch (batchErr) {
    console.warn("⚠️ batchEmbedContents exception:", batchErr);
    debugLog?.("batchEmbedContents exception: " + String(batchErr));
  }

  // Fallback: embed individually
  const results: number[][] = [];
  for (const text of texts) {
    const emb = await createEmbedding(text);
    results.push(emb);
  }
  return results;
}

/**
 * Generate text answer using Gemini with multi-turn conversation memory and multi-model fallback
 */
async function generateAnswer(
  question: string,
  searchResults: ChunkResult[],
  contactName: string,
  history: HistoryRow[] = [],
  debugLog?: (s: string) => void
): Promise<string> {
  let context = "";
  if (searchResults && searchResults.length > 0) {
    const contextParts = searchResults.map((result, i) => {
      const filename = result.filename || "Uploaded Document";
      const pageNumber = result.page_number || "Unknown";
      const content = result.content;
      return `--- SOURCE ${i + 1} ---\nFile: ${filename}\nPage: ${pageNumber}\nContent:\n${content}`;
    });
    context = contextParts.join("\n\n");
  }

  const systemPrompt = `You are an intelligent, friendly, and helpful AI Document Assistant on WhatsApp. The user's name is "${contactName}".

GUIDELINES FOR YOUR RESPONSES:
1. Conversational Memory & Natural Follow-Ups:
   - You have conversational memory of recent messages in this conversation. Use this context to answer follow-up questions naturally (e.g., if the user asks "explain that further", "what did I say earlier?", "summarize the second point", or refers to something mentioned previously).
2. Casual Conversation & General Chit-Chat (e.g. "hi", "hello", "how are you", "who are you", "tell me a joke", "thank you", "good morning"):
   - Talk naturally, warmly, and engagingly like a modern, intelligent conversational AI companion.
   - Do NOT mention or cite any sources, page numbers, or documents for casual conversation.
3. Real-Time Web Search & Live Facts:
   - For questions about current events, today's news, live sports scores, weather, stock or crypto prices, use the Google Search tool to provide accurate, up-to-the-minute real-time facts with clean WhatsApp formatting.
4. Questions Answered from the Document Context:
   - If DOCUMENT CONTEXT is provided (or was discussed in previous turns), provide a clear, well-structured, and accurate answer using that information.
   - Format cleanly for WhatsApp: use *bold* for emphasis, bullet points (•) for lists, and short readable paragraphs.
   - ONLY when your answer relies on information from the DOCUMENT CONTEXT, add the exact source citation at the very end in this clean format:

📚 *Source:*
• 📄 <filename> — Page <page_number>

   - ONLY cite the specific document and page number(s) that directly supported your answer. Never list unused sources.
5. General Knowledge & Conceptual Inquiries:
   - Answer helpfully and accurately using your broad intelligence and knowledge.
6. Questions About the Document when the Information is NOT in the Context:
   - If the user specifically asks about their document, but the information is missing from the provided context and conversation, politely let them know: "I checked your uploaded document, but I couldn't find details regarding that topic. Feel free to rephrase or ask another question!"
   - Do NOT invent facts and do NOT include any source citations.`;

  const formattedHistory = formatHistoryForGemini(history);
  debugLog?.(`Formatted history turns count: ${formattedHistory.length}`);

  let currentTurnPrompt = question;
  if (context && context.trim().length > 0) {
    currentTurnPrompt = `DOCUMENT CONTEXT:\n${context}\n\nUSER QUESTION:\n${question}`;
  }

  const contents = [
    ...formattedHistory,
    {
      role: "user" as const,
      parts: [{ text: currentTurnPrompt }]
    }
  ];

  const candidateModels = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash"
  ];

  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const useWebSearch = !context || context.trim().length === 0;

      const requestBody: any = {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: contents
      };

      if (useWebSearch) {
        requestBody.tools = [{ google_search: {} }];
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });

      if (res.ok) {
        const data = await res.json();
        let answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (answer) {
          // Extract Google Search grounding citations if present
          const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
          if (groundingChunks && groundingChunks.length > 0) {
            const sources: string[] = [];
            const seenUrls = new Set<string>();
            for (const chunk of groundingChunks) {
              const web = chunk.web;
              if (web && web.uri && !seenUrls.has(web.uri)) {
                seenUrls.add(web.uri);
                const title = web.title ? web.title.trim() : "Web Source";
                sources.push(`• *${title}*: ${web.uri}`);
                if (sources.length >= 3) break;
              }
            }
            if (sources.length > 0 && !answer.includes(sources[0].slice(0, 20))) {
              answer += `\n\n🌐 *Live Web Sources:*\n${sources.join("\n")}`;
            }
          }

          console.log(`✅ Generated answer using model: ${model} (searchGrounded=${useWebSearch})`);
          debugLog?.(`✅ Generated answer using model: ${model} (searchGrounded=${useWebSearch})`);
          return answer;
        }
      } else {
        // Fallback retry without tools if model returned 400
        if (useWebSearch && (res.status === 400 || res.status === 404)) {
          delete requestBody.tools;
          const retryRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          });
          if (retryRes.ok) {
            const retryData = await retryRes.json();
            const retryAnswer = retryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
            if (retryAnswer) {
              console.log(`✅ Generated answer using model: ${model} (fallback without search tool)`);
              return retryAnswer;
            }
          }
        }
        const errText = await res.text();
        console.warn(`⚠️ Model ${model} returned ${res.status}: ${errText}`);
        debugLog?.(`⚠️ Model ${model} returned ${res.status}: ${errText}`);
        lastError = new Error(`Model ${model} error: ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Model ${model} fetch exception:`, err);
      debugLog?.(`⚠️ Model ${model} fetch exception: ${String(err)}`);
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return "I'm having trouble processing that right now. Please try again in a moment!";
}

/**
 * Detect first URL in text
 */
function extractFirstUrl(text: string): string | null {
  const match = text.match(/(https?:\/\/[^\s]+)/i);
  return match ? match[0].trim() : null;
}

/**
 * Fetch and summarize an article or YouTube video, and save to bookmarks
 */
async function fetchAndSummarizeUrl(
  url: string,
  sender: string,
  contactName: string,
  userDbId?: string | null,
  debugLog?: (s: string) => void
): Promise<string> {
  console.log(`🔗 Processing URL: ${url} for ${sender}`);
  debugLog?.(`🔗 Processing URL: ${url}`);

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  let contentToSummarize = "";
  let extractedTitle = "";
  let domain = "";

  try {
    const parsedUrl = new URL(url);
    domain = parsedUrl.hostname.replace(/^www\./, "");
  } catch (_) {
    domain = "web";
  }

  if (isYouTube) {
    debugLog?.("Detected YouTube URL. Querying oEmbed metadata...");
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const oembedRes = await fetch(oembedUrl);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        extractedTitle = oembedData.title || "YouTube Video";
        contentToSummarize = `YouTube Video Title: ${extractedTitle}\nChannel/Author: ${oembedData.author_name || "Unknown"}\nURL: ${url}`;
      }
    } catch (ytErr) {
      console.warn("YouTube oEmbed fetch error:", ytErr);
    }
    if (!extractedTitle) {
      extractedTitle = "YouTube Video";
      contentToSummarize = `YouTube Video URL: ${url}`;
    }
  } else {
    debugLog?.("Fetching web article content...");
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });

      if (res.ok) {
        const html = await res.text();

        // Extract title
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
          extractedTitle = titleMatch[1].trim().replace(/\s+/g, " ");
        }

        // Clean HTML: remove script, style, comments, and tags
        const text = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim();

        contentToSummarize = text.slice(0, 6000);
      }
    } catch (fetchErr) {
      console.warn("Error fetching article:", fetchErr);
      debugLog?.("Error fetching article: " + String(fetchErr));
    }
  }

  // Use Gemini to generate a high-quality 3-bullet TL;DR summary
  const summaryPrompt = `You are an elite reading assistant and web summarizer on WhatsApp. The user's name is "${contactName}".
Analyze the following content from: ${url}

METADATA:
Title: ${extractedTitle || "Article / Video"}
Source: ${domain}
Content:
${contentToSummarize || `URL: ${url}`}

GUIDELINES:
1. Provide a crisp 1-sentence overview.
2. Provide exactly 3 to 4 impactful bullet points (•) summarizing key insights, facts, or takeaways.
3. Keep it punchy, engaging, and easy to read on WhatsApp with clean markdown (*bold*, • bullets).
4. If it's a YouTube video, summarize what the video is about and why it matters.

FORMAT:
• *Overview:* <1 sentence overview>
• *Key Takeaways:*
  • <Bullet 1>
  • <Bullet 2>
  • <Bullet 3>`;

  let summaryText = "";
  const candidateModels = [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-2.5-flash"
  ];

  for (const model of candidateModels) {
    try {
      const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const gRes = await fetch(gUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: summaryPrompt }] }],
          tools: [{ google_search: {} }]
        })
      });

      if (gRes.ok) {
        const data = await gRes.json();
        const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (textOut) {
          summaryText = textOut;
          break;
        }
      }
    } catch (err) {
      console.warn(`Summary error with model ${model}:`, err);
    }
  }

  if (!summaryText) {
    summaryText = `• *Overview:* Shared link from ${domain}.\n• *Key Takeaways:*\n  • Content saved to read-later bookmarks.`;
  }

  // Save to bookmarks table in Supabase
  try {
    await supabase.from("bookmarks").insert({
      user_id: sender,
      whatsapp_number: sender,
      url: url,
      title: extractedTitle || domain,
      summary: summaryText,
      category: isYouTube ? "youtube" : "article"
    });
    console.log(`💾 Saved bookmark for ${sender}: ${url}`);
    debugLog?.(`Saved bookmark to Supabase for ${url}`);
  } catch (bmErr) {
    console.warn("Could not save to bookmarks table:", bmErr);
    debugLog?.("Could not save to bookmarks table: " + String(bmErr));
  }

  const finalMessage = `🔗 *Link Summarized & Saved to Read-Later!*

📌 *Title:* ${extractedTitle || domain}
🌐 *Source:* ${domain}
🔗 *Link:* ${url}

${summaryText}

💾 _Saved to your read-later bookmarks! Send */bookmarks* anytime to view your saved list._`;

  return finalMessage;
}

/**
 * AI Time & Reminder Parser using Gemini Structured JSON
 */
async function parseReminderRequest(
  text: string,
  contactName: string,
  debugLog?: (s: string) => void
): Promise<ParsedReminderResult | null> {
  const lower = text.toLowerCase();
  const reminderKeywords = [
    "remind", "reminder", "deadline", "due on", "due date", "submission",
    "submit on", "don't forget", "dont forget", "alert me", "notify me"
  ];
  const hasKeyword = reminderKeywords.some(kw => lower.includes(kw));
  if (!hasKeyword) return null;

  const now = new Date();
  const localTimeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long"
  }).format(now);

  const prompt = `You are a precise Time & Reminder Extraction Engine for WhatsApp. The user's name is "${contactName}".
Current User Local Time: ${localTimeStr} (Timezone: Asia/Kolkata, UTC+05:30).

USER MESSAGE: "${text}"

Determine if the user wants to set a reminder or announce a deadline/assignment submission.
If NO, output: {"is_reminder": false}

If YES:
Preferred Times of Day (in Asia/Kolkata, UTC+05:30):
- Morning: 09:00:00 (09:00 AM)
- Afternoon: 14:00:00 (02:00 PM)
- Evening: 18:00:00 (06:00 PM)
- Night: 21:00:00 (09:00 PM)

Is this a DEADLINE / ASSIGNMENT SUBMISSION announcement?
(e.g., "on 25th september is my assignment submission deadline", "my project deadline is...", "assignment due on...")
If YES (is_deadline = true):
Assume target deadline is either the specified time or end of that day (23:59:00).
Generate up to 5 scheduled alerts in Asia/Kolkata (+05:30) that are strictly in the future:
1. 2 Days Before: Target Date - 2 days at 09:00:00 (reminder_type: "deadline_lead")
2. Deadline Day Morning: Target Date at 09:00:00 (reminder_type: "deadline_day_morning")
3. Deadline Day Afternoon: Target Date at 14:00:00 (reminder_type: "deadline_day_afternoon")
4. Final Countdown (2 hrs before deadline): Target Deadline - 2 hours (reminder_type: "deadline_day_final")
5. Deadline Reached: Exact deadline time (reminder_type: "deadline_end")

If SINGLE REMINDER (is_deadline = false):
(e.g. "remind me tomorrow morning to make ML notes", "remind me tomorrow evening to complete assignment", "remind me in 10 minutes to call mom"):
Generate 1 reminder at the requested date and preferred time in ISO format with +05:30 offset.

Output valid JSON only:
{
  "is_reminder": true,
  "is_deadline": boolean,
  "task_title": "clean concise task name",
  "scheduled_reminders": [
    {
      "title": "string describing what this specific alert is for",
      "remind_at_iso": "YYYY-MM-DDTHH:MM:SS+05:30",
      "reminder_type": "single | deadline_lead | deadline_day_morning | deadline_day_afternoon | deadline_day_final | deadline_end",
      "display_time": "human-friendly time string, e.g. Tomorrow at 9:00 AM"
    }
  ],
  "confirmation_message": "Warm, beautifully formatted WhatsApp markdown confirmation message with emojis, bullet points of all scheduled times, and encouraging words."
}`;

  const candidateModels = [
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash"
  ];

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (jsonText) {
          const parsed = JSON.parse(jsonText);
          if (parsed && parsed.is_reminder) {
            debugLog?.(`Successfully parsed reminder using ${model}: ${JSON.stringify(parsed)}`);
            return parsed;
          }
          return null;
        }
      }
    } catch (e) {
      debugLog?.(`Model ${model} reminder parser exception: ${String(e)}`);
      continue;
    }
  }

  return null;
}

/**
 * Dispatch due reminders across all users (triggered every minute via pg_cron / pg_net)
 */
async function processDueReminders(debugLog?: (s: string) => void): Promise<{ processed: number; sent: number }> {
  const nowIso = new Date().toISOString();
  debugLog?.(`🔔 Checking due reminders at ${nowIso}...`);

  const { data: due, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "pending")
    .lte("remind_at", nowIso)
    .order("remind_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("❌ Error querying due reminders:", error);
    debugLog?.("❌ Error querying due reminders: " + JSON.stringify(error));
    return { processed: 0, sent: 0 };
  }

  if (!due || due.length === 0) {
    debugLog?.("No reminders currently due.");
    return { processed: 0, sent: 0 };
  }

  debugLog?.(`Found ${due.length} due reminders to dispatch!`);
  let sentCount = 0;

  for (const item of due) {
    let alertMsg = "";
    if (item.reminder_type === "deadline_lead") {
      alertMsg = `⚠️ *UPCOMING DEADLINE IN 2 DAYS!* ⚠️\n\n📌 *Task / Deadline:* ${item.title}\n🗓️ *Status:* Due in 48 hours!\n\n💡 *Tip:* Ensure your main work is complete so you have plenty of time for final reviews! 💪`;
    } else if (item.reminder_type === "deadline_day_morning") {
      alertMsg = `🚨 *DEADLINE TODAY (Morning Alert)!* 🚨\n\n📌 *Task / Deadline:* ${item.title}\n⏰ *Status:* Due today!\n\n💡 *Action:* Double-check requirements, attachments, and make final preparations for submission.`;
    } else if (item.reminder_type === "deadline_day_afternoon") {
      alertMsg = `⏳ *MID-DAY DEADLINE REMINDER!* ⏳\n\n📌 *Task / Deadline:* ${item.title}\n⏰ *Status:* Due today!\n\nHave you completed and submitted your assignment? Avoid the last-minute portal rush! 🚀`;
    } else if (item.reminder_type === "deadline_day_final") {
      alertMsg = `🔥 *FINAL 2 HOURS COUNTDOWN!* 🔥\n\n📌 *Task / Deadline:* ${item.title}\n⏳ *Time Remaining:* ~2 Hours Left!\n\n🚀 *Action:* Submit your work immediately to prevent portal traffic or late submission penalties!`;
    } else if (item.reminder_type === "deadline_end") {
      alertMsg = `🏁 *DEADLINE TIME REACHED!* 🏁\n\n📌 *Task / Deadline:* ${item.title}\n⏰ *Status:* The submission window has now reached its deadline.\n\nMake sure your submission confirmation or receipt is safely saved! 🎓`;
    } else {
      alertMsg = `⏰ *SCHEDULED REMINDER ALERT!* ⏰\n\n📌 *Task:* ${item.title}\n\nThis is your scheduled reminder. Hope you're having a productive time! 💪`;
    }

    const ok = await sendWhatsAppMessage(item.whatsapp_number, alertMsg, debugLog);
    if (ok) {
      await supabase
        .from("reminders")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", item.id);
      sentCount++;
      debugLog?.(`✅ Dispatched reminder id=${item.id} to ${item.whatsapp_number}`);
    }
  }

  return { processed: due.length, sent: sentCount };
}

/**
 * Log all incoming messages into inbox_messages table
 */
async function logIncomingMessage(
  senderPhone: string,
  senderName: string,
  messageId: string,
  messageType: string,
  content: string,
  debugLog?: (s: string) => void
) {
  try {
    const { error } = await supabase.from("inbox_messages").insert({
      sender_phone: senderPhone,
      sender_name: senderName || "Unknown Contact",
      message_id: messageId,
      message_type: messageType,
      content: content,
      is_read_by_owner: false
    });
    if (!error) {
      console.log(`📥 Logged inbox message from ${senderName} (${senderPhone}): "${content?.slice(0, 50)}"`);
      debugLog?.(`📥 Logged inbox message from ${senderName} (${senderPhone})`);
    } else {
      console.warn("Could not log inbox message:", error);
    }
  } catch (err) {
    console.warn("Exception logging inbox message:", err);
  }
}

/**
 * Parse and resolve inquiries about messages sent by other contacts (e.g. Gagan)
 */
async function resolveInboxQuery(
  text: string,
  contactName: string,
  senderPhone?: string,
  debugLog?: (s: string) => void
): Promise<string | null> {
  const lower = text.toLowerCase();
  const keywords = [
    "what did", "what message did", "did anyone", "did someone", "check messages",
    "check inbox", "unread messages", "any messages", "who messaged", "who sent",
    "without opening", "inbox", "what has", "what was sent", "received from",
    "message from", "messages from"
  ];

  const hasKw = keywords.some(k => lower.includes(k));
  if (!hasKw) return null;

  // Extract contact name if specified
  let targetName: string | null = null;

  const regexPatterns = [
    /(?:what\s+(?:did|has)\s+)([a-zA-Z0-9_\s]+?)\s+(?:send|sent|say|said|write|text|message)/i,
    /(?:what\s+message\s+did\s+)([a-zA-Z0-9_\s]+?)\s+(?:send|sent|say|write|text)/i,
    /(?:messages?\s+from|check\s+messages?\s+from|check)\s+([a-zA-Z0-9_\s]+?)(?:\?|$|\s+without|\s+send|\s+sent|\s+messages)/i,
    /(?:did)\s+([a-zA-Z0-9_\s]+?)\s+(?:message|text|send|ping|write|say)/i
  ];

  for (const pat of regexPatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      let candidate = m[1].trim();
      candidate = candidate.replace(/\b(the|a|his|her|their|me|to)\b/gi, "").trim();
      const forbidden = ["he", "she", "they", "anyone", "someone", "you", "i", "my", "we"];
      if (candidate && !forbidden.includes(candidate.toLowerCase())) {
        targetName = candidate;
        break;
      }
    }
  }

  // Fallback to Gemini if regex did not extract a name
  if (!targetName && (lower.includes("what did") || lower.includes("who sent") || lower.includes("check messages") || lower.includes("without opening"))) {
    const candidateModels = [
      "gemini-3.5-flash-lite",
      "gemini-flash-lite-latest",
      "gemini-2.5-flash"
    ];

    const prompt = `Analyze this inquiry from a user asking about incoming messages received from other people:
"${text}"

Extract the target person's name or contact if mentioned (e.g. "Gagan", "Rahul", "Priya").
If the user is asking generally about anyone or all messages (e.g. "did anyone message me", "check my messages", "check inbox"), target_name must be null.

Output strict JSON:
{"is_inbox_query": true, "target_name": "extracted name or null"}`;

    for (const model of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });
        if (res.ok) {
          const data = await res.json();
          const jsonStr = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
          if (jsonStr) {
            const parsed = JSON.parse(jsonStr);
            if (parsed.is_inbox_query) {
              targetName = parsed.target_name || null;
              break;
            }
          }
        }
      } catch (_) {
        // continue to next model
      }
    }
  }

  console.log(`🕵️‍♂️ Checking inbox messages for target: ${targetName || "ALL"}...`);
  debugLog?.(`🕵️‍♂️ Checking inbox messages for target: ${targetName || "ALL"}`);

  let queryBuilder = supabase
    .from("inbox_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  // Filter out messages sent by the inquirer themselves so they don't see their own queries
  if (senderPhone) {
    queryBuilder = queryBuilder.neq("sender_phone", senderPhone);
  }

  if (targetName) {
    queryBuilder = queryBuilder.or(`sender_name.ilike.%${targetName}%,sender_phone.ilike.%${targetName}%`);
  }

  const { data: messages, error } = await queryBuilder;

  if (error) {
    console.warn("Error querying inbox_messages:", error);
    debugLog?.("Error querying inbox_messages: " + JSON.stringify(error));
    return null;
  }

  if (!messages || messages.length === 0) {
    if (targetName) {
      return `📭 *Inbox Check:* No messages found from *${targetName}*.\n\nThey haven't sent any messages to this WhatsApp number yet!`;
    }
    return "📭 *Your Inbox is Empty!* No incoming messages have arrived from your contacts recently.";
  }

  const header = targetName
    ? `📩 *Messages from ${messages[0].sender_name || targetName} (without opening their chat):*`
    : `📩 *Recent Messages Received (without opening chats):*`;

  const items = messages.map((m: any, idx: number) => {
    const dateStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(m.created_at));

    let typeIcon = "💬 Text";
    if (m.message_type === "audio" || m.message_type === "voice") typeIcon = "🎙️ Voice Note";
    else if (m.message_type === "image") typeIcon = "🖼️ Photo";
    else if (m.message_type === "document") typeIcon = "📄 Document";

    const senderDisplay = targetName ? "" : ` (${m.sender_name || m.sender_phone})`;
    return `${idx + 1}. *From:* ${m.sender_name || m.sender_phone}${senderDisplay}\n   ⏰ ${dateStr} • ${typeIcon}\n   📝 "${m.content || "[Media content]"}"`;
  }).join("\n\n");

  const reply = `${header}\n\n${items}\n\n💡 _These messages remain unread and unopened in WhatsApp!_`;
  return reply;
}

/**
 * Lookup or create user in Supabase
 */
async function getOrCreateUser(whatsappNumber: string, debugLog?: (s: string) => void) {
  try {
    const { data: existing, error: existErr } = await supabase
      .from("users")
      .select("*")
      .eq("whatsapp_number", whatsappNumber)
      .maybeSingle();

    if (existErr) {
      debugLog?.("User lookup error: " + JSON.stringify(existErr));
    }
    if (existing) return existing;

    const { data: newUser, error } = await supabase
      .from("users")
      .insert({ whatsapp_number: whatsappNumber })
      .select()
      .single();

    if (error) {
      console.error("Error creating user:", error);
      debugLog?.("Error creating user: " + JSON.stringify(error));
      return null;
    }
    return newUser;
  } catch (err) {
    console.error("Exception in getOrCreateUser:", err);
    debugLog?.("Exception in getOrCreateUser: " + String(err));
    return null;
  }
}

/**
 * Handle a single incoming message from WhatsApp (Text, Image, Document/PDF)
 */
async function handleSingleMessage(message: any, contacts: any[], debugLog?: (s: string) => void) {
  const sender = message.from;
  const messageType = message.type;
  const messageId = message.id;

  console.log(`📩 Processing message from ${sender} (type: ${messageType}, id: ${messageId})`);
  debugLog?.(`📩 Processing message from ${sender} (type: ${messageType}, id: ${messageId})`);

  if (!sender) return;

  // Filter out Meta tester dummy senders
  if (sender === "16315551181" || sender === "1234567890" || sender.length < 8) {
    console.log(`ℹ️ Meta test sample sender (${sender}). Skipping reply.`);
    debugLog?.("Skipped Meta dummy sender.");
    return;
  }

  let contactName = "there";
  if (contacts && contacts.length > 0) {
    contactName = contacts[0].profile?.name || "there";
  }

  // Register or lookup user in Supabase
  const user = await getOrCreateUser(sender, debugLog);
  const userDbId = user ? String(user.id) : null;
  debugLog?.(`User DB ID: ${userDbId}`);

  // 1. HANDLE IMAGE MESSAGES
  if (messageType === "image") {
    const mediaId = message.image?.id;
    const caption = message.image?.caption || "";
    console.log(`🖼️ Image received: ID=${mediaId}, Caption="${caption}"`);

    // Log incoming image into inbox_messages
    await logIncomingMessage(
      sender,
      contactName,
      messageId,
      "image",
      caption ? `[Photo]: ${caption}` : "[Photo]",
      debugLog
    );

    if (!mediaId) {
      await sendWhatsAppMessage(sender, "⚠️ Sorry, I could not read the image data. Please try sending it again.", debugLog);
      return;
    }

    try {
      await sendWhatsAppMessage(sender, "🔍 Analyzing your image, please give me a moment...", debugLog);
      const { base64, mimeType } = await fetchWhatsAppMediaAsBase64(mediaId);
      const answer = await generateMultimodalAnswer(caption, base64, mimeType, contactName, false, debugLog);
      await sendWhatsAppMessage(sender, answer, debugLog);
      console.log(`✅ Image analysis sent to ${sender}`);

      // Save turn to conversation history
      const userSummary = caption ? `[Sent an image with caption: "${caption}"]` : "[Sent an image]";
      await saveConversationTurn(userDbId || sender, sender, userSummary, answer, debugLog);
    } catch (imgErr) {
      console.error("❌ Error processing image:", imgErr);
      debugLog?.("❌ Error processing image: " + String(imgErr));
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue analyzing your image. Please try again with a clear photo.",
        debugLog
      );
    }
    return;
  }

  // 2. HANDLE DOCUMENT / PDF MESSAGES
  if (messageType === "document") {
    const mediaId = message.document?.id;
    const filename = message.document?.filename || "document.pdf";
    const docMime = message.document?.mime_type || "application/pdf";
    const caption = message.document?.caption || "";
    const directBase64 = message.document?.base64 || "";
    console.log(`📄 Document received: ${filename} (ID=${mediaId || "direct"}, MIME=${docMime}, Caption="${caption}")`);

    // Log incoming document into inbox_messages
    await logIncomingMessage(
      sender,
      contactName,
      messageId,
      "document",
      caption ? `[Document: ${filename}]: ${caption}` : `[Document]: ${filename}`,
      debugLog
    );

    if (!mediaId && !directBase64) {
      await sendWhatsAppMessage(sender, "⚠️ Sorry, I could not read the document. Please try sending it again.", debugLog);
      return;
    }

    try {
      await sendWhatsAppMessage(sender, `📄 Processing *${filename}* with AI and indexing all pages, please wait a moment...`, debugLog);
      const { base64, mimeType } = directBase64
        ? { base64: directBase64, mimeType: docMime }
        : await fetchWhatsAppMediaAsBase64(mediaId);
      const uint8 = base64ToUint8Array(base64);

      // Save document record in Supabase
      let docId: string | null = null;
      try {
        const { data: docRecord, error: docDbErr } = await supabase
          .from("documents")
          .insert({
            user_id: sender,
            filename: filename
          })
          .select("id")
          .single();

        if (!docDbErr && docRecord) {
          docId = docRecord.id;
          console.log(`📄 Created document record ID: ${docId}`);
          debugLog?.(`Created document record ID: ${docId}`);
        } else if (docDbErr) {
          console.warn("Could not retrieve document ID after insert:", docDbErr);
          debugLog?.("Could not retrieve document ID: " + JSON.stringify(docDbErr));
        }
      } catch (dbErr) {
        console.warn("Could not save document record:", dbErr);
      }

      // Extract all pages from document
      console.log(`📄 Extracting pages from ${filename}...`);
      debugLog?.(`Extracting pages from ${filename}...`);
      const pages = await extractDocumentPages(uint8, base64, mimeType, debugLog);
      console.log(`📄 Total pages extracted: ${pages.length}`);
      debugLog?.(`Total pages extracted: ${pages.length}`);

      // Prepare chunks across all pages
      const allChunks: Array<{
        page_number: number;
        chunk_index: number;
        content: string;
      }> = [];

      let globalChunkIndex = 0;
      for (const page of pages) {
        const chunks = createTextChunks(page.text, 800, 150);
        for (const chunk of chunks) {
          globalChunkIndex++;
          allChunks.push({
            page_number: page.page_number,
            chunk_index: globalChunkIndex,
            content: chunk
          });
        }
      }

      console.log(`📄 Total chunks prepared across ${pages.length} pages: ${allChunks.length}`);
      debugLog?.(`Total chunks prepared: ${allChunks.length}`);

      // Generate embeddings and store chunks into document_chunks in batches of 50
      let storedChunkCount = 0;
      const BATCH_SIZE = 50;
      for (let start = 0; start < allChunks.length; start += BATCH_SIZE) {
        const batch = allChunks.slice(start, start + BATCH_SIZE);
        const batchTexts = batch.map(b => b.content);
        console.log(`🧠 Embedding batch ${start + 1} to ${start + batch.length} of ${allChunks.length}...`);
        debugLog?.(`Embedding batch ${start + 1} to ${start + batch.length}...`);

        const embeddings = await batchCreateEmbeddings(batchTexts, debugLog);

        const rows = batch.map((item, idx) => ({
          document_id: docId,
          user_id: sender,
          chunk_index: item.chunk_index,
          content: item.content,
          page_number: item.page_number,
          embedding: embeddings[idx] && embeddings[idx].length > 0 ? embeddings[idx] : null
        }));

        const { error: chunkInsertErr } = await supabase
          .from("document_chunks")
          .insert(rows);

        if (chunkInsertErr) {
          console.error("❌ Error inserting chunks into document_chunks:", chunkInsertErr);
          debugLog?.("❌ Error inserting chunks: " + JSON.stringify(chunkInsertErr));
        } else {
          storedChunkCount += rows.length;
          console.log(`✅ Stored ${storedChunkCount}/${allChunks.length} chunks in document_chunks table!`);
          debugLog?.(`Stored ${storedChunkCount}/${allChunks.length} chunks in document_chunks.`);
        }
      }

      // Generate initial multimodal analysis / answer caption
      const initialAnalysis = await generateMultimodalAnswer(caption, base64, mimeType, contactName, true, debugLog);

      let finalReply = "";
      if (caption && caption.trim()) {
        finalReply = `✅ *Document Indexed (${pages.length} pages, ${storedChunkCount} knowledge chunks)*\n\n${initialAnalysis}`;
      } else {
        finalReply = `📄 *Document Successfully Indexed!*\n\n• *File:* ${filename}\n• *Total Pages Indexed:* ${pages.length}\n• *Knowledge Chunks Stored:* ${storedChunkCount}\n\n${initialAnalysis}\n\n💡 _All pages are now stored in memory! You can ask me any specific question about ${filename} anytime._`;
      }

      await sendWhatsAppMessage(sender, finalReply, debugLog);
      console.log(`✅ Document indexing confirmation sent to ${sender}`);

      // Save turn to conversation history
      const userSummary = caption
        ? `[Uploaded document: ${filename} with question: "${caption}"]`
        : `[Uploaded document: ${filename} (${pages.length} pages indexed)]`;
      await saveConversationTurn(userDbId || sender, sender, userSummary, finalReply, debugLog);
    } catch (docErr) {
      console.error("❌ Error processing document:", docErr);
      debugLog?.("❌ Error processing document: " + String(docErr));
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue processing your document. Please verify the file and try again.",
        debugLog
      );
    }
    return;
  }

  // 3. HANDLE AUDIO / VOICE NOTE MESSAGES
  if (messageType === "audio" || messageType === "voice") {
    const mediaId = message.audio?.id || message.voice?.id;
    const audioMime = message.audio?.mime_type || message.voice?.mime_type || "audio/ogg";
    const directBase64 = message.audio?.base64 || message.voice?.base64 || "";
    const isVoice = message.audio?.voice === true || messageType === "voice";
    console.log(`🎙️ Voice note/Audio received: ID=${mediaId || "direct"}, MIME=${audioMime}, isVoice=${isVoice}`);

    if (!mediaId && !directBase64) {
      await sendWhatsAppMessage(sender, "⚠️ Sorry, I could not read the voice note. Please try recording again.", debugLog);
      return;
    }

    try {
      await sendWhatsAppMessage(sender, "🎙️ Listening to your voice note, please give me a moment...", debugLog);
      const { base64, mimeType } = directBase64
        ? { base64: directBase64, mimeType: audioMime }
        : await fetchWhatsAppMediaAsBase64(mediaId);

      const transcript = await transcribeAudioWithGemini(base64, mimeType, contactName, debugLog);

      if (!transcript || transcript === "[Unintelligible audio]") {
        await sendWhatsAppMessage(
          sender,
          "🎙️ I listened to your voice note, but I couldn't clearly hear any speech. Could you please record again in a quiet place or type your message?",
          debugLog
        );
        return;
      }

      console.log(`🗣️ Transcribed text from ${sender}: "${transcript}"`);
      debugLog?.(`🗣️ Transcribed text from ${sender}: "${transcript}"`);

      // Log incoming voice note into inbox_messages with transcription
      await logIncomingMessage(sender, contactName, messageId, "audio", transcript, debugLog);

      // Check if user is asking what someone sent without opening their chat via voice
      const inboxBriefing = await resolveInboxQuery(transcript, contactName, sender, debugLog);
      if (inboxBriefing) {
        const voiceReply = `🎙️ *Voice Note:* _"${transcript}"_\n\n${inboxBriefing}`;
        await sendWhatsAppMessage(sender, voiceReply, debugLog);
        await saveConversationTurn(userDbId || sender, sender, `[Voice Note]: "${transcript}"`, voiceReply, debugLog);
        return;
      }

      const lower = transcript.toLowerCase().trim();

      // A. Clear conversation memory command
      if (lower === "/reset" || lower === "/clear" || lower === "clear memory" || lower === "reset memory") {
        await clearConversationHistory(sender, debugLog);
        await sendWhatsAppMessage(
          sender,
          `🎙️ *Voice Note:* _"${transcript}"_\n\n🧹 *Memory Cleared!*\n\nI have forgotten our previous conversation. What would you like to explore next?`,
          debugLog
        );
        return;
      }

      // B. View upcoming reminders command
      if (lower === "/reminders" || lower === "my reminders" || lower === "view reminders" || lower === "show reminders") {
        const { data: upcoming } = await supabase
          .from("reminders")
          .select("*")
          .eq("whatsapp_number", sender)
          .eq("status", "pending")
          .order("remind_at", { ascending: true });

        if (!upcoming || upcoming.length === 0) {
          await sendWhatsAppMessage(
            sender,
            `🎙️ *Voice Note:* _"${transcript}"_\n\n📋 You have no upcoming reminders scheduled right now.`,
            debugLog
          );
        } else {
          const listText = upcoming.map((r, i) => {
            const dateStr = new Intl.DateTimeFormat("en-US", {
              timeZone: "Asia/Kolkata",
              dateStyle: "medium",
              timeStyle: "short"
            }).format(new Date(r.remind_at));
            return `${i + 1}. 📌 *${r.title}*\n   ⏰ ${dateStr}`;
          }).join("\n\n");

          await sendWhatsAppMessage(
            sender,
            `🎙️ *Voice Note:* _"${transcript}"_\n\n📋 *Your Upcoming Scheduled Reminders:*\n\n${listText}`,
            debugLog
          );
        }
        return;
      }

      // B2. View bookmarks command via voice
      if (lower.includes("my bookmarks") || lower.includes("show bookmarks") || lower.includes("view bookmarks") || lower.includes("reading list")) {
        const { data: savedList } = await supabase
          .from("bookmarks")
          .select("*")
          .eq("whatsapp_number", sender)
          .order("created_at", { ascending: false })
          .limit(10);

        if (!savedList || savedList.length === 0) {
          await sendWhatsAppMessage(
            sender,
            `🎙️ *Voice Note:* _"${transcript}"_\n\n📚 *Your Reading List is Empty!*\nSend any article link or YouTube URL to save it to your bookmarks.`,
            debugLog
          );
        } else {
          const listText = savedList.map((b: any, i: number) => {
            const icon = b.category === "youtube" ? "▶️" : "📰";
            return `${i + 1}. ${icon} *${b.title}*\n   🌐 ${b.url}`;
          }).join("\n\n");

          await sendWhatsAppMessage(
            sender,
            `🎙️ *Voice Note:* _"${transcript}"_\n\n📚 *Your Saved Read-Later Bookmarks:*\n\n${listText}`,
            debugLog
          );
        }
        return;
      }

      // C. Reminder or Deadline scheduling intent
      try {
        const reminderResult = await parseReminderRequest(transcript, contactName, debugLog);
        if (
          reminderResult &&
          reminderResult.is_reminder &&
          reminderResult.scheduled_reminders &&
          reminderResult.scheduled_reminders.length > 0
        ) {
          console.log(`⏰ Scheduling ${reminderResult.scheduled_reminders.length} reminder(s) from voice note...`);
          for (const item of reminderResult.scheduled_reminders) {
            await supabase.from("reminders").insert({
              user_id: sender,
              whatsapp_number: sender,
              title: item.title || reminderResult.task_title || "Voice Reminder",
              remind_at: new Date(item.remind_at_iso).toISOString(),
              reminder_type: item.reminder_type || "single",
              original_text: transcript,
              status: "pending"
            });
          }

          const confirmMsg = reminderResult.confirmation_message || "✅ *Reminder Set Successfully!*";
          const fullReply = `🎙️ *Voice Note:* _"${transcript}"_\n\n${confirmMsg}`;
          await sendWhatsAppMessage(sender, fullReply, debugLog);
          await saveConversationTurn(userDbId || sender, sender, `[Voice Note]: "${transcript}"`, fullReply, debugLog);
          return;
        }
      } catch (parseErr) {
        console.warn("⚠️ Exception parsing reminder intent from voice:", parseErr);
      }

      // D. Document RAG & Intelligent Conversation
      const history = await getConversationHistory(sender, 10, debugLog);
      let chunks: ChunkResult[] = [];
      try {
        const embedding = await createEmbedding(transcript);
        if (embedding && embedding.length > 0) {
          const { data: senderChunks } = await supabase.rpc("match_document_chunks", {
            query_embedding: embedding,
            match_user_id: sender,
            match_count: 5
          });
          if (senderChunks && senderChunks.length > 0) chunks = senderChunks;

          if (chunks.length === 0 && userDbId && userDbId !== sender) {
            const { data: dbChunks } = await supabase.rpc("match_document_chunks", {
              query_embedding: embedding,
              match_user_id: userDbId,
              match_count: 5
            });
            if (dbChunks && dbChunks.length > 0) chunks = dbChunks;
          }

          if (chunks.length > 0) {
            const docIds = [...new Set(chunks.map(c => c.document_id).filter(Boolean))];
            if (docIds.length > 0) {
              const { data: docs } = await supabase.from("documents").select("id, filename").in("id", docIds);
              if (docs && docs.length > 0) {
                const docMap = new Map(docs.map((d: any) => [d.id, d.filename]));
                for (const c of chunks) {
                  if (c.document_id && docMap.has(c.document_id)) {
                    c.filename = docMap.get(c.document_id);
                  }
                }
              }
            }
          }
        }
      } catch (embedErr) {
        console.warn("⚠️ Vector search failed for voice note:", embedErr);
      }

      const generatedAnswer = await generateAnswer(transcript, chunks, contactName, history, debugLog);
      const voiceReply = `🎙️ *Voice Note:* _"${transcript}"_\n\n${generatedAnswer}`;
      await sendWhatsAppMessage(sender, voiceReply, debugLog);
      await saveConversationTurn(userDbId || sender, sender, `[Voice Note]: "${transcript}"`, voiceReply, debugLog);
      return;
    } catch (audioErr) {
      console.error("❌ Error processing audio:", audioErr);
      debugLog?.("❌ Error processing audio: " + String(audioErr));
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue processing your voice note. Please try recording again.",
        debugLog
      );
      return;
    }
  }

  // 4. HANDLE TEXT MESSAGES
  if (messageType === "text") {
    const text = message.text?.body?.trim() || "";
    console.log(`💬 User message from ${sender}: "${text}"`);
    debugLog?.(`💬 User message from ${sender}: "${text}"`);

    if (!text) return;

    // 1. Log incoming message into inbox_messages table
    await logIncomingMessage(sender, contactName, messageId, "text", text, debugLog);

    // 2. Check if user is asking what someone sent without opening their chat
    const inboxBriefing = await resolveInboxQuery(text, contactName, sender, debugLog);
    if (inboxBriefing) {
      await sendWhatsAppMessage(sender, inboxBriefing, debugLog);
      await saveConversationTurn(userDbId || sender, sender, text, inboxBriefing, debugLog);
      return;
    }

    const lower = text.toLowerCase();

    // A. Reset / clear conversation memory command
    if (lower === "/reset" || lower === "/clear" || lower === "clear memory" || lower === "reset memory") {
      console.log(`🧹 Clearing conversation history for ${sender}...`);
      await clearConversationHistory(sender, debugLog);
      await sendWhatsAppMessage(
        sender,
        "🧹 *Memory Cleared!*\n\nI have forgotten our previous conversation. What would you like to explore next?",
        debugLog
      );
      return;
    }

    // B. View active scheduled reminders command
    if (lower === "/reminders" || lower === "my reminders" || lower === "view reminders" || lower === "show reminders") {
      console.log(`📋 Fetching upcoming reminders for ${sender}...`);
      const { data: upcoming, error: remErr } = await supabase
        .from("reminders")
        .select("*")
        .eq("whatsapp_number", sender)
        .eq("status", "pending")
        .order("remind_at", { ascending: true });

      if (remErr || !upcoming || upcoming.length === 0) {
        await sendWhatsAppMessage(
          sender,
          "📋 You have no upcoming reminders scheduled right now.\n\nTo set one, simply tell me:\n• *\"Remind me tomorrow morning to make notes\"*\n• *\"On 25th September is my assignment submission deadline\"*",
          debugLog
        );
      } else {
        const listText = upcoming.map((r, i) => {
          const dateStr = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            dateStyle: "medium",
            timeStyle: "short"
          }).format(new Date(r.remind_at));
          return `${i + 1}. 📌 *${r.title}*\n   ⏰ ${dateStr}`;
        }).join("\n\n");

        await sendWhatsAppMessage(
          sender,
          `📋 *Your Upcoming Scheduled Reminders:*\n\n${listText}\n\n💡 _Send /clearreminders to cancel upcoming reminders._`,
          debugLog
        );
      }
      return;
    }

    // C. Cancel / clear upcoming reminders command
    if (lower === "/clearreminders" || lower === "clear reminders" || lower === "cancel reminders") {
      console.log(`🧹 Cancelling all pending reminders for ${sender}...`);
      await supabase
        .from("reminders")
        .update({ status: "cancelled" })
        .eq("whatsapp_number", sender)
        .eq("status", "pending");

      await sendWhatsAppMessage(
        sender,
        "🧹 *All pending reminders cancelled!* Your scheduled alerts have been cleared.",
        debugLog
      );
      return;
    }

    // D. View saved bookmarks command
    if (lower === "/bookmarks" || lower === "my bookmarks" || lower === "view bookmarks" || lower === "show bookmarks" || lower === "reading list") {
      console.log(`📚 Fetching saved bookmarks for ${sender}...`);
      const { data: savedList, error: bmErr } = await supabase
        .from("bookmarks")
        .select("*")
        .eq("whatsapp_number", sender)
        .order("created_at", { ascending: false })
        .limit(10);

      if (bmErr || !savedList || savedList.length === 0) {
        await sendWhatsAppMessage(
          sender,
          "📚 *Your Reading List is Empty!*\n\nWhenever you find an interesting article, blog, or YouTube video, simply send the link here! I'll summarize it and save it to your bookmarks.",
          debugLog
        );
      } else {
        const listText = savedList.map((b: any, i: number) => {
          const dateStr = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            dateStyle: "medium"
          }).format(new Date(b.created_at));
          const icon = b.category === "youtube" ? "▶️" : "📰";
          return `${i + 1}. ${icon} *${b.title}*\n   🌐 ${b.url}\n   📅 Saved: ${dateStr}`;
        }).join("\n\n");

        await sendWhatsAppMessage(
          sender,
          `📚 *Your Saved Read-Later Bookmarks:*\n\n${listText}\n\n💡 _Send /clearbookmarks to clear your saved reading list._`,
          debugLog
        );
      }
      return;
    }

    // E. Clear saved bookmarks command
    if (lower === "/clearbookmarks" || lower === "clear bookmarks") {
      console.log(`🧹 Clearing saved bookmarks for ${sender}...`);
      await supabase
        .from("bookmarks")
        .delete()
        .eq("whatsapp_number", sender);

      await sendWhatsAppMessage(
        sender,
        "🧹 *All saved bookmarks cleared!* Your read-later list has been reset.",
        debugLog
      );
      return;
    }

    // F. Check for Web Link / YouTube URL to summarize and bookmark
    const detectedUrl = extractFirstUrl(text);
    if (detectedUrl) {
      console.log(`🔗 Found URL in message from ${sender}: ${detectedUrl}`);
      try {
        await sendWhatsAppMessage(sender, "🔍 Analyzing link and generating 3-bullet summary, please wait a moment...", debugLog);
        const summaryMsg = await fetchAndSummarizeUrl(detectedUrl, sender, contactName, userDbId, debugLog);
        await sendWhatsAppMessage(sender, summaryMsg, debugLog);
        await saveConversationTurn(userDbId || sender, sender, text, summaryMsg, debugLog);
        return;
      } catch (linkErr) {
        console.warn("⚠️ Exception in URL summarizer:", linkErr);
        debugLog?.("⚠️ Exception in URL summarizer: " + String(linkErr));
      }
    }

    // D. Check for Reminder or Deadline scheduling request
    try {
      const reminderResult = await parseReminderRequest(text, contactName, debugLog);
      if (
        reminderResult &&
        reminderResult.is_reminder &&
        reminderResult.scheduled_reminders &&
        reminderResult.scheduled_reminders.length > 0
      ) {
        console.log(`⏰ Scheduling ${reminderResult.scheduled_reminders.length} reminder(s) for ${sender}...`);
        for (const item of reminderResult.scheduled_reminders) {
          await supabase.from("reminders").insert({
            user_id: userDbId || sender,
            whatsapp_number: sender,
            title: item.title || reminderResult.task_title || "Reminder",
            remind_at: new Date(item.remind_at_iso).toISOString(),
            reminder_type: item.reminder_type || "single",
            original_text: text,
            status: "pending"
          });
        }

        const confirmMsg = reminderResult.confirmation_message || "✅ *Reminder Set Successfully!*";
        await sendWhatsAppMessage(sender, confirmMsg, debugLog);
        await saveConversationTurn(userDbId || sender, sender, text, confirmMsg, debugLog);
        return;
      }
    } catch (parseErr) {
      console.warn("⚠️ Exception parsing reminder intent:", parseErr);
      debugLog?.("⚠️ Exception in parseReminderRequest: " + String(parseErr));
    }

    // E. Regular Conversation & Document RAG Generation
    try {
      // 1. Fetch recent conversation history
      const history = await getConversationHistory(sender, 10, debugLog);
      console.log(`🧠 Loaded ${history.length} previous conversation messages for ${sender}`);

      // 2. Perform vector search for relevant document chunks
      let chunks: ChunkResult[] = [];
      try {
        console.log(`🔍 Generating embedding for: "${text}"...`);
        const embedding = await createEmbedding(text);

        if (embedding && embedding.length > 0) {
          console.log("🔍 Searching document chunks in Supabase pgvector...");

          // 1. Search by sender phone number
          const { data: senderChunks, error: sErr } = await supabase.rpc("match_document_chunks", {
            query_embedding: embedding,
            match_user_id: sender,
            match_count: 5
          });
          if (!sErr && senderChunks && senderChunks.length > 0) chunks = senderChunks;

          // 2. Fallback to user DB ID if no chunks found by sender
          if (chunks.length === 0 && userDbId && userDbId !== sender) {
            const { data: dbChunks, error: dbErr } = await supabase.rpc("match_document_chunks", {
              query_embedding: embedding,
              match_user_id: userDbId,
              match_count: 5
            });
            if (!dbErr && dbChunks && dbChunks.length > 0) chunks = dbChunks;
          }
          // Resolve filenames for chunks so citations display the exact file name
          if (chunks.length > 0) {
            const docIds = [...new Set(chunks.map(c => c.document_id).filter(Boolean))];
            if (docIds.length > 0) {
              const { data: docs } = await supabase
                .from("documents")
                .select("id, filename")
                .in("id", docIds);
              if (docs && docs.length > 0) {
                const docMap = new Map(docs.map((d: any) => [d.id, d.filename]));
                for (const c of chunks) {
                  if (c.document_id && docMap.has(c.document_id)) {
                    c.filename = docMap.get(c.document_id);
                  }
                }
              }
            }
          }
        }
      } catch (embedErr) {
        console.warn("⚠️ Warning: vector search failed, falling back to general answer:", embedErr);
        debugLog?.("⚠️ Vector search failed: " + String(embedErr));
      }

      console.log(`Retrieved ${chunks.length} chunks. Generating smart answer with Gemini...`);
      const answer = await generateAnswer(text, chunks, contactName, history, debugLog);

      console.log(`Answer generated. Delivering to WhatsApp chat ${sender}...`);
      await sendWhatsAppMessage(sender, answer, debugLog);
      console.log(`✅ Message successfully delivered to ${sender}!`);

      // 3. Save turn to conversation history
      await saveConversationTurn(userDbId || sender, sender, text, answer, debugLog);
    } catch (err) {
      console.error("❌ Error processing message:", err);
      debugLog?.("❌ Error processing message: " + String(err));
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue processing your message. Please try again in a few moments.",
        debugLog
      );
    }
    return;
  }

  // 5. UNSUPPORTED TYPES
  await sendWhatsAppMessage(
    sender,
    "👋 Hello! I support text questions, voice notes 🎙️, live Google search 🌐, web/YouTube summarizer 🔗, inbox message secretary 📩, reminders & deadlines ⏰, images 🖼️, and PDF documents 📄. How can I help you today?",
    debugLog
  );
}

/**
 * Main HTTP Server Entrypoint
 */
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 0. Automated Cron Trigger for Reminders (called every minute by pg_cron / pg_net)
  if (url.searchParams.get("action") === "process-reminders") {
    const logs: string[] = [];
    const debugLog = (msg: string) => {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
      console.log(msg);
    };

    console.log("⏰ CRON TRIGGER: processDueReminders invoked");
    const result = await processDueReminders(debugLog);
    return Response.json({ status: "processed", ...result, logs });
  }

  // 1. GET: Webhook verification for Meta WhatsApp Cloud API
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    console.log(`🔔 Webhook Verification: mode=${mode}, token_matches=${token === WHATSAPP_VERIFY_TOKEN}`);

    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
      console.log("✅ Webhook verified successfully by Meta!");
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    return new Response("Forbidden", { status: 403 });
  }

  // 2. POST: Handle incoming WhatsApp webhook events OR cron body triggers
  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch (err) {
      console.error("Invalid JSON:", err);
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Check if body was a cron trigger from pg_net
    if (body && body.trigger === "cron") {
      const logs: string[] = [];
      const debugLog = (msg: string) => {
        logs.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };
      const result = await processDueReminders(debugLog);
      return Response.json({ status: "processed", ...result, logs });
    }

    console.log("🔥 WEBHOOK RECEIVED:\n" + JSON.stringify(body, null, 2));
    const logs: string[] = [];
    const debugLog = (msg: string) => {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
    };

    const processEvents = async () => {
      try {
        const entries = body.entry || [];
        for (const entry of entries) {
          const changes = entry.changes || [];
          for (const change of changes) {
            const val = change.value || {};

            // Status updates (sent, delivered, read) - do NOT reply
            if (val.statuses && val.statuses.length > 0) {
              for (const s of val.statuses) {
                console.log(`ℹ️ Status update: ${s.status} (recipient: ${s.recipient_id}, id: ${s.id})`);
              }
              continue;
            }

            // Incoming messages
            if (val.messages && val.messages.length > 0) {
              const contacts = val.contacts || [];
              for (const msg of val.messages) {
                await handleSingleMessage(msg, contacts, debugLog);
              }
            }
          }
        }
      } catch (err) {
        console.error("❌ Error in processEvents:", err);
        debugLog("❌ Top-level error: " + String(err));
      }
    };

    await processEvents();

    return Response.json({ status: "received", logs });
  }

  return new Response("Method not allowed", { status: 405 });
});
