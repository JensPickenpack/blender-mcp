# 3D Asset Pipeline (PolyHaven → Blender → Godot)

Kurz: Werkzeuge zum Besorgen und Konvertieren von 3D‑Props/Umgebungsstücken für das Projekt.

Inhalt:
- `polyhaven_asset_suggestions.json` — Suchbegriffe & Empfehlungen
- `blender_export_for_godot.py` — Blender‑Script zum Batch‑Import/Export nach `glb`

Workflow (Kurzfassung):

1. Suche/Downloade Assets (PolyHaven) in `tools/blender-mcp/input/` (je Asset eigener Ordner, entpackt).
2. Starte Blender im Hintergrund und führe `blender_export_for_godot.py` aus:

```bash
blender --background --python tools/blender-mcp/blender_export_for_godot.py -- \
  --src "tools/blender-mcp/input" --dst "assets/3d/godot" --embed-textures
```

3. Resultat: pro Asset eine `.glb` im Zielordner, bereit für `Godot` (importiere `.glb` in Godot Assets).

Hinweise:
- Blender muss die benötigten Import‑Addons haben (FBX/OBJ/GLTF sind standardmäßig verfügbar).
- Wenn Assets gezippt sind: entpacken bevor Sie das Script laufen lassen.
- Texture‑Auflösung: bevorzugt 2K/4K je nach Verwendung (props vs. hero‑prop).
- Exportoptionen können in `blender_export_for_godot.py` angepasst werden (Decimate/Scale/Embed).

Sicherheit:
- Das Script läuft innerhalb von Blender (es nutzt `bpy`). Verwende die `--` Trennung wie oben.

Wenn du möchtest, kann ich jetzt ein paar passende Assets automatisch herunterladen (PolyHaven). Soll ich das tun?
