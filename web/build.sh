#!/usr/bin/env bash
# Собирает сайт: страницы, библиотеки из node_modules и модели.
# Использование: web/build.sh <папка с моделями> <папка сайта>
set -euo pipefail
MODELS=$1
OUT=$2
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NM="$ROOT/web/node_modules"

rm -rf "$OUT"
mkdir -p "$OUT"/vendor/{ort,tesseract,tesseract-core,tessdata,mediapipe,exifr} "$OUT/models"
cp "$ROOT"/web/{index.html,style.css,app.js,images.js,models.js,store.js,zip.js,image-worker.js,topic-worker.js} "$OUT/"
cp "$ROOT/PhotoSorter/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png" "$OUT/icon.png"
touch "$OUT/.nojekyll"

cp "$NM"/onnxruntime-web/dist/{ort.wasm.min.mjs,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm} "$OUT/vendor/ort/"
cp "$NM"/tesseract.js/dist/{tesseract.esm.min.js,worker.min.js} "$OUT/vendor/tesseract/"
cp "$NM"/tesseract.js-core/tesseract-core*.{js,wasm} "$OUT/vendor/tesseract-core/"
cp "$NM"/@tesseract.js-data/rus/4.0.0_best_int/rus.traineddata.gz "$NM"/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz "$OUT/vendor/tessdata/"
cp "$NM"/@mediapipe/tasks-text/text_bundle.mjs "$NM"/@mediapipe/tasks-text/wasm/* "$OUT/vendor/mediapipe/"
cp "$NM"/exifr/dist/lite.esm.mjs "$OUT/vendor/exifr/"

cp "$ROOT/PhotoSorter/Resources/taxonomy.json" "$OUT/models/"
cp "$MODELS"/{categories.f32,labels.f32,topics.f32,cities.json} "$OUT/models/"

# GitHub не принимает файлы больше 100 МБ, поэтому большие модели лежат частями по 45 МБ.
# В имени частей хеш модели: телефон хранит части у себя и качает заново, только если модель сменилась.
split_model() {
  local hash
  hash=$(sha256sum "$1" | cut -c1-10)
  split -b 45000000 -d -a 2 "$1" "$OUT/models/$2-$hash.part"
}
split_model "$MODELS/image_encoder.onnx" image_encoder
split_model "$MODELS/embedding_gemma.task" embedding_gemma
python3 - "$OUT/models" <<'PY'
import json, os, sys
d = sys.argv[1]
def parts(prefix):
    names = sorted(f for f in os.listdir(d) if f.startswith(prefix + "-") and ".part" in f)
    return {"parts": names, "size": sum(os.path.getsize(os.path.join(d, n)) for n in names)}
manifest = {"image": parts("image_encoder"), "topic": parts("embedding_gemma")}
json.dump(manifest, open(os.path.join(d, "manifest.json"), "w"), indent=1)
print(json.dumps(manifest))
PY
du -sh "$OUT"
