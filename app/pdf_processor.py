import pymupdf


def extract_pdf_chunks(pdf_path: str) -> list[dict]:
    """
    Extract text from a PDF page-by-page.
    Each returned item contains page metadata.
    """

    document = pymupdf.open(pdf_path)

    pages = []

    for page_number, page in enumerate(document, start=1):

        text = page.get_text()

        if text.strip():

            pages.append({
                "page_number": page_number,
                "text": text
            })

    document.close()

    return pages


def clean_text(text: str) -> str:
    """
    Clean unnecessary whitespace.
    """

    lines = text.splitlines()

    cleaned_lines = []

    for line in lines:

        line = line.strip()

        if line:
            cleaned_lines.append(line)

    return "\n".join(cleaned_lines)


def create_chunks(
    text: str,
    chunk_size: int = 1000,
    overlap: int = 200
) -> list[str]:

    if not text:
        return []

    chunks = []

    start = 0
    text_length = len(text)

    while start < text_length:

        end = start + chunk_size

        chunk = text[start:end].strip()

        if chunk:
            chunks.append(chunk)

        start += chunk_size - overlap

    return chunks