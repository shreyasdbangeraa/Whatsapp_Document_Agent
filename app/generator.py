from google import genai

from app.config import GEMINI_API_KEY


client = genai.Client(api_key=GEMINI_API_KEY)

MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash"]


def generate_answer(question: str, search_results: list, user_name: str = "there") -> str:
    """
    Generate an intelligent, conversational response with multi-model fallback.
    - Cites exact document pages ONLY when answering from the document context.
    - Speaks naturally like a friendly AI for greetings, casual chat, and general queries without citing sources.
    """
    context = ""
    if search_results:
        context_parts = []
        for i, result in enumerate(search_results, start=1):
            filename = result.get("filename", "Uploaded Document")
            page_number = result.get("page_number", "Unknown")
            content = result.get("content", "")
            context_parts.append(
                f"--- SOURCE {i} ---\nFile: {filename}\nPage: {page_number}\nContent:\n{content}"
            )
        context = "\n\n".join(context_parts)

    system_prompt = f"""You are an intelligent, friendly, and helpful AI Document Assistant on WhatsApp. The user's name is "{user_name}".

You have access to DOCUMENT CONTEXT from the user's uploaded files (shown below if relevant matches were found).

GUIDELINES FOR YOUR RESPONSES:
1. Casual Conversation & General Chit-Chat (e.g. "hi", "hello", "how are you", "who are you", "tell me a joke", "thank you", "good morning"):
   - Talk naturally, warmly, and engagingly like a modern, intelligent conversational AI assistant.
   - Do NOT mention or cite any sources, page numbers, or documents for casual conversation.

2. Questions Answered from the Document:
   - Provide a clear, well-structured, and accurate answer using the provided DOCUMENT CONTEXT.
   - Format cleanly for WhatsApp: use *bold* for emphasis, bullet points (•) for lists, and short readable paragraphs.
   - ONLY when your answer relies on information from the DOCUMENT CONTEXT, add the exact source citation at the very end in this clean format:

📚 *Source:*
• 📄 <filename> — Page <page_number>

   - ONLY cite the specific document and page number(s) that directly supported your answer. Never list unused sources.

3. General Knowledge Questions (e.g. "What is photosynthesis?", "Write a python function to reverse a string", "Translate this to Spanish"):
   - Answer helpfully and accurately using your general knowledge.
   - Do NOT include any source citations.

4. Questions About the Document when the Information is NOT in the Context:
   - If the user specifically asks about their document, but the information is missing from the provided context, politely let them know: "I checked your uploaded document, but I couldn't find details regarding that topic. Feel free to rephrase or ask another question!"
   - Do NOT invent facts and do NOT include any source citations."""

    full_prompt = f"""{system_prompt}

DOCUMENT CONTEXT:
{context if context else "No matching document context found."}

USER MESSAGE:
{question}

ASSISTANT:"""

    last_error = None
    for model_name in MODELS:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=full_prompt
            )
            if response.text and response.text.strip():
                return response.text.strip()
        except Exception as e:
            last_error = e
            continue

    if last_error:
        raise last_error
    return "I'm having trouble processing that right now. Please try again!"