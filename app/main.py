from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

from app.config import WHATSAPP_VERIFY_TOKEN


app = FastAPI()


@app.get("/webhook")
async def verify_webhook(request: Request):

    params = request.query_params

    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    print("Webhook verification request received")

    if mode == "subscribe" and token == WHATSAPP_VERIFY_TOKEN:
        print("Webhook verified successfully")
        return PlainTextResponse(
            content=challenge,
            status_code=200
        )

    print("Webhook verification failed")

    return PlainTextResponse(
        content="Forbidden",
        status_code=403
    )


@app.post("/webhook")
async def receive_webhook(request: Request):
    data = await request.json()

    try:
        value = data["entry"][0]["changes"][0]["value"]

        messages = value.get("messages", [])

        if not messages:
            print("No message found in webhook")
            return {"status": "ignored"}

        message = messages[0]

        sender = message.get("from")
        message_id = message.get("id")
        message_type = message.get("type")

        print("\n" + "=" * 60)
        print("WHATSAPP MESSAGE RECEIVED")
        print("=" * 60)

        print("Sender:", sender)
        print("Message ID:", message_id)
        print("Message Type:", message_type)

        if message_type == "text":
            text = message["text"]["body"]
            print("Message:", text)

        print("=" * 60)

    except Exception as e:
        print("Error processing webhook:", e)

    return {"status": "received"}