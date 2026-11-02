#!/usr/bin/env python3
"""Aduna pachetele de decoratii (pack-*.json) in src/decorations/catalog.json (nume, tema) si svgs.json (desenele).
Folosire: python3 tools/build-decorations.py /calea/folder [deco|effects|plates]  (implicit deco)"""
import glob, json, os, sys
src = sys.argv[1] if len(sys.argv) > 1 else "."
kind = sys.argv[2] if len(sys.argv) > 2 else "deco"
prefix = {"deco": "", "effects": "effects-", "plates": "plates-"}[kind]
out = os.path.join(os.path.dirname(__file__), "..", "src", "decorations")
items, seen = [], set()
for f in sorted(glob.glob(os.path.join(src, "pack-*.json"))):
    for d in json.load(open(f, encoding="utf8")):
        if d["id"] in seen:
            print("duplicat sarit:", d["id"]); continue
        seen.add(d["id"]); items.append(d)
catalog = [{"id": d["id"], "name": d["name"], "theme": d["theme"], "tags": d.get("tags", [])} for d in items]
svgs = {d["id"]: d["svg"] for d in items}
json.dump(catalog, open(os.path.join(out, prefix + "catalog.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
json.dump(svgs, open(os.path.join(out, prefix + "svgs.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print(len(items), "decoratii;", round(os.path.getsize(os.path.join(out, prefix + "svgs.json")) / 1024), "KB de desene")
