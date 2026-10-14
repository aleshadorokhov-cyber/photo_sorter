"""Готовит модель для веб-версии из той же OpenCLIP ViT-B-32, что и приложение для iPhone.

Делает в папке --out:
  image_encoder.onnx   кодировщик изображений в ONNX, веса матриц 8-битные (~130 МБ)
  categories.f32       эмбеддинги категорий, как в приложении
  labels.f32           эмбеддинги подписей, как в приложении

Вход модели: картинка 224x224 в диапазоне [0, 1] (N x 3 x 224 x 224), нормализация внутри.
В конце сверяет сжатую модель с PyTorch на контрольной картинке.

Сжимаются только веса (MatMulNBits, 8 бит), вычисления остаются во float32.
Обычное динамическое int8-квантование сжимает и промежуточные значения: на фото из шага 1
оно давало близость с исходной моделью около 0,96 и меняло категорию у 3 фото из 34.
"""
import argparse
import json
import os

import numpy as np
import open_clip
import torch

from export_models import (IMAGE_SIZE, MODEL, PRETRAINED, ImageEncoder,
                           export_embeddings, reference_image)


def export_onnx(model, out, quantize):
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    wrapper = ImageEncoder(model.visual).eval()
    fp32 = os.path.join(out, "image_encoder_fp32.onnx")
    final = os.path.join(out, "image_encoder.onnx")
    torch.onnx.export(
        wrapper, (torch.rand(1, 3, IMAGE_SIZE, IMAGE_SIZE),), fp32,
        input_names=["image"], output_names=["embedding"],
        dynamic_axes={"image": {0: "n"}, "embedding": {0: "n"}},
        opset_version=17, dynamo=False)
    if quantize:
        quantizer = MatMulNBitsQuantizer(onnx.load(fp32), bits=8, block_size=32, is_symmetric=True)
        quantizer.process()
        quantizer.model.save_model_to_file(final, use_external_data_format=False)
        os.remove(fp32)
    else:
        os.replace(fp32, final)

    with torch.no_grad():
        expected = wrapper(reference_image())[0].numpy()
    session = ort.InferenceSession(final, providers=["CPUExecutionProvider"])
    got = session.run(None, {"image": reference_image().numpy()})[0][0]
    cosine = float(np.dot(got, expected) / np.linalg.norm(got) / np.linalg.norm(expected))
    size = os.path.getsize(final) / 1e6
    print(f"image_encoder.onnx: {size:.0f} МБ, близость с PyTorch {cosine:.5f}")
    return cosine


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", default="PhotoSorter/Resources/taxonomy.json")
    ap.add_argument("--out", default="web-build/models")
    ap.add_argument("--random-weights", action="store_true", help="только для проверки конвертации")
    ap.add_argument("--no-quantize", action="store_true")
    ap.add_argument("--min-cosine", type=float, default=0.995)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    taxonomy = json.load(open(args.taxonomy, encoding="utf-8"))
    model, _, _ = open_clip.create_model_and_transforms(
        MODEL, pretrained=None if args.random_weights else PRETRAINED)
    model.eval()
    tokenizer = open_clip.get_tokenizer(MODEL)

    export_embeddings(model, tokenizer, taxonomy, args.out)
    cosine = export_onnx(model, args.out, quantize=not args.no_quantize)
    if not args.random_weights and cosine < args.min_cosine:
        raise SystemExit(f"Сжатая модель слишком расходится с PyTorch: {cosine:.5f}")
    print("готово:", args.out)


if __name__ == "__main__":
    main()
