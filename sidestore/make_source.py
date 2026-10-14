"""Собирает source.json для SideStore (формат источников AltStore) по готовому PhotoSorter.app.

Версия, номер сборки, bundle id и тексты разрешений берутся из Info.plist внутри .app,
поэтому источник всегда совпадает с тем, что лежит в .ipa. SideStore не ставит приложение,
если разрешения в источнике и в приложении расходятся.
"""
import argparse
import datetime
import json
import os
import plistlib

REPO = "https://github.com/aleshadorokhov-cyber/photo_sorter"
ICON = "https://raw.githubusercontent.com/aleshadorokhov-cyber/photo_sorter/main/PhotoSorter/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
TINT = "2F5BD3"
DESCRIPTION = (
    "Раскладывает фото по категориям прямо на телефоне: определяет, что на снимке, "
    "читает текст и предлагает понятное имя. Внутри категорий фото идут от новых к старым, "
    "раскладку можно превратить в альбомы. Фото никуда не отправляются."
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True, help="путь к PhotoSorter.app")
    ap.add_argument("--ipa", required=True, help="путь к PhotoSorter.ipa")
    ap.add_argument("--url", required=True, help="откуда SideStore скачает .ipa")
    ap.add_argument("--notes", default="", help="что нового в этой сборке")
    ap.add_argument("--out", default="source.json")
    args = ap.parse_args()

    with open(os.path.join(args.app, "Info.plist"), "rb") as f:
        info = plistlib.load(f)
    name = info.get("CFBundleDisplayName") or info["CFBundleName"]
    bundle_id = info["CFBundleIdentifier"]
    version = info["CFBundleShortVersionString"]
    build = str(info["CFBundleVersion"])
    min_os = info.get("MinimumOSVersion", "17.0")
    privacy = {k: v for k, v in info.items() if k.endswith("UsageDescription")}
    size = os.path.getsize(args.ipa)
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    notes = args.notes or f"Сборка {build}"

    source = {
        "name": name,
        "identifier": bundle_id + ".source",
        "subtitle": "Фото по полочкам",
        "description": DESCRIPTION,
        "iconURL": ICON,
        "website": REPO,
        "tintColor": TINT,
        "apps": [{
            "name": name,
            "bundleIdentifier": bundle_id,
            "developerName": "Алексей",
            "subtitle": "Фото по полочкам",
            "localizedDescription": DESCRIPTION,
            "iconURL": ICON,
            "tintColor": TINT,
            "category": "photo-video",
            "screenshots": [],
            "versions": [{
                "version": version,
                "buildVersion": build,
                "date": date,
                "localizedDescription": notes,
                "downloadURL": args.url,
                "size": size,
                "minOSVersion": min_os,
            }],
            "appPermissions": {"entitlements": [], "privacy": privacy},
            # Поля старого формата для прежних версий SideStore
            "version": version,
            "versionDate": date,
            "versionDescription": notes,
            "downloadURL": args.url,
            "size": size,
        }],
        "news": [],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(source, f, ensure_ascii=False, indent=2)
    print(f"{args.out}: {name} {version} ({build}), {size} байт")


if __name__ == "__main__":
    main()
