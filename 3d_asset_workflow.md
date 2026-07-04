# 3D Asset Workflow: blender-mcp + PolyHaven

This document describes the complete workflow for discovering, downloading, and importing
PolyHaven 3D models into the project using the `blender-mcp` MCP server.

---

## Architecture

```
[MCP Agent]
    │
    ├─ mcp: blender-mcp ────────────────────────── Node.js MCP server
    │       ├─ discover tools  → api.polyhaven.com (HTTP, works always)
    │       └─ download tool   → Blender TCP bridge (port 8765, needs Blender)
    │
    └─ [Blender] ────────────────────────────────── Blender 4.x + addon
            └─ addon downloads asset → dl.polyhaven.org
```

**Key constraint:** `download-asset-from-polyhaven` requires a running Blender instance
with the blender-mcp addon connected on `127.0.0.1:8765`. Discovery tools work without Blender.

---

## Step 1 — Discovery (no Blender needed)

Use MCP tools to browse categories and find exact asset slugs.

### 1a. List asset types
```
mcp: blender-mcp → get-asset-types-from-polyhaven
```
Returns: `["hdris", "textures", "models"]`

### 1b. List categories for models
```
mcp: blender-mcp → get-categories-from-polyhaven
  asset_type: "models"
```
Relevant categories for gothic game art:
- `rocks` (37 assets) — boulders, stone formations
- `decorative` (68 assets) — candles, lanterns, vases, chandeliers
- `structures` (26 assets) — gates, doors, barriers
- `props` (128 assets) — general props
- `lighting` (23 assets) — lamps, candelabras

### 1c. Browse a category to find exact slugs
```
mcp: blender-mcp → get-asset-from-polyhaven
  asset_type: "models"
  category: "decorative"
```
Returns full JSON with asset slugs as keys, including names, tags, descriptions, download counts.

---

## Step 2 — Select assets

**Curated gothic props for The Silent Choir of the Rift** (verified slugs):

| Slug | Name | Category | Art Bible fit |
|------|------|----------|---------------|
| `brass_candleholders` | Brass Candleholders | decorative | ritual altars, gothic atmosphere |
| `brass_diya_lantern` | Brass Diya Lantern | decorative | hanging lanterns along paths |
| `large_castle_door` | Large Castle Door | structures | rift gate / nexus entrance |
| `large_iron_gate` | Large Iron Gate | structures | zone boundaries, spear finials |
| `boulder_01` | Boulder 01 | rocks/nature | natural stone obstacles, landscape |

Additional candidates (browse `decorative` and `props` for more):
- `Chandelier_01`, `Chandelier_03` — ornate chandeliers for indoor scenes

---

## Step 3 — Download (requires Blender running)

### Start Blender with blender-mcp addon
1. Open Blender 4.x
2. Install the blender-mcp addon (see `tools/blender-mcp/readme.md`)
3. Enable addon → it starts TCP listener on `127.0.0.1:8765`
4. Confirm: Blender console shows `MCP Bridge: Listening on 127.0.0.1:8765`

### Download via MCP tool
```
mcp: blender-mcp → download-asset-from-polyhaven
  asset_name: "brass_candleholders"    ← exact PolyHaven slug
  asset_type: "models"
  resolution: "2k"                     ← optional, defaults to "1k"
  file_format: "blend"                 ← optional, defaults to "blend" for models
```

**What happens:**
1. MCP server fetches `https://api.polyhaven.com/files/{slug}`
2. Resolves blend URL: `files["blend"]["2k"]["blend"]["url"]`
3. TCP-sends `{asset_name, blend_url, resolution, format, includes}` to Blender
4. Blender downloads the `.blend` file from `dl.polyhaven.org` and imports it
5. Asset appears in the Blender scene

**Repeat for each slug.**

### Export to GLB for Godot
After all assets are imported in Blender, run:
```
mcp: blender-mcp → send-code-to-blender
  code: (see tools/blender-mcp/blender_export_for_godot.py)
```
Or run via Blender Python console:
```bash
blender --background --python tools/blender-mcp/blender_export_for_godot.py -- \
  --src "tools/blender-mcp/input" --dst "assets/3d/godot" --embed-textures
```

---

## Step 4 — Import into Godot

1. Copy exported `*.glb` files to `assets/3d/`
2. Open Godot editor → import dialog auto-appears for new GLB files
3. Set import preset → `MeshLibrary` or `Scene`
4. Use in scene as `MeshInstance3D` or as library entries

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Timed out waiting for Blender response` | Blender not running / addon not connected | Start Blender, enable blender-mcp addon |
| `HTTP 400` from download tool | Wrong slug format (e.g. `"stone altar"` not `"stone_altar"`) | Use exact slug from `get-asset-from-polyhaven` discovery |
| `No suitable blend download URL` | PolyHaven has no blend for that asset | Try `file_format: "gltf"` instead |
| Terminal Python/curl to api.polyhaven.com times out | Network routing on this machine allows MCP server but not terminal shells | Use MCP tools only — Node.js fetch works, direct terminal downloads don't |

---

## PolyHaven API Structure Reference

```
GET https://api.polyhaven.com/files/{slug}
→ {
    "blend": {
      "2k": { "blend": { "url": "https://dl.polyhaven.org/...", "include": {...} } },
      "4k": { "blend": { "url": "...", "include": {...} } }
    },
    "gltf": {
      "2k": { "gltf": { "url": "https://dl.polyhaven.org/..." } }
    },
    "Diffuse": { "2k": { "jpg": {...}, "png": {...} } },   ← texture maps
    ...
  }
```

The `download-asset-from-polyhaven` tool traverses: `files["blend"][resolution]["blend"]["url"]`

---

## Files in this directory

| File | Purpose |
|------|---------|
| `blender_export_for_godot.py` | Blender batch exporter (OBJ/FBX/GLTF → GLB) |
| `download_polyhaven_assets.py` | Direct download script (requires terminal network access) |
| `polyhaven_asset_suggestions.json` | Initial asset search queries (pre-slug-discovery) |
| `input/` | Downloaded source assets (blend/gltf files) |
| `AGENTS.md` | Rules for agents modifying the blender-mcp server code |
| `readme.md` | blender-mcp server setup guide |
