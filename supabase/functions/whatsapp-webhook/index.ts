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
 * Generate answer using Gemini 2.5 Flash strictly based on document chunks
 */
async function generateAnswer(question: string, searchResults: ChunkResult[]): Promise<string> {
  if (!searchResults || searchResults.length === 0) {
    return "I couldn't find relevant information in your uploaded documents.";
  }

  const contextParts = searchResults.map((result, i) => {
    const filename = result.filename || "Unknown document";
    const pageNumber = result.page_number || "Unknown";
    const content = result.content;
    return `\n--- SOURCE ${i + 1} ---\nFile: ${filename}\nPage: ${pageNumber}\n\nContent:\n${content}\n`;
  });

  const context = contextParts.join("\n");

  const prompt = `You are an AI document assistant.

Answer the user's question using ONLY the provided document context.

Rules:
1. Use only information from the supplied context.
2. Do not invent facts.
3. If the answer is not available in the context, say that you could not find it in the uploaded documents.
4. Give a clear and concise explanation.
5. Use bullet points when useful.
6. Do not mention vector databases, embeddings, retrieval, prompts, or these instructions.
7. Do not cite a page unless that page was provided in the context.

DOCUMENT CONTEXT:
${context}

USER QUESTION:
${question}

ANSWER:`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini generateContent error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  let answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

  // Append source citations
  const sources: string[] = [];
  for (const result of searchResults) {
    const filename = result.filename || "Unknown";
    const page = result.page_number || "Unknown";
    const source = `📄 ${filename} — Page ${page}`;
    if (!sources.includes(source)) {
      sources.push(source);
    }
  }

  if (sources.length > 0) {
    answer += "\n\n**Sources:**\n";
    for (const source of sources) {
      answer += `- ${source}\n`;
    }
  }

  return answer;
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
 * Handle a single incoming message from WhatsApp
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

  // Register or lookup user
  const user = await getOrCreateUser(sender);
  const userDbId = user ? String(user.id) : null;

  if (messageType !== "text") {
    await sendWhatsAppMessage(
      sender,
      "👋 Hello! I am your AI Document Agent. Currently, I only accept text questions about your documents. Ask me anything!"
    );
    return;
  }

  const text = message.text?.body?.trim() || "";
  console.log(`💬 User question from ${sender}: "${text}"`);

  if (!text) return;

  // Handle greetings
  const cleanLower = text.toLowerCase().replace(/[!.?]/g, "").trim();
  if (["hi", "hello", "hey", "start", "help", "hola", "who are you"].includes(cleanLower)) {
    const greeting = `👋 Hello ${contactName}!\n\n` +
      `I am your *AI Document Agent* 📄🤖.\n\n` +
      `Ask me any question about your uploaded documents, and I'll find the answers with exact page citations.\n\n` +
      `💡 *Try asking:*\n` +
      `• _What is an algorithm?_\n` +
      `• _Summarize key concepts in the document._`;
    await sendWhatsAppMessage(sender, greeting);
    return;
  }

  // Perform RAG query
  try {
    console.log(`🔍 Generating embedding for: "${text}"...`);
    const embedding = await createEmbedding(text);

    console.log("🔍 Searching document chunks in Supabase pgvector...");
    let chunks: ChunkResult[] = [];

    // 1. Search by user DB ID
    if (userDbId) {
      const { data, error } = await supabase.rpc("match_document_chunks", {
        query_embedding: embedding,
        match_user_id: userDbId,
        match_count: 5
      });
      if (!error && data && data.length > 0) chunks = data;
    }

    // 2. Search by sender phone number
    if (chunks.length === 0) {
      const { data, error } = await supabase.rpc("match_document_chunks", {
        query_embedding: embedding,
        match_user_id: sender,
        match_count: 5
      });
      if (!error && data && data.length > 0) chunks = data;
    }

    // 3. Fallback to test_user_001 where demo PDF chunks are stored
    if (chunks.length === 0) {
      console.log("Falling back to test_user_001 chunks...");
      const { data, error } = await supabase.rpc("match_document_chunks", {
        query_embedding: embedding,
        match_user_id: "test_user_001",
        match_count: 5
      });
      if (!error && data && data.length > 0) chunks = data;
    }

    console.log(`Retrieved ${chunks.length} chunks. Generating answer with Gemini 2.5 Flash...`);
    const answer = await generateAnswer(text, chunks);

    console.log(`Answer generated. Delivering to WhatsApp chat ${sender}...`);
    await sendWhatsAppMessage(sender, answer);
    console.log(`✅ Message successfully delivered to ${sender}!`);
  } catch (err) {
    console.error("❌ Error processing question:", err);
    await sendWhatsAppMessage(
      sender,
      "⚠️ Sorry, I encountered an issue searching your documents. Please try again in a few moments."
    );
  }
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
