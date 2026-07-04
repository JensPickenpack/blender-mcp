#!/usr/bin/env python3
"""
download_polyhaven_assets.py
----------------------------
Direct PolyHaven asset downloader — fetches GLB/blend files for a curated list
of gothic props without requiring a running Blender instance.

Usage:
    python download_polyhaven_assets.py               # download all targets
    python download_polyhaven_assets.py brass_diya_lantern  # specific slug(s)

Output: tools/blender-mcp/input/{slug}/{filename}
"""

import sys
import json
import urllib.request
import urllib.error
import os
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE = "https://api.polyhaven.com"
OUT_DIR = Path(__file__).parent / "input"
PREFERRED_RESOLUTION = "2k"
PREFERRED_FORMAT_ORDER = ["blend", "gltf"]   # blend first (native), fallback gltf

# ── Target assets ─────────────────────────────────────────────────────────────
# Curated gothic/atmospheric props for The Silent Choir of the Rift
TARGET_SLUGS = [
    # Lighting / atmosphere
    "brass_candleholders",      # ornate brass candle holders — ritual altars
    "brass_diya_lantern",       # hanging brass lantern — pathway lighting

    # Structures / gates
    "large_castle_door",        # medieval arched castle door
    "large_iron_gate",          # ornate iron gate with spear finials

    # Stone landscape
    "boulder_01",               # weathered lichen boulder — natural obstacles
]

# ── Helpers ───────────────────────────────────────────────────────────────────
def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "silent-choir-downloader/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def pick_download_url(files: dict, slug: str) -> tuple[str | None, str]:
    """
    Returns (url, format_key) for the best available file.

    PolyHaven models API structure for model files:
        files["blend"]["2k"]["blend"]["url"]   (native .blend)
        files["gltf"]["2k"]["gltf"]["url"]     (glTF)

    Priority: blend@2k > blend@1k > blend@4k > gltf@2k > gltf@1k > gltf@4k
    """
    for fmt in PREFERRED_FORMAT_ORDER:
        fmt_block = files.get(fmt)
        if not isinstance(fmt_block, dict):
            continue
        for res in [PREFERRED_RESOLUTION, "1k", "4k", "8k"]:
            res_block = fmt_block.get(res)
            if not isinstance(res_block, dict):
                continue
            # Inner key matches the format name: blend["blend"]["url"] or gltf["gltf"]["url"]
            inner = res_block.get(fmt)
            if isinstance(inner, dict):
                url = inner.get("url")
                if url:
                    return url, fmt
    return None, ""


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "silent-choir-downloader/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
        total = resp.headers.get("Content-Length")
        downloaded = 0
        chunk = 65536
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            f.write(buf)
            downloaded += len(buf)
            if total:
                pct = downloaded / int(total) * 100
                print(f"\r  {pct:5.1f}%  {downloaded // 1024:,} KB", end="", flush=True)
    print()


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    slugs = sys.argv[1:] if len(sys.argv) > 1 else TARGET_SLUGS
    print(f"Downloading {len(slugs)} asset(s) to {OUT_DIR}\n")

    results = []
    for slug in slugs:
        print(f"[{slug}]")
        try:
            files = fetch_json(f"{API_BASE}/files/{slug}")
        except Exception as e:
            print(f"  ERROR fetching metadata: {e}")
            results.append({"slug": slug, "status": "error", "reason": str(e)})
            continue

        url, fmt = pick_download_url(files, slug)
        if not url:
            print(f"  SKIP — no suitable blend/gltf found at {PREFERRED_RESOLUTION}")
            results.append({"slug": slug, "status": "skipped", "reason": "no_url"})
            continue

        ext = Path(url.rsplit("?", 1)[0]).suffix or f".{fmt}"
        dest = OUT_DIR / slug / f"{slug}{ext}"

        if dest.exists():
            print(f"  Already exists: {dest.name}")
            results.append({"slug": slug, "status": "exists", "path": str(dest)})
            continue

        print(f"  → {fmt.upper()} @ {PREFERRED_RESOLUTION} → {dest.name}")
        print(f"  URL: {url[:80]}...")
        try:
            download_file(url, dest)
            print(f"  OK  {dest}")
            results.append({"slug": slug, "status": "ok", "path": str(dest), "format": fmt})
        except Exception as e:
            print(f"  ERROR: {e}")
            results.append({"slug": slug, "status": "error", "reason": str(e)})

    # Summary
    print("\n── Summary ──────────────────────────────────────")
    for r in results:
        status_icon = {"ok": "✓", "exists": "=", "skipped": "–", "error": "✗"}.get(r["status"], "?")
        print(f"  {status_icon}  {r['slug']:35s}  {r['status']}")

    manifest_path = OUT_DIR / "download_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    # Merge with existing manifest if present
    existing = {}
    if manifest_path.exists():
        try:
            existing = {e["slug"]: e for e in json.loads(manifest_path.read_text())}
        except Exception:
            pass
    for r in results:
        existing[r["slug"]] = r
    manifest_path.write_text(json.dumps(list(existing.values()), indent=2))
    print(f"\nManifest written to: {manifest_path}")


if __name__ == "__main__":
    main()
