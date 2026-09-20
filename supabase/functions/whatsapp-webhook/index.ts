import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
3. Questions Answered from the Document Context:
   - If DOCUMENT CONTEXT is provided (or was discussed in previous turns), provide a clear, well-structured, and accurate answer using that information.
   - Format cleanly for WhatsApp: use *bold* for emphasis, bullet points (•) for lists, and short readable paragraphs.
   - ONLY when your answer relies on information from the DOCUMENT CONTEXT, add the exact source citation at the very end in this clean format:

📚 *Source:*
• 📄 <filename> — Page <page_number>

   - ONLY cite the specific document and page number(s) that directly supported your answer. Never list unused sources.
4. General Knowledge Questions (e.g. "What is photosynthesis?", "Write a python function to reverse a string", "Translate this to Spanish"):
   - Answer helpfully and accurately using your general knowledge.
   - Do NOT include any source citations.
5. Questions About the Document when the Information is NOT in the Context:
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
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: contents
        })
      });

      if (res.ok) {
        const data = await res.json();
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (answer) {
          console.log(`✅ Generated answer using model: ${model}`);
          debugLog?.(`✅ Generated answer using model: ${model}`);
          return answer;
        }
      } else {
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
    console.log(`📄 Document received: ${filename} (ID=${mediaId}, MIME=${docMime}, Caption="${caption}")`);

    if (!mediaId) {
      await sendWhatsAppMessage(sender, "⚠️ Sorry, I could not read the document. Please try sending it again.", debugLog);
      return;
    }

    try {
      await sendWhatsAppMessage(sender, `📄 Processing *${filename}* with AI, please wait a moment...`, debugLog);
      const { base64, mimeType } = await fetchWhatsAppMediaAsBase64(mediaId);

      // Save document record in Supabase
      try {
        await supabase.from("documents").insert({
          user_id: userDbId || sender,
          filename: filename
        });
      } catch (dbErr) {
        console.warn("Could not save document record:", dbErr);
      }

      const answer = await generateMultimodalAnswer(caption, base64, mimeType, contactName, true, debugLog);
      await sendWhatsAppMessage(sender, answer, debugLog);
      console.log(`✅ Document analysis sent to ${sender}`);

      // Save turn to conversation history
      const userSummary = caption
        ? `[Uploaded document: ${filename} with question: "${caption}"]`
        : `[Uploaded document: ${filename}]`;
      await saveConversationTurn(userDbId || sender, sender, userSummary, answer, debugLog);
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

  // 3. HANDLE TEXT MESSAGES
  if (messageType === "text") {
    const text = message.text?.body?.trim() || "";
    console.log(`💬 User message from ${sender}: "${text}"`);
    debugLog?.(`💬 User message from ${sender}: "${text}"`);

    if (!text) return;

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

          // Search by user DB ID
          if (userDbId) {
            const { data, error } = await supabase.rpc("match_document_chunks", {
              query_embedding: embedding,
              match_user_id: userDbId,
              match_count: 5
            });
            if (!error && data && data.length > 0) chunks = data;
          }

          // Search by sender phone number
          if (chunks.length === 0) {
            const { data, error } = await supabase.rpc("match_document_chunks", {
              query_embedding: embedding,
              match_user_id: sender,
              match_count: 5
            });
            if (!error && data && data.length > 0) chunks = data;
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

  // 4. UNSUPPORTED TYPES
  await sendWhatsAppMessage(
    sender,
    "👋 Hello! I currently support text questions, reminders & deadlines, images (photos, diagrams, notes), and PDF documents. Send me a file or ask any question!",
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
