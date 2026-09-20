from app.pdf_processor import (
    extract_pdf_chunks,
    clean_text,
    create_chunks
)

from app.embeddings import create_embeddings

from app.database import supabase


PDF_PATH = "test.pdf"

USER_ID = "test_user_001"

BATCH_SIZE = 50


def upload_document():

    print("Reading PDF...")

    pages = extract_pdf_chunks(PDF_PATH)

    print(f"Found {len(pages)} pages.")

    # -----------------------------------------
    # Prepare all chunks
    # -----------------------------------------

    all_chunks = []

    for page in pages:

        page_number = page["page_number"]

        text = clean_text(page["text"])

        chunks = create_chunks(text)

        print(
            f"Page {page_number}: "
            f"{len(chunks)} chunks"
        )

        for chunk in chunks:

            all_chunks.append({
                "page_number": page_number,
                "content": chunk
            })

    print()
    print(f"Total chunks: {len(all_chunks)}")

    # -----------------------------------------
    # Create document record
    # -----------------------------------------

    print("Creating document record...")

    document_response = (
        supabase
        .table("documents")
        .insert({
            "user_id": USER_ID,
            "filename": PDF_PATH
        })
        .execute()
    )

    document = document_response.data[0]

    document_id = document["id"]

    print(f"Document ID: {document_id}")

    # -----------------------------------------
    # Generate embeddings in batches
    # -----------------------------------------

    chunk_index = 0

    for start in range(0, len(all_chunks), BATCH_SIZE):

        batch = all_chunks[start:start + BATCH_SIZE]

        texts = [
            item["content"]
            for item in batch
        ]

        print()
        print(
            f"Embedding batch "
            f"{start + 1} - "
            f"{start + len(batch)}"
        )

        embeddings = create_embeddings(texts)

        # -----------------------------------------
        # Store embeddings
        # -----------------------------------------

        rows = []

        for item, embedding in zip(
            batch,
            embeddings
        ):

            chunk_index += 1

            rows.append({
                "document_id": document_id,
                "user_id": USER_ID,
                "chunk_index": chunk_index,
                "content": item["content"],
                "embedding": embedding,
                "page_number": item["page_number"]
            })

        print(
            f"Uploading {len(rows)} chunks..."
        )

        (
            supabase
            .table("document_chunks")
            .insert(rows)
            .execute()
        )

    print()
    print("=" * 50)
    print("DOCUMENT UPLOADED SUCCESSFULLY")
    print("=" * 50)

    print(f"Document ID: {document_id}")
    print(f"Total chunks: {chunk_index}")


if __name__ == "__main__":
    upload_document()