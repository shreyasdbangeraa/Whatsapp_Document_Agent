from pdf_processor import (
    extract_text_from_pdf,
    clean_text,
    create_chunks
)


PDF_PATH = "test.pdf"


print("Reading PDF...")

text = extract_text_from_pdf(PDF_PATH)

print("\nRaw text length:", len(text))


cleaned_text = clean_text(text)

print("Cleaned text length:", len(cleaned_text))


chunks = create_chunks(cleaned_text)

print("Number of chunks:", len(chunks))


print("\n" + "=" * 60)
print("FIRST CHUNK")
print("=" * 60)

print(chunks[0])


if len(chunks) > 1:

    print("\n" + "=" * 60)
    print("SECOND CHUNK")
    print("=" * 60)

    print(chunks[1])