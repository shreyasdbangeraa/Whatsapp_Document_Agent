import os
from dotenv import load_dotenv


load_dotenv()


GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

WHATSAPP_ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN")


if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY is missing from .env")

if not SUPABASE_URL:
    raise ValueError("SUPABASE_URL is missing from .env")

if not SUPABASE_KEY:
    raise ValueError("SUPABASE_KEY is missing from .env")

if not WHATSAPP_ACCESS_TOKEN:
    raise ValueError("WHATSAPP_ACCESS_TOKEN is missing from .env")

if not WHATSAPP_PHONE_NUMBER_ID:
    raise ValueError("WHATSAPP_PHONE_NUMBER_ID is missing from .env")

if not WHATSAPP_VERIFY_TOKEN:
    raise ValueError("WHATSAPP_VERIFY_TOKEN is missing from .env")