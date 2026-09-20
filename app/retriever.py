from embeddings import create_embedding
from database import supabase


def search_documents(
    question: str,
    user_id: str,
    match_count: int = 5
):

    query_embedding = create_embedding(question)

    response = supabase.rpc(
        "match_document_chunks",
        {
            "query_embedding": query_embedding,
            "match_user_id": user_id,
            "match_count": match_count
        }
    ).execute()

    return response.data