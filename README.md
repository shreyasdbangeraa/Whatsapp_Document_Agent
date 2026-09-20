# WhatsApp Document Agent 📄🤖

An AI-powered document intelligence agent built for WhatsApp using **Retrieval-Augmented Generation (RAG)**. The agent processes PDF documents, indexes them into a **Supabase** vector store using **Google Gemini** embeddings, and generates answers with source page citations using **Gemini 2.5 Flash**.

---

## 🌟 Key Features

- **📄 PDF Ingestion & Parsing:** Extracts text page-by-page using PyMuPDF (`fitz`), cleans whitespace, and splits text into overlapping chunks for context preservation.
- **🧠 Vector Embeddings:** Computes 768-dimensional embeddings using Google Gemini's `gemini-embedding-001` with batch processing support.
- **⚡ Vector Storage & Similarity Search:** Stores document metadata and vector embeddings in Supabase using PostgreSQL and `pgvector` with cosine similarity search (`match_document_chunks` RPC).
- **🎯 Grounded RAG Generation:** Answers user questions strictly using retrieved document context with **Gemini 2.5 Flash** (`gemini-2.5-flash`), eliminating hallucinations and providing transparent source citations (file name & page numbers).
- **👤 Multi-User Management:** Tracks users by WhatsApp phone number for isolated and secure multi-tenant document queries.

---

## 🏗️ Architecture & Pipeline

```
[ User PDF Document ]
         │
         ▼
[ PyMuPDF Text Extraction & Chunking ]
         │
         ▼
[ Google Gemini Embedding API (gemini-embedding-001) ]
         │
         ▼
[ Supabase PostgreSQL + pgvector ]
         │
         │  ◄── [ WhatsApp / User Question ]
         ▼
[ Vector Similarity Search (RPC: match_document_chunks) ]
         │
         ▼
[ Gemini 2.5 Flash (Strict Grounded Prompt + Citations) ]
         │
         ▼
[ Verified Answer with Page Numbers ]
```

---

## 🛠️ Tech Stack

- **Language & Runtime:** Python 3.10+ (Local ingestion), TypeScript & Deno (Supabase Edge Functions)
- **LLM & Embeddings:** Google GenAI (Gemini 2.5 Flash, Gemini Embedding 001)
- **Database & Vector Store:** Supabase (PostgreSQL with `pgvector`)
- **Serverless Webhook Engine:** Supabase Edge Functions (Always-on, globally distributed)
- **PDF Processing:** PyMuPDF (`pymupdf`)
- **Messaging:** Meta WhatsApp Cloud API (Graph API v25.0)

---

## 📂 Project Structure

```
Whatsapp_Document_Agent/
├── app/
│   ├── config.py           # Environment variable loading & validation
│   ├── database.py         # Supabase client initialization
│   ├── embeddings.py       # Google Gemini embedding generation functions
│   ├── generator.py        # Gemini 2.5 Flash answer generation with citations
│   ├── main.py             # Application entrypoint / API server
│   ├── pdf_processor.py    # PDF text extraction, cleaning, and chunking
│   ├── retriever.py        # Vector similarity search using Supabase RPC
│   ├── upload_document.py  # End-to-end PDF ingestion and embedding batch uploader
│   ├── user_manager.py     # User creation and lookup by WhatsApp number
│   ├── test_embedding.py   # Test script for embedding generation
│   ├── test_pdf.py         # Test script for PDF parsing and chunking
│   ├── test_rag.py         # Interactive CLI to ask questions against documents
│   ├── test_search.py      # Test script for vector similarity search
│   └── test_user.py        # Test script for user management
├── .env.example            # Template for environment variables
├── .gitignore              # Files and patterns ignored by Git
├── requirements.txt        # Python package dependencies
└── README.md               # Project documentation
```

---

## 🚀 Getting Started

### 1. Prerequisites

- Python 3.10 or higher
- A [Google AI Studio](https://aistudio.google.com/) account and API key
- A [Supabase](https://supabase.com/) account and project

### 2. Clone the Repository

```bash
git clone https://github.com/shreyasdbangeraa/Whatsapp_Document_Agent.git
cd Whatsapp_Document_Agent
```

### 3. Create and Activate a Virtual Environment

**Windows (PowerShell):**
```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

**macOS / Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
```

### 4. Install Dependencies

```bash
pip install -r requirements.txt
```

### 5. Configure Environment Variables

Create a `.env` file in the root directory by copying `.env.example`:

```bash
cp .env.example .env
```

Fill in your credentials:

```env
GEMINI_API_KEY=your_gemini_api_key
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_KEY=your_supabase_service_role_or_anon_key
```

---

## 🗄️ Database Setup (Supabase SQL)

Run the following SQL in the **SQL Editor** of your Supabase dashboard to set up the necessary tables, vector extension, and similarity search function:

```sql
-- 1. Enable the pgvector extension
create extension if not exists vector;

-- 2. Users Table
create table if not exists users (
    id uuid default gen_random_uuid() primary key,
    whatsapp_number text unique not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. Documents Table
create table if not exists documents (
    id uuid default gen_random_uuid() primary key,
    user_id text not null,
    filename text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. Document Chunks Table with Vector Embeddings
create table if not exists document_chunks (
    id uuid default gen_random_uuid() primary key,
    document_id uuid references documents(id) on delete cascade,
    user_id text not null,
    chunk_index integer not null,
    content text not null,
    page_number integer,
    embedding vector(768),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 5. RPC Function for Vector Similarity Search
create or replace function match_document_chunks (
    query_embedding vector(768),
    match_user_id text,
    match_count int default 5
)
returns table (
    id uuid,
    document_id uuid,
    user_id text,
    chunk_index int,
    content text,
    page_number int,
    similarity float
)
language plpgsql
as $$
begin
    return query
    select
        dc.id,
        dc.document_id,
        dc.user_id,
        dc.chunk_index,
        dc.content,
        dc.page_number,
        1 - (dc.embedding <=> query_embedding) as similarity
    from document_chunks dc
    where dc.user_id = match_user_id
    order by dc.embedding <=> query_embedding
    limit match_count;
end;
$$;
```

---

## 🧪 Testing & Usage

You can test individual modules or run the complete RAG loop from the command line:

### 1. Ingest a Document
Place your PDF in the project folder and run:
```bash
python app/upload_document.py
```
This extracts pages, creates overlapping text chunks, generates embeddings in batches of 50, and uploads them to Supabase.

### 2. Query the Knowledge Base (Interactive RAG)
```bash
python app/test_rag.py
```
Ask questions directly in your terminal. The agent will retrieve relevant chunks and output a concise answer with source citations:
```text
Ask a question about your PDF: What is an algorithm?

Searching document...
Generating answer...

============================================================
ANSWER
============================================================
An algorithm is a well-defined computational procedure that takes some value, or set of values, as input and produces some value, or set of values, as output.

**Sources:**
- 📄 test.pdf — Page 5
```

### 3. Run Component Tests
- Test PDF extraction: `python app/test_pdf.py`
- Test embedding API: `python app/test_embedding.py`
- Test vector search: `python app/test_search.py`
- Test user management: `python app/test_user.py`

---

## 🗺️ Roadmap

- [x] WhatsApp Cloud API webhook integration (Serverless via Supabase Edge Functions)
- [ ] Direct PDF uploads via WhatsApp chat
- [ ] Conversation history & session memory per user
- [ ] Support for multiple file types (DOCX, TXT, CSV)

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
