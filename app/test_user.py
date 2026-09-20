from user_manager import get_or_create_user


phone_number = "+919876543210"


user = get_or_create_user(phone_number)


print("=" * 50)
print("USER")
print("=" * 50)

print("ID:", user["id"])
print("WhatsApp:", user["whatsapp_number"])
print("Created:", user["created_at"])