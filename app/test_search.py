from retriever import search_documents


USER_ID = "test_user_001"


question = "What is an algorithm?"


print("Searching documents...")
print()


results = search_documents(
    question=question,
    user_id=USER_ID,
    match_count=5
)


print("=" * 60)
print("SEARCH RESULTS")
print("=" * 60)


for i, result in enumerate(results, start=1):

    print()
    print(f"RESULT {i}")
    print("-" * 60)

    print("Similarity:", result["similarity"])

    print()
    print(result["content"])