"""Извлечение ресурсов из установленного клиента Hearthstone (Unity).

Примеры:
    python hsextract.py scan                       # индекс всех ассетов -> out/index.csv
    python hsextract.py extract                    # текстуры, спрайты, звук, видео, шрифты, тексты
    python hsextract.py extract -t textures,sprites --bundle "cardtexture*"
    python hsextract.py extract -t audio --name "VO_" --out D:/hs_audio
    python hsextract.py extract -t all
    python hsextract.py extract -t textures --bundle "cardtexture*" --rgb   # арт карт без маски в альфе
"""
import argparse
import csv
import fnmatch
import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import UnityPy
from UnityPy.helpers.ResourceReader import get_resource_data

DEFAULT_GAME_DIR = r"D:\Hearthstone"

# категория -> типы Unity
CATEGORIES = {
    "textures": ["Texture2D"],
    "sprites": ["Sprite"],
    "audio": ["AudioClip"],
    "video": ["VideoClip"],
    "fonts": ["Font"],
    "text": ["TextAsset"],
    "meshes": ["Mesh"],
    "shaders": ["Shader"],
    "animations": ["AnimationClip", "AnimatorController", "AnimatorOverrideController"],
    "materials": ["Material"],
    "mono": ["MonoBehaviour"],
}
DEFAULT_CATEGORIES = ["textures", "sprites", "audio", "video", "fonts", "text"]
TYPE_TO_CATEGORY = {t: c for c, ts in CATEGORIES.items() for t in ts}
INDEX_TYPES = set(TYPE_TO_CATEGORY)


def find_game_dir() -> Path:
    if sys.platform == "win32":
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone",
            )
            return Path(winreg.QueryValueEx(key, "InstallLocation")[0])
        except OSError:
            pass
    return Path(DEFAULT_GAME_DIR)


def detect_unity_version(game: Path) -> str:
    """Blizzard вырезает версию из бандлов; берём её из globalgamemanagers."""
    head = (game / "Hearthstone_Data" / "globalgamemanagers").read_bytes()[:256]
    m = re.search(rb"\d{4,}\.\d+\.\d+[abfpx]\d+", head)
    if not m:
        sys.exit("Не удалось определить версию Unity, укажите --unity-version")
    return m.group().decode()


def collect_files(game: Path, pattern: str) -> list:
    files = sorted((game / "Data" / "Win").glob("*.unity3d"))
    data = game / "Hearthstone_Data"
    files += sorted(data.glob("*.assets")) + sorted(data.glob("level*")) + [data / "globalgamemanagers"]
    files = [f for f in files if f.is_file() and not f.name.endswith(".resS")]
    if pattern:
        files = [f for f in files if fnmatch.fnmatch(f.name.lower(), pattern.lower())]
    return files


def bundle_group(path: str) -> str:
    # cardtexture_base_global-0516e06c-texture-0.unity3d -> cardtexture_base_global
    return Path(path).name.split("-")[0].removesuffix(".unity3d")


_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(name: str) -> str:
    name = _BAD_CHARS.sub("_", name).strip(" .")
    return name[:150] or "unnamed"


def write_unique(directory: Path, name: str, ext: str, path_id: int, data: bytes) -> None:
    """Пишет файл, не перезаписывая одноимённые ассеты из других бандлов."""
    directory.mkdir(parents=True, exist_ok=True)
    base = safe_name(name)
    if base.lower().endswith(ext.lower()):
        base = base[: -len(ext)]
    for candidate in (f"{base}{ext}", f"{base}_{path_id}{ext}"):
        try:
            with open(directory / candidate, "xb") as f:
                f.write(data)
            return
        except FileExistsError:
            continue
    (directory / f"{base}_{path_id}{ext}").write_bytes(data)


STRIP_ALPHA = False  # у текстур карт альфа — маска эффектов, а не прозрачность


def image_bytes(img) -> bytes:
    from io import BytesIO

    if STRIP_ALPHA:
        img = img.convert("RGB")
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def to_json(obj) -> bytes:
    def default(v):
        if isinstance(v, (bytes, bytearray)):
            return v.hex() if len(v) <= 4096 else f"<{len(v)} bytes>"
        return str(v)

    return json.dumps(obj.read_typetree(), ensure_ascii=False, indent=1, default=default).encode("utf-8")


def export_object(obj, type_name: str, out_dir: Path) -> int:
    """Экспортирует один объект, возвращает число записанных файлов."""
    pid = obj.path_id
    if type_name in ("AnimationClip", "AnimatorController", "AnimatorOverrideController", "Material", "MonoBehaviour"):
        name = obj.peek_name() or f"{type_name}_{pid}"
        write_unique(out_dir, name, ".json", pid, to_json(obj))
        return 1

    data = obj.read()
    name = getattr(data, "m_Name", "") or f"{type_name}_{pid}"

    if type_name == "Texture2D":
        if not data.m_Width or not data.m_Height:
            return 0
        write_unique(out_dir, name, ".png", pid, image_bytes(data.image))
    elif type_name == "Sprite":
        write_unique(out_dir, name, ".png", pid, image_bytes(data.image))
    elif type_name == "AudioClip":
        samples = data.samples
        for i, (sname, wav) in enumerate(samples.items()):
            write_unique(out_dir, name if len(samples) == 1 else f"{name}_{i}", ".wav", pid, wav)
        return len(samples)
    elif type_name == "VideoClip":
        res = data.m_ExternalResources
        if not res.m_Size:
            return 0
        raw = get_resource_data(res.m_Source, obj.assets_file, res.m_Offset, res.m_Size)
        ext = Path(data.m_OriginalPath).suffix or ".mp4"
        write_unique(out_dir, name, ext, pid, bytes(raw))
    elif type_name == "Font":
        raw = bytes(data.m_FontData or b"")
        if not raw:
            return 0
        write_unique(out_dir, name, ".otf" if raw[:4] == b"OTTO" else ".ttf", pid, raw)
    elif type_name == "TextAsset":
        raw = data.m_Script
        raw = raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else bytes(raw)
        ext = Path(name).suffix
        if not ext:
            try:
                raw.decode("utf-8")
                ext = ".txt"
            except UnicodeDecodeError:
                ext = ".bytes"
        write_unique(out_dir, name, ext, pid, raw)
    elif type_name == "Mesh":
        write_unique(out_dir, name, ".obj", pid, data.export().encode("utf-8"))
    elif type_name == "Shader":
        write_unique(out_dir, name, ".shader", pid, data.export().encode("utf-8", "replace"))
    else:
        return 0
    return 1


def _init_worker(unity_version: str, strip_alpha: bool) -> None:
    import warnings

    global STRIP_ALPHA
    warnings.filterwarnings("ignore")
    UnityPy.config.FALLBACK_UNITY_VERSION = unity_version
    STRIP_ALPHA = strip_alpha


def process_bundle(path: str, mode: str, types: set, name_filter: str, out: str) -> dict:
    result = {"files": 0, "errors": [], "rows": []}
    try:
        env = UnityPy.load(path)
    except Exception as e:
        result["errors"].append(f"{path}\tLOAD\t{type(e).__name__}: {e}")
        return result
    group = bundle_group(path)
    bundle = Path(path).name
    for obj in env.objects:
        type_name = obj.type.name
        if type_name not in types:
            continue
        try:
            if mode == "scan":
                result["rows"].append((bundle, type_name, obj.peek_name() or "", obj.path_id))
                continue
            if name_filter and name_filter not in (obj.peek_name() or "").lower():
                continue
            out_dir = Path(out) / TYPE_TO_CATEGORY[type_name] / group
            result["files"] += export_object(obj, type_name, out_dir)
        except Exception as e:
            result["errors"].append(f"{path}\t{type_name}:{obj.path_id}\t{type(e).__name__}: {e}")
    return result


def main() -> None:
    p = argparse.ArgumentParser(description="Извлечение ресурсов Hearthstone")
    p.add_argument("mode", choices=["scan", "extract"], help="scan — индекс ассетов, extract — выгрузка")
    p.add_argument("-t", "--types", default=",".join(DEFAULT_CATEGORIES),
                   help=f"категории через запятую или all: {', '.join(CATEGORIES)}")
    p.add_argument("--bundle", default="", help='маска имени файла-бандла, например "cardtexture*"')
    p.add_argument("--name", default="", help="подстрока в имени ассета (без учёта регистра)")
    p.add_argument("--game", default=None, help="папка игры (по умолчанию из реестра)")
    p.add_argument("--out", default="out", help="папка для результата")
    p.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    p.add_argument("--rgb", action="store_true", help="сохранять картинки без альфа-канала (арт карт)")
    p.add_argument("--unity-version", default=None)
    args = p.parse_args()

    game = Path(args.game) if args.game else find_game_dir()
    if not (game / "Hearthstone_Data").is_dir():
        sys.exit(f"Не найдена игра в {game}, укажите --game")
    unity_version = args.unity_version or detect_unity_version(game)

    if args.mode == "scan":
        types = INDEX_TYPES
    else:
        cats = list(CATEGORIES) if args.types == "all" else [c.strip() for c in args.types.split(",")]
        unknown = [c for c in cats if c not in CATEGORIES]
        if unknown:
            sys.exit(f"Неизвестные категории: {unknown}. Доступны: {', '.join(CATEGORIES)}")
        types = {t for c in cats for t in CATEGORIES[c]}

    files = collect_files(game, args.bundle)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"Игра: {game} | Unity {unity_version} | файлов: {len(files)} | потоков: {args.jobs}")

    total_files, errors, rows = 0, [], []
    start = time.time()
    with ProcessPoolExecutor(args.jobs, initializer=_init_worker, initargs=(unity_version, args.rgb)) as pool:
        futures = [pool.submit(process_bundle, str(f), args.mode, types, args.name.lower(), str(out)) for f in files]
        for i, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            total_files += r["files"]
            errors += r["errors"]
            rows += r["rows"]
            if i % 100 == 0 or i == len(futures):
                print(f"  {i}/{len(futures)} бандлов, файлов: {total_files}, ошибок: {len(errors)}, {time.time() - start:.0f} c",
                      flush=True)

    if args.mode == "scan":
        rows.sort()
        with open(out / "index.csv", "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["bundle", "type", "name", "path_id"])
            w.writerows(rows)
        counts = {}
        for _, t, _, _ in rows:
            counts[t] = counts.get(t, 0) + 1
        print("Найдено:", ", ".join(f"{t}={n}" for t, n in sorted(counts.items(), key=lambda x: -x[1])))
        print(f"Индекс: {out / 'index.csv'}")
    else:
        print(f"Готово: {total_files} файлов в {out.resolve()}")
    if errors:
        (out / "errors.log").write_text("\n".join(errors), encoding="utf-8")
        print(f"Ошибок: {len(errors)}, подробности в {out / 'errors.log'}")


if __name__ == "__main__":
    main()
