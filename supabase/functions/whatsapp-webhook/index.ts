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

/**
 * Send a WhatsApp text message via Meta Graph API
 */
async function sendWhatsAppMessage(to: string, message: string): Promise<boolean> {
  const url = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { body: message }
  };

  console.log(`📤 Sending message to ${to}...`);

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
    return res.ok;
  } catch (err) {
    console.error("❌ Exception while calling WhatsApp API:", err);
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
  isDocument: boolean = false
): Promise<string> {
  const candidateModels = [
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
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
          return answer;
        }
      } else {
        const errText = await res.text();
        console.warn(`⚠️ Model ${model} returned ${res.status}: ${errText}`);
        lastError = new Error(`Model ${model} error: ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Model ${model} multimodal exception:`, err);
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
 * Generate text answer using Gemini with multi-model fallback
 */
async function generateAnswer(
  question: string,
  searchResults: ChunkResult[],
  contactName: string
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

You have access to DOCUMENT CONTEXT from the user's uploaded files (provided below if relevant chunks were retrieved).

GUIDELINES FOR YOUR RESPONSES:
1. Casual Conversation & General Chit-Chat (e.g. "hi", "hello", "how are you", "who are you", "tell me a joke", "thank you", "good morning"):
   - Talk naturally, warmly, and engagingly like a modern, intelligent conversational AI companion.
   - Do NOT mention or cite any sources, page numbers, or documents for casual conversation.

2. Questions Answered from the Document:
   - Provide a clear, well-structured, and accurate answer using the provided DOCUMENT CONTEXT.
   - Format cleanly for WhatsApp: use *bold* for emphasis, bullet points (•) for lists, and short readable paragraphs.
   - ONLY when your answer relies on information from the DOCUMENT CONTEXT, add the exact source citation at the very end in this clean format:

📚 *Source:*
• 📄 <filename> — Page <page_number>

   - ONLY cite the specific document and page number(s) that directly supported your answer. Never list unused sources.

3. General Knowledge Questions (e.g. "What is photosynthesis?", "Write a python function to reverse a string", "Translate this to Spanish"):
   - Answer helpfully and accurately using your general knowledge.
   - Do NOT include any source citations.

4. Questions About the Document when the Information is NOT in the Context:
   - If the user specifically asks about their document, but the information is missing from the provided context, politely let them know: "I checked your uploaded document, but I couldn't find details regarding that topic. Feel free to rephrase or ask another question!"
   - Do NOT invent facts and do NOT include any source citations.`;

  const fullPrompt = `${systemPrompt}\n\nDOCUMENT CONTEXT:\n${context ? context : "No matching document context found."}\n\nUSER MESSAGE:\n${question}\n\nASSISTANT:`;

  const candidateModels = [
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
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
          contents: [
            {
              parts: [{ text: fullPrompt }]
            }
          ]
        })
      });

      if (res.ok) {
        const data = await res.json();
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        if (answer) {
          console.log(`✅ Generated answer using model: ${model}`);
          return answer;
        }
      } else {
        const errText = await res.text();
        console.warn(`⚠️ Model ${model} returned ${res.status}: ${errText}`);
        lastError = new Error(`Model ${model} error: ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Model ${model} fetch exception:`, err);
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return "I'm having trouble processing that right now. Please try again in a moment!";
}

/**
 * Lookup or create user in Supabase
 */
async function getOrCreateUser(whatsappNumber: string) {
  try {
    const { data: existing } = await supabase
      .table("users")
      .select("*")
      .eq("whatsapp_number", whatsappNumber)
      .maybeSingle();

    if (existing) return existing;

    const { data: newUser, error } = await supabase
      .table("users")
      .insert({ whatsapp_number: whatsappNumber })
      .select()
      .single();

    if (error) {
      console.error("Error creating user:", error);
      return null;
    }
    return newUser;
  } catch (err) {
    console.error("Exception in getOrCreateUser:", err);
    return null;
  }
}

/**
 * Handle a single incoming message from WhatsApp (Text, Image, Document/PDF)
 */
async function handleSingleMessage(message: any, contacts: any[]) {
  const sender = message.from;
  const messageType = message.type;
  const messageId = message.id;

  console.log(`📩 Processing message from ${sender} (type: ${messageType}, id: ${messageId})`);

  if (!sender) return;

  // Filter out Meta tester dummy senders
  if (sender === "16315551181" || sender === "1234567890" || sender.length < 8) {
    console.log(`ℹ️ Meta test sample sender (${sender}). Skipping reply.`);
    return;
  }

  let contactName = "there";
  if (contacts && contacts.length > 0) {
    contactName = contacts[0].profile?.name || "there";
  }

  // Register or lookup user in Supabase
  const user = await getOrCreateUser(sender);
  const userDbId = user ? String(user.id) : null;

  // 1. HANDLE IMAGE MESSAGES
  if (messageType === "image") {
    const mediaId = message.image?.id;
    const caption = message.image?.caption || "";
    console.log(`🖼️ Image received: ID=${mediaId}, Caption="${caption}"`);

    if (!mediaId) {
      await sendWhatsAppMessage(sender, "⚠️ Sorry, I could not read the image data. Please try sending it again.");
      return;
    }

    try {
      await sendWhatsAppMessage(sender, "🔍 Analyzing your image, please give me a moment...");
      const { base64, mimeType } = await fetchWhatsAppMediaAsBase64(mediaId);
      const answer = await generateMultimodalAnswer(caption, base64, mimeType, contactName, false);
      await sendWhatsAppMessage(sender, answer);
      console.log(`✅ Image analysis sent to ${sender}`);
    } catch (imgErr) {
      console.error("❌ Error processing image:", imgErr);
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue analyzing your image. Please try again with a clear photo."
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
      await sendWhatsAppMessage(sender, "⚠️ Sorry, I could not read the document. Please try sending it again.");
      return;
    }

    try {
      await sendWhatsAppMessage(sender, `📄 Processing *${filename}* with AI, please wait a moment...`);
      const { base64, mimeType } = await fetchWhatsAppMediaAsBase64(mediaId);

      // Save document record in Supabase
      try {
        await supabase.table("documents").insert({
          user_id: userDbId || sender,
          filename: filename
        });
      } catch (dbErr) {
        console.warn("Could not save document record:", dbErr);
      }

      const answer = await generateMultimodalAnswer(caption, base64, mimeType, contactName, true);
      await sendWhatsAppMessage(sender, answer);
      console.log(`✅ Document analysis sent to ${sender}`);
    } catch (docErr) {
      console.error("❌ Error processing document:", docErr);
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue processing your document. Please verify the file and try again."
      );
    }
    return;
  }

  // 3. HANDLE TEXT MESSAGES
  if (messageType === "text") {
    const text = message.text?.body?.trim() || "";
    console.log(`💬 User message from ${sender}: "${text}"`);

    if (!text) return;

    try {
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
      }

      console.log(`Retrieved ${chunks.length} chunks. Generating smart answer with Gemini...`);
      const answer = await generateAnswer(text, chunks, contactName);

      console.log(`Answer generated. Delivering to WhatsApp chat ${sender}...`);
      await sendWhatsAppMessage(sender, answer);
      console.log(`✅ Message successfully delivered to ${sender}!`);
    } catch (err) {
      console.error("❌ Error processing message:", err);
      await sendWhatsAppMessage(
        sender,
        "⚠️ Sorry, I encountered an issue processing your message. Please try again in a few moments."
      );
    }
    return;
  }

  // 4. UNSUPPORTED TYPES
  await sendWhatsAppMessage(
    sender,
    "👋 Hello! I currently support text questions, images (photos, diagrams, notes), and PDF documents. Send me a file or ask any question!"
  );
}

/**
 * Main HTTP Server Entrypoint
 */
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

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

  // 2. POST: Handle incoming WhatsApp webhook events
  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch (err) {
      console.error("Invalid JSON:", err);
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    console.log("🔥 WEBHOOK RECEIVED:\n" + JSON.stringify(body, null, 2));

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
                await handleSingleMessage(msg, contacts);
              }
            }
          }
        }
      } catch (err) {
        console.error("❌ Error in processEvents:", err);
      }
    };

    await processEvents();

    return Response.json({ status: "received" });
  }

  return new Response("Method not allowed", { status: 405 });
});
