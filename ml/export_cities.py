"""Список городов для подписи места на фото без интернета (веб-версия).

Берёт GeoNames cities5000 (города от 5000 жителей) и русские названия из alternateNamesV2.
Пишет cities.json: {"names": [...], "coords": [lat0, lon0, lat1, lon1, ...]}.
Данные GeoNames распространяются по лицензии CC BY 4.0.
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.request
import zipfile

GEONAMES = "https://download.geonames.org/export/dump/"
csv.field_size_limit(sys.maxsize)


def open_zip(url, member, cache):
    path = os.path.join(cache, os.path.basename(url))
    if not os.path.exists(path):
        print("скачиваю", url)
        urllib.request.urlretrieve(url, path)
    return io.TextIOWrapper(zipfile.ZipFile(path).open(member), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="web-build/models")
    ap.add_argument("--cache", default="web-build/geonames")
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    cities = {}
    for row in csv.reader(open_zip(GEONAMES + "cities5000.zip", "cities5000.txt", args.cache), delimiter="\t"):
        cities[row[0]] = [row[1], float(row[4]), float(row[5])]
    print("городов:", len(cities))

    # Русское название: сначала помеченное как основное, потом любое не историческое и не разговорное
    best = {}
    names = open_zip(GEONAMES + "alternateNamesV2.zip", "alternateNamesV2.txt", args.cache)
    for row in csv.reader(names, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(row) < 8 or row[2] != "ru" or row[1] not in cities:
            continue
        preferred, short, colloquial, historic = (row[i] == "1" for i in (4, 5, 6, 7))
        if colloquial or historic:
            continue
        rank = 0 if preferred else (2 if short else 1)
        if row[1] not in best or rank < best[row[1]][0]:
            best[row[1]] = (rank, row[3])
    print("с русским названием:", len(best))

    out_names, coords = [], []
    for gid, (name, lat, lon) in cities.items():
        out_names.append(best[gid][1] if gid in best else name)
        coords += [round(lat, 3), round(lon, 3)]
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "cities.json"), "w", encoding="utf-8") as f:
        json.dump({"names": out_names, "coords": coords}, f, ensure_ascii=False, separators=(",", ":"))
    print("cities.json:", os.path.getsize(os.path.join(args.out, "cities.json")) // 1000, "КБ")


if __name__ == "__main__":
    main()
