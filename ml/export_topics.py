"""Эмбеддинги тем для текста на фото (веб-версия, режим «Тема»).

Модель EmbeddingGemma в формате MediaPipe (.task) та же, что загружает веб-версия,
поэтому темы и тексты с фото попадают в одно пространство. Темы берутся из taxonomy.json.
Пишет topics.f32 (float32, K x 768, строки нормированы).
"""
import argparse
import json
import os

import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import text as mp_text

# Тот же префикс добавляет к тексту с фото веб-версия (web/app.js)
PREFIX = "task: classification | query: "


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", default="PhotoSorter/Resources/taxonomy.json")
    ap.add_argument("--model", required=True, help="embedding_gemma.task")
    ap.add_argument("--out", default="web-build/models")
    args = ap.parse_args()

    topics = json.load(open(args.taxonomy, encoding="utf-8"))["topics"]
    options = mp_text.TextEmbedderOptions(base_options=mp_tasks.BaseOptions(model_asset_path=args.model))
    embedder = mp_text.TextEmbedder.create_from_options(options)
    rows = []
    for topic in topics:
        v = np.array(embedder.embed(PREFIX + topic).embeddings[0].embedding, dtype=np.float32)
        rows.append(v / np.linalg.norm(v))
    matrix = np.stack(rows).astype("<f4")
    os.makedirs(args.out, exist_ok=True)
    matrix.tofile(os.path.join(args.out, "topics.f32"))
    print(f"topics {matrix.shape}")


if __name__ == "__main__":
    main()
