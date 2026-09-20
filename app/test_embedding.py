from app.embeddings import create_embedding


text = """
An algorithm is a sequence of unambiguous instructions
used to solve a computational problem.
"""


print("Creating embedding...")

embedding = create_embedding(text)


print("\nEmbedding created successfully!")
print("Dimensions:", len(embedding))

print("\nFirst 10 values:")

print(embedding[:10])