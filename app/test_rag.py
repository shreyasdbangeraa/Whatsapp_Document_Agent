from retriever import search_documents
from generator import generate_answer


USER_ID = "test_user_001"


def ask_question(question: str):

    print("\nSearching document...")

    results = search_documents(
        question=question,
        user_id=USER_ID,
        match_count=5
    )

    print("Generating answer...")

    answer = generate_answer(
        question=question,
        search_results=results
    )

    print("\n" + "=" * 60)
    print("ANSWER")
    print("=" * 60)

    print(answer)


if __name__ == "__main__":

    question = input("\nAsk a question about your PDF: ")

    ask_question(question)