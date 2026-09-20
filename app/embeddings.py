from google import genai

from config import GEMINI_API_KEY


client = genai.Client(api_key=GEMINI_API_KEY)

EMBEDDING_MODEL = "gemini-embedding-001"


def create_embeddings(texts: list[str]) -> list[list[float]]:
    """
    Create embeddings for multiple texts in a single API request.
    """

    if not texts:
        return []

    response = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=texts,
        config={
            "output_dimensionality": 768
        }
    )

    return [
        embedding.values
        for embedding in response.embeddings
    ]


def create_embedding(text: str) -> list[float]:
    """
    Create an embedding for a single text.
    """

    embeddings = create_embeddings([text])

    return embeddings[0]