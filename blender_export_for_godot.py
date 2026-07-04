"""
Batch import/export script for Blender -> glTF (GLB) for Godot

Run with Blender (example):
blender --background --python blender_export_for_godot.py -- --src "tools/blender-mcp/input" --dst "assets/3d/godot" --embed-textures

This script imports common formats (obj, fbx, gltf/glb) and exports a single glb per asset folder.
It can also unpack .zip archives found in the source.
"""
import os
import sys
import argparse
import tempfile
import shutil
import zipfile

def parse_args():
    parser = argparse.ArgumentParser(description='Batch import & export for Blender -> glb')
    parser.add_argument('--src', required=True, help='Source folder with subfolders per asset')
    parser.add_argument('--dst', required=True, help='Destination folder for exported .glb files')
    parser.add_argument('--scale', type=float, default=1.0, help='Uniform scale applied to imported objects')
    parser.add_argument('--embed-textures', action='store_true', help='Embed textures into GLB')
    return parser.parse_args()


def import_and_export_asset(asset_folder, out_file, scale=1.0, embed_textures=False):
    import bpy

    # Start fresh
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Find importable model file in folder
    candidates = []
    for root, _, files in os.walk(asset_folder):
        for f in files:
            if f.lower().endswith(('.obj', '.fbx', '.gltf', '.glb', '.dae')):
                candidates.append(os.path.join(root, f))

    if not candidates:
        print(f"  [SKIP] No importable file found in {asset_folder}")
        return False

    src = candidates[0]
    ext = os.path.splitext(src)[1].lower()
    print(f"  Importing {os.path.basename(src)}")

    try:
        if ext == '.obj':
            bpy.ops.import_scene.obj(filepath=src)
        elif ext == '.fbx':
            bpy.ops.import_scene.fbx(filepath=src)
        elif ext in ('.gltf', '.glb'):
            bpy.ops.import_scene.gltf(filepath=src)
        elif ext == '.dae':
            bpy.ops.wm.collada_import(filepath=src)
        else:
            print(f"  [WARN] Unsupported extension: {ext}")
            return False

        # Apply uniform scale
        for ob in bpy.context.selected_objects:
            ob.scale = (scale, scale, scale)

        # Optionally pack/embed textures
        export_kwargs = {
            'filepath': out_file,
            'export_format': 'GLB',
            'export_copyright': False,
            'export_embed_images': bool(embed_textures),
            'export_materials': 'EXPORT'
        }

        bpy.ops.export_scene.gltf(**export_kwargs)
        print(f"  Exported → {out_file}")
        return True
    except Exception as e:
        print(f"  [ERROR] Import/export failed for {asset_folder}: {e}")
        return False


def unpack_zip_if_needed(path, tmpdir):
    if path.lower().endswith('.zip'):
        try:
            with zipfile.ZipFile(path, 'r') as z:
                z.extractall(tmpdir)
            return tmpdir
        except Exception as e:
            print(f"  [ERROR] Failed to unpack {path}: {e}")
            return None
    return path


def main():
    args = parse_args()

    src = os.path.abspath(args.src)
    dst = os.path.abspath(args.dst)
    os.makedirs(dst, exist_ok=True)

    # Expect each direct child folder of src to contain one asset (or zip files)
    entries = sorted(os.listdir(src)) if os.path.isdir(src) else []
    if not entries:
        print('No assets found in', src)
        return

    for name in entries:
        path = os.path.join(src, name)
        # if file is a zip, unpack into tmp folder
        tmp = None
        try:
            if os.path.isfile(path) and path.lower().endswith('.zip'):
                tmp = tempfile.mkdtemp(prefix='poly_')
                folder = unpack_zip_if_needed(path, tmp)
            elif os.path.isdir(path):
                folder = path
            else:
                continue

            out_name = f"{name}.glb"
            out_file = os.path.join(dst, out_name)
            print(f"Processing asset: {name}")
            ok = import_and_export_asset(folder, out_file, scale=args.scale, embed_textures=args.embed_textures)
            if not ok:
                print(f"  Failed: {name}")
        finally:
            if tmp and os.path.isdir(tmp):
                shutil.rmtree(tmp)


if __name__ == '__main__':
    # This file must be run inside Blender (bpy is required). When running as standalone python this will fail gracefully.
    try:
        main()
    except Exception as e:
        print('This script is intended to run inside Blender using:')
        print('blender --background --python blender_export_for_godot.py -- --src <src> --dst <dst>')
        print('Error:', e)
