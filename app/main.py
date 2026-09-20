import json
import sys
import traceback
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from app.config import WHATSAPP_VERIFY_TOKEN
from app.generator import generate_answer
from app.retriever import search_documents
from app.user_manager import get_or_create_user
from app.whatsapp import send_text_message

# Force unbuffered stdout with UTF-8 encoding so emojis never crash and logs appear immediately in Render
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass


app = FastAPI(title="WhatsApp Document Agent")


@app.get("/")
async def root():
    """Health check endpoint to verify server is active and awake."""
    print("Health check ping received at /", flush=True)
    return {
        "status": "online",
        "service": "WhatsApp AI Document Agent",
        "webhook": "/webhook"
    }


@app.get("/webhook")
@app.get("/webhook/")
async def verify_webhook(request: Request):
    """WhatsApp webhook verification endpoint (Meta Cloud API)."""
    params = request.query_params

    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    print("\n" + "=" * 60, flush=True)
    print("🔔 WEBHOOK VERIFICATION REQUEST RECEIVED", flush=True)
    print(f"hub.mode: {mode}", flush=True)
    print(f"hub.verify_token: {token}", flush=True)
    print(f"Expected verify token: {WHATSAPP_VERIFY_TOKEN}", flush=True)
    print(f"Match: {token == WHATSAPP_VERIFY_TOKEN}", flush=True)
    print("=" * 60, flush=True)

    if mode == "subscribe" and token == WHATSAPP_VERIFY_TOKEN:
        print("✅ Webhook verified successfully by Meta", flush=True)
        return PlainTextResponse(
            content=challenge,
            status_code=200
        )

    print("❌ Webhook verification failed: token mismatch or invalid mode", flush=True)
    return PlainTextResponse(
        content="Forbidden",
        status_code=403
    )


def handle_incoming_message(message: dict, contacts: list):
    """Process a single incoming WhatsApp message and reply in the same chat."""
    sender = message.get("from")
    message_id = message.get("id")
    message_type = message.get("type")

    print("\n" + "-" * 50, flush=True)
    print(f"📩 PROCESSING MESSAGE", flush=True)
    print(f"From: {sender}", flush=True)
    print(f"Message ID: {message_id}", flush=True)
    print(f"Type: {message_type}", flush=True)
    print("-" * 50, flush=True)

    if not sender:
        print("⚠️ No sender found in message. Skipping.", flush=True)
        return

    # Check for Meta's automated test dummy senders (e.g. from the 'Test' button in Meta dashboard)
    if sender in ["16315551181", "1234567890", "0"] or len(sender) < 8:
        print(f"ℹ️ Meta sample/test sender detected ({sender}). Skipping reply.", flush=True)
        return

    # Get contact name if available
    contact_name = "there"
    if contacts and isinstance(contacts, list):
        contact_name = contacts[0].get("profile", {}).get("name", "there")

    # Ensure user exists in database
    user_db_id = None
    try:
        user = get_or_create_user(sender)
        user_db_id = str(user.get("id")) if user else None
        print(f"👤 User registered/found in DB: ID={user_db_id}, Phone={sender}", flush=True)
    except Exception as e:
        print(f"⚠️ Could not sync user with DB (will continue): {e}", flush=True)

    # Only handle text messages for now
    if message_type != "text":
        print(f"ℹ️ Non-text message received ({message_type}). Sending polite guidance.", flush=True)
        try:
            send_text_message(
                to=sender,
                message="👋 Hello! I am your AI Document Agent. Currently, I only accept text questions about your documents. Ask me anything!"
            )
        except Exception as e:
            print(f"❌ Failed to send non-text guidance message: {e}", flush=True)
        return

    text = message.get("text", {}).get("body", "").strip()
    print(f"💬 Question received from {sender}: '{text}'", flush=True)

    if not text:
        return

    # Check for common greetings
    clean_lower = text.lower().strip(" !.?")
    if clean_lower in ["hi", "hello", "hey", "start", "help", "hola", "who are you"]:
        greeting_reply = (
            f"👋 Hello {contact_name}!\n\n"
            "I am your *AI Document Agent* 📄🤖.\n\n"
            "Ask me any question about your uploaded documents, and I'll find the answers with exact page citations.\n\n"
            "💡 *Example questions you can try:*\n"
            "• _What is an algorithm?_\n"
            "• _Summarize key concepts in the document._"
        )
        print(f"Sending greeting reply to {sender}...", flush=True)
        try:
            send_text_message(to=sender, message=greeting_reply)
            print(f"✅ Greeting reply sent to {sender}", flush=True)
        except Exception as e:
            print(f"❌ Failed to send greeting: {e}", flush=True)
        return

    # Process question with RAG pipeline
    try:
        print(f"🔍 Searching document knowledge base for: '{text}'...", flush=True)
        # Search strategy:
        # 1. Search with user's specific database ID
        # 2. Search with user's phone number
        # 3. Fallback to sample document indexed under 'test_user_001'
        search_results = []
        if user_db_id:
            search_results = search_documents(question=text, user_id=user_db_id, match_count=5)

        if not search_results:
            search_results = search_documents(question=text, user_id=sender, match_count=5)

        if not search_results:
            print("ℹ️ Falling back to test_user_001 knowledge base chunks...", flush=True)
            search_results = search_documents(question=text, user_id="test_user_001", match_count=5)

        print(f"📚 Retrieved {len(search_results)} relevant chunks. Generating answer with Gemini...", flush=True)
        answer = generate_answer(question=text, search_results=search_results)

        print(f"🤖 Generated Answer:\n{answer}\n", flush=True)

        print(f"📤 Sending response back to {sender} on WhatsApp...", flush=True)
        send_text_message(to=sender, message=answer)
        print(f"✅ Answer successfully delivered to {sender} on WhatsApp!", flush=True)

    except Exception as e:
        print(f"❌ Error during RAG processing or sending: {e}", flush=True)
        traceback.print_exc()
        try:
            send_text_message(
                to=sender,
                message="⚠️ Sorry, I encountered an issue processing your question. Please try again in a few moments."
            )
        except Exception as send_err:
            print(f"❌ Failed to send error notification to user: {send_err}", flush=True)


def process_whatsapp_webhook_payload(data: dict):
    """Background task to inspect webhook payload and route incoming messages."""
    try:
        entries = data.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})

                # 1. Check for status updates (sent, delivered, read receipts)
                statuses = value.get("statuses", [])
                if statuses:
                    for s in statuses:
                        status_name = s.get("status")
                        recipient = s.get("recipient_id")
                        msg_id = s.get("id")
                        print(f"ℹ️ WhatsApp Message Status: {status_name} (Recipient: {recipient}, ID: {msg_id})", flush=True)
                    # Status updates must NOT be replied to
                    continue

                # 2. Check for incoming messages
                messages = value.get("messages", [])
                if not messages:
                    print("ℹ️ Webhook received but contains neither messages nor statuses.", flush=True)
                    continue

                contacts = value.get("contacts", [])
                for message in messages:
                    handle_incoming_message(message, contacts)

    except Exception as e:
        print(f"❌ Unexpected error in process_whatsapp_webhook_payload: {e}", flush=True)
        traceback.print_exc()


@app.post("/webhook")
@app.post("/webhook/")
async def receive_webhook(request: Request, background_tasks: BackgroundTasks):
    """
    WhatsApp webhook receiver (Meta Cloud API).
    Logs the payload immediately and schedules background processing,
    returning an immediate 200 OK response to Meta so timeouts never happen.
    """
    try:
        data = await request.json()
    except Exception as e:
        print(f"❌ Could not decode webhook JSON body: {e}", flush=True)
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    print("\n" + "=" * 60, flush=True)
    print("🔥 WEBHOOK RECEIVED FROM META", flush=True)
    print("=" * 60, flush=True)
    try:
        print(json.dumps(data, indent=2), flush=True)
    except Exception:
        print(data, flush=True)
    print("=" * 60, flush=True)

    # Process message in background to guarantee Meta gets HTTP 200 immediately
    background_tasks.add_task(process_whatsapp_webhook_payload, data)

    return {"status": "received"}