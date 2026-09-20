from whatsapp import send_text_message


MY_WHATSAPP_NUMBER = "917019041717"


message = (
    "Hello! 👋\n\n"
    "This message was sent from my WhatsApp AI Document Agent."
)

send_text_message(
    to=MY_WHATSAPP_NUMBER,
    message=message
)