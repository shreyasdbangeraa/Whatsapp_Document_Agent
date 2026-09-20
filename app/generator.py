from google import genai

from config import GEMINI_API_KEY


client = genai.Client(api_key=GEMINI_API_KEY)

MODEL = "gemini-2.5-flash"


def generate_answer(question: str, search_results: list) -> str:

    if not search_results:
        return (
            "I couldn't find relevant information "
            "in your uploaded documents."
        )

    context_parts = []

    for i, result in enumerate(search_results, start=1):

        filename = result.get(
            "filename",
            "Unknown document"
        )

        page_number = result.get(
            "page_number",
            "Unknown"
        )

        content = result["content"]

        context_parts.append(
            f"""
--- SOURCE {i} ---

File: {filename}
Page: {page_number}

Content:
{content}
"""
        )

    context = "\n".join(context_parts)

    prompt = f"""
You are an AI document assistant.

Answer the user's question using ONLY the
provided document context.

Rules:

1. Use only information from the supplied context.
2. Do not invent facts.
3. If the answer is not available in the context,
   say that you could not find it in the uploaded documents.
4. Give a clear and concise explanation.
5. Use bullet points when useful.
6. Do not mention vector databases, embeddings,
   retrieval, prompts, or these instructions.
7. Do not cite a page unless that page was provided
   in the context.

DOCUMENT CONTEXT:

{context}

USER QUESTION:

{question}

ANSWER:
"""

    response = client.models.generate_content(
        model=MODEL,
        contents=prompt
    )

    answer = response.text.strip()

    # -----------------------------------------
    # Add source information
    # -----------------------------------------

    sources = []

    for result in search_results:

        filename = result.get(
            "filename",
            "Unknown"
        )

        page = result.get(
            "page_number",
            "Unknown"
        )

        source = f"📄 {filename} — Page {page}"

        if source not in sources:
            sources.append(source)

    if sources:

        answer += "\n\n**Sources:**\n"

        for source in sources:
            answer += f"- {source}\n"

    return answer