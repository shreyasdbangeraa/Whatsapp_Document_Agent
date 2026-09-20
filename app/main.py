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

    print("\n" + "=" * 60)
    print("🔥 WEBHOOK RECEIVED")
    print("=" * 60)
    print(data)
    print("=" * 60)

    return {"status": "received"}