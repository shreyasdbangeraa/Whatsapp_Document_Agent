from app.database import supabase


def get_or_create_user(whatsapp_number: str):

    # -----------------------------------------
    # Check if user already exists
    # -----------------------------------------

    response = (
        supabase
        .table("users")
        .select("*")
        .eq("whatsapp_number", whatsapp_number)
        .execute()
    )

    if response.data:

        return response.data[0]

    # -----------------------------------------
    # Create new user
    # -----------------------------------------

    response = (
        supabase
        .table("users")
        .insert({
            "whatsapp_number": whatsapp_number
        })
        .execute()
    )

    return response.data[0]