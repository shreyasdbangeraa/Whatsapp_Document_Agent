import httpx

from app.config import (
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID
)

GRAPH_API_VERSION = "v25.0"


def send_text_message(to: str, message: str):
    url = (
        f"https://graph.facebook.com/"
        f"{GRAPH_API_VERSION}/"
        f"{WHATSAPP_PHONE_NUMBER_ID}/messages"
    )

    headers = {
        "Authorization": f"Bearer {WHATSAPP_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }

    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {
            "body": message
        }
    }

    try:
        response = httpx.post(
            url,
            headers=headers,
            json=payload,
            timeout=30
        )

        print(f"📤 WhatsApp API Send Status: {response.status_code}", flush=True)
        print(f"📤 WhatsApp API Send Response: {response.text}", flush=True)

        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as e:
        print(f"❌ WhatsApp API HTTP Error: {e.response.status_code} - {e.response.text}", flush=True)
        raise
    except Exception as e:
        print(f"❌ Error sending WhatsApp message: {e}", flush=True)
        raise