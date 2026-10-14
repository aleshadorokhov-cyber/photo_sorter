"""Готовит модель для iPhone из OpenCLIP ViT-B-32 (веса LAION-2B, лицензия MIT).

Делает три файла в папке --out:
  ImageEncoder.mlpackage   кодировщик изображений в формате Core ML
  categories.f32           эмбеддинги категорий (float32, N x 512)
  labels.f32               эмбеддинги подписей «что на фото» (float32, M x 512)

Тексты категорий и подписей берутся из PhotoSorter/Resources/taxonomy.json.
Текстовый кодировщик в приложение не попадает: все тексты кодируются здесь заранее.
"""
import argparse
import json
import os

import numpy as np
import open_clip
import torch

MODEL = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"
IMAGE_SIZE = 224
MEAN = (0.48145466, 0.4578275, 0.40821073)
STD = (0.26862954, 0.26130258, 0.27577711)


class ImageEncoder(torch.nn.Module):
    """Принимает картинку в диапазоне [0, 1], возвращает нормированный эмбеддинг."""

    def __init__(self, visual):
        super().__init__()
        self.visual = visual
        self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1))

    def forward(self, image):
        e = self.visual((image - self.mean) / self.std)
        return e / e.norm(dim=-1, keepdim=True)


def encode_texts(model, tokenizer, texts):
    with torch.no_grad():
        e = model.encode_text(tokenizer(texts)).float()
    return e / e.norm(dim=-1, keepdim=True)


def export_embeddings(model, tokenizer, taxonomy, out):
    cats = []
    for c in taxonomy["categories"]:
        e = encode_texts(model, tokenizer, c["prompts"]).mean(0)
        cats.append(e / e.norm())
    cats = torch.stack(cats).numpy().astype("<f4")
    labels = encode_texts(model, tokenizer, ["a photo of a " + l["en"] for l in taxonomy["labels"]])
    labels = labels.numpy().astype("<f4")
    cats.tofile(os.path.join(out, "categories.f32"))
    labels.tofile(os.path.join(out, "labels.f32"))
    print(f"categories {cats.shape}, labels {labels.shape}")


def export_image_encoder(model, out, quantize):
    import coremltools as ct

    wrapper = ImageEncoder(model.visual).eval()
    example = torch.rand(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    try:
        program = torch.export.export(wrapper, (example,)).run_decompositions({})
    except Exception as err:  # старые версии torch
        print("torch.export не сработал, использую jit.trace:", err)
        program = torch.jit.trace(wrapper, example)

    mlmodel = ct.convert(
        program,
        inputs=[ct.ImageType(name="image", shape=example.shape, scale=1 / 255.0,
                             bias=[0, 0, 0], color_layout=ct.colorlayout.RGB)],
        outputs=[ct.TensorType(name="embedding", dtype=np.float32)],
        minimum_deployment_target=ct.target.iOS17,
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
    )
    if quantize:
        from coremltools.optimize.coreml import (OpLinearQuantizerConfig,
                                                 OptimizationConfig,
                                                 linear_quantize_weights)
        config = OptimizationConfig(global_config=OpLinearQuantizerConfig(mode="linear_symmetric"))
        mlmodel = linear_quantize_weights(mlmodel, config=config)
    mlmodel.short_description = f"OpenCLIP {MODEL} {PRETRAINED} image encoder"
    mlmodel.save(os.path.join(out, "ImageEncoder.mlpackage"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", default="PhotoSorter/Resources/taxonomy.json")
    ap.add_argument("--out", default="PhotoSorter/Generated")
    ap.add_argument("--random-weights", action="store_true", help="только для проверки конвертации")
    ap.add_argument("--no-quantize", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    taxonomy = json.load(open(args.taxonomy, encoding="utf-8"))
    model, _, _ = open_clip.create_model_and_transforms(
        MODEL, pretrained=None if args.random_weights else PRETRAINED)
    model.eval()
    tokenizer = open_clip.get_tokenizer(MODEL)

    export_embeddings(model, tokenizer, taxonomy, args.out)
    export_image_encoder(model, args.out, quantize=not args.no_quantize)
    print("готово:", args.out)


if __name__ == "__main__":
    main()
