"""Локальный сервер приложения: индекс ассетов, превью, данные и экспорт (UnityPy).

    python hsserver.py              # API + собранный интерфейс (web/out), открывает окно приложения
    python hsserver.py --dev        # только API, интерфейс — через `npm run dev` в web/
"""
import argparse
import io
import json
import mimetypes
import ntpath
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import warnings
import webbrowser
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import UnityPy
from PIL import Image
from UnityPy.files import BundleFile, SerializedFile
from UnityPy.helpers.ResourceReader import get_resource_data

import hsextract as hx

warnings.filterwarnings("ignore")

FROZEN = getattr(sys, "frozen", False)
ROOT = Path(__file__).resolve().parent
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", ROOT))
CACHE = Path(os.environ.get("HSAS_DATA_DIR") or
             (Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "HearthstoneAssetStudio" if FROZEN else ROOT / "cache"))
WEB_OUT = BUNDLE_DIR / "web" / "out"
DB_PATH = CACHE / "index.db"
LAST_SEEN = [time.time()]  # последний запрос от интерфейса — для автовыхода после закрытия окна

IMAGE_TYPES = {"Texture2D", "Sprite"}
TEXT_TYPES = {"TextAsset", "Shader", "Mesh"}
INDEX_TYPES = set(hx.INDEX_TYPES)
LIST_LIMIT = 2000  # сколько элементов массива отдавать в превью данных
JS_SAFE = 2**53

CFG = {"game": None, "unity": None, "export_dir": None, "jobs": max(1, (os.cpu_count() or 2) - 1)}
STATE = {"state": "idle", "done": 0, "total": 0, "message": "", "started": 0.0}


def kind_of(type_name: str) -> str:
    if type_name in IMAGE_TYPES:
        return "image"
    return {"AudioClip": "audio", "VideoClip": "video", "Font": "font"}.get(
        type_name, "text" if type_name in TEXT_TYPES else "data")


# ---------------------------------------------------------------- индекс

def simplify(name: str) -> str:
    return ntpath.basename(name).lower()


def scan_bundle(path: str):
    """Воркер: список CAB-файлов и именованных ассетов одного бандла."""
    try:
        env = UnityPy.load(path)
    except Exception as e:
        return path, [], [], f"{type(e).__name__}: {e}"
    cabs = []
    for f in env.files.values():
        if isinstance(f, BundleFile):
            cabs += [simplify(n) for n in f.files]
        else:
            cabs.append(simplify(path))
    rows = []
    for obj in env.objects:
        t = obj.type.name
        if t not in INDEX_TYPES:
            continue
        w = h = 0
        try:
            name = obj.peek_name() or ""
            if t == "Texture2D":
                d = obj.parse_as_dict()
                w, h = d.get("m_Width", 0), d.get("m_Height", 0)
            elif t == "Sprite":
                r = obj.parse_as_dict().get("m_Rect", {})
                w, h = round(r.get("width", 0)), round(r.get("height", 0))
        except Exception:
            name = ""
        rows.append((obj.path_id, t, name, w, h))
    return path, cabs, rows, ""


def _init_scan_worker(unity_version: str) -> None:
    warnings.filterwarnings("ignore")
    UnityPy.config.FALLBACK_UNITY_VERSION = unity_version


def game_signature(files) -> str:
    size = mtime = 0
    for f in files:
        st = f.stat()
        size += st.st_size
        mtime = max(mtime, st.st_mtime)
    return f"{CFG['game']}|{CFG['unity']}|{len(files)}|{size}|{int(mtime)}"


_tls = threading.local()
_db_generation = 0


def db() -> sqlite3.Connection:
    if getattr(_tls, "gen", None) != _db_generation or getattr(_tls, "conn", None) is None:
        _tls.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _tls.gen = _db_generation
    return _tls.conn


def db_ready() -> bool:
    return DB_PATH.exists()


def read_signature():
    if not DB_PATH.exists():
        return None
    try:
        con = sqlite3.connect(DB_PATH)
        row = con.execute("SELECT value FROM meta WHERE key='signature'").fetchone()
        con.close()
        return row[0] if row else None
    except sqlite3.Error:
        return None


def build_index(jobs: int) -> None:
    global _db_generation
    files = hx.collect_files(CFG["game"], "")
    STATE.update(state="indexing", done=0, total=len(files), message="", started=time.time())
    tmp = CACHE / "index.tmp.db"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE bundles(id INTEGER PRIMARY KEY, name TEXT UNIQUE, grp TEXT, path TEXT, size INTEGER, n INTEGER);
        CREATE TABLE cabs(cab TEXT PRIMARY KEY, bundle_id INTEGER);
        CREATE TABLE assets(bundle_id INTEGER, path_id INTEGER, type TEXT, name TEXT, w INTEGER, h INTEGER);
    """)
    errors = 0
    try:
        with ProcessPoolExecutor(jobs, initializer=_init_scan_worker, initargs=(CFG["unity"],)) as pool:
            futures = [pool.submit(scan_bundle, str(f)) for f in files]
            for fut in as_completed(futures):
                path, cabs, rows, err = fut.result()
                errors += bool(err)
                p = Path(path)
                cur = con.execute("INSERT INTO bundles(name, grp, path, size, n) VALUES (?,?,?,?,?)",
                                  (p.name, hx.bundle_group(path), path, p.stat().st_size, len(rows)))
                bid = cur.lastrowid
                con.executemany("INSERT OR IGNORE INTO cabs VALUES (?,?)", [(c, bid) for c in cabs])
                con.executemany("INSERT INTO assets VALUES (?,?,?,?,?,?)", [(bid, *r) for r in rows])
                STATE["done"] += 1
        con.executescript("""
            CREATE INDEX assets_bp ON assets(bundle_id, path_id);
            CREATE INDEX assets_type ON assets(type, bundle_id);
            CREATE INDEX bundles_grp ON bundles(grp);
        """)
        con.execute("INSERT INTO meta VALUES ('signature', ?)", (game_signature(files),))
        con.commit()
        con.close()
        os.replace(tmp, DB_PATH)
        _db_generation += 1
        STATE.update(state="ready", message=f"ошибок чтения: {errors}" if errors else "")
    except Exception as e:
        con.close()
        STATE.update(state="error", message=f"{type(e).__name__}: {e}")
        traceback.print_exc()


def ensure_index(jobs: int, force: bool = False) -> None:
    if STATE["state"] == "indexing":
        return
    files = hx.collect_files(CFG["game"], "")
    if not force and read_signature() == game_signature(files):
        STATE.update(state="ready")
        return
    threading.Thread(target=build_index, args=(jobs,), daemon=True).start()


def is_game_dir(path: Path) -> bool:
    try:
        return (path / "Hearthstone_Data").is_dir() and (path / "Data" / "Win").is_dir()
    except OSError:
        return False


def normalize_game_dir(path) -> "Path | None":
    """Принимает папку игры или папку, в которой лежит Hearthstone."""
    if not path:
        return None
    path = Path(str(path).strip().strip('"')).expanduser()
    for cand in (path, path / "Hearthstone", path.parent if path.name.lower() == "data" else path):
        if is_game_dir(cand):
            return cand.resolve()
    return None


def local_drives() -> list:
    """Буквы локальных дисков (без сетевых и CD, чтобы проверка не подвисала)."""
    if sys.platform != "win32":
        return []
    import ctypes
    import string

    mask = ctypes.windll.kernel32.GetLogicalDrives()
    drives = []
    for i, letter in enumerate(string.ascii_uppercase):
        if mask >> i & 1:
            root = f"{letter}:\\"
            if ctypes.windll.kernel32.GetDriveTypeW(root) in (2, 3):  # съёмный, жёсткий
                drives.append(root)
    return drives


def game_candidates(saved: str = "") -> list:
    out = []
    if saved:
        out.append(saved)
    if os.environ.get("HSAS_NO_AUTODETECT"):
        return out
    if sys.platform == "win32":
        import winreg

        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for sub in (r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone",
                        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone"):
                try:
                    with winreg.OpenKey(hive, sub) as key:
                        out.append(winreg.QueryValueEx(key, "InstallLocation")[0])
                except OSError:
                    pass
    # база установок Battle.net: пути лежат в ней открытым текстом
    db_file = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Battle.net" / "Agent" / "product.db"
    try:
        raw = db_file.read_bytes()
        out += [m.decode("utf-8", "ignore") for m in re.findall(rb"[A-Za-z]:[\\/][^\x00-\x1f\"<>|]{0,200}?[Hh]earthstone", raw)]
    except OSError:
        pass
    try:
        conf = json.loads((Path(os.environ.get("APPDATA", "")) / "Battle.net" / "Battle.net.config").read_text("utf-8"))
        default = conf.get("Client", {}).get("Install", {}).get("DefaultInstallPath")
        if default:
            out.append(str(Path(default) / "Hearthstone"))
    except (OSError, ValueError, AttributeError):
        pass
    rels = ["Hearthstone", r"Games\Hearthstone", r"Program Files (x86)\Hearthstone", r"Program Files\Hearthstone",
            r"Battle.net\Hearthstone", r"Blizzard\Hearthstone", r"Games\Blizzard\Hearthstone",
            r"Program Files (x86)\Battle.net\Hearthstone", r"Blizzard Games\Hearthstone"]
    out += [d + r for d in local_drives() for r in rels]
    return out


def find_game_dir(saved: str = "") -> "Path | None":
    for cand in game_candidates(saved):
        found = normalize_game_dir(cand)
        if found:
            return found
    return None


def set_game(path, jobs: int) -> Path:
    game = normalize_game_dir(path)
    if not game:
        raise ApiError(400, f"В папке «{path}» нет Hearthstone (ищу Hearthstone_Data и Data\\Win)")
    CFG.update(game=game, unity=hx.detect_unity_version(game))
    UnityPy.config.FALLBACK_UNITY_VERSION = CFG["unity"]
    ENVS.clear()
    save_settings()
    ensure_index(jobs)
    return game


def bundle_row(name: str):
    return db().execute("SELECT id, path FROM bundles WHERE name=?", (name,)).fetchone()


def bundle_by_cab(cab: str):
    return db().execute("SELECT b.name, b.path FROM cabs c JOIN bundles b ON b.id=c.bundle_id WHERE c.cab=?",
                        (cab,)).fetchone()


# ---------------------------------------------------------------- загрузка бандлов

class Loaded:
    def __init__(self, name: str, path: str):
        self.name = name
        self.lock = threading.RLock()
        self.env = UnityPy.load(path)
        self.own = []
        for f in list(self.env.files.values()):
            if isinstance(f, BundleFile):
                self.own += [x for x in f.files.values() if isinstance(x, SerializedFile)]
            elif isinstance(f, SerializedFile):
                self.own.append(f)
        self._attach_resolver()

    def _attach_resolver(self):
        """Зависимости (CAB из других бандлов) догружаются в то же окружение по индексу."""
        env = self.env
        original = env.find_file

        def find_file(name, is_dependency=True):
            cab = env.get_cab(name)
            if cab:
                return cab
            row = bundle_by_cab(simplify(name))
            if row:
                env.load_file(row[1])
                cab = env.get_cab(name)
                if cab:
                    return cab
            return original(name, is_dependency)

        env.find_file = find_file

    def obj(self, path_id: int):
        for sf in self.own:
            o = sf.objects.get(path_id)
            if o is not None:
                return o
        raise KeyError(f"объект {path_id} не найден в {self.name}")


class EnvCache:
    def __init__(self, size: int = 24):
        self.size = size
        self.lock = threading.Lock()
        self.items: "OrderedDict[str, Loaded]" = OrderedDict()
        self.loading: dict = {}

    def clear(self):
        with self.lock:
            self.items.clear()

    def get(self, name: str) -> Loaded:
        with self.lock:
            if name in self.items:
                self.items.move_to_end(name)
                return self.items[name]
            ev = self.loading.get(name)
            if ev is None:
                ev = self.loading[name] = threading.Event()
                owner = True
            else:
                owner = False
        if not owner:
            ev.wait()
            with self.lock:
                if name in self.items:
                    return self.items[name]
            return self.get(name)
        try:
            row = bundle_row(name)
            if not row:
                raise KeyError(f"бандл {name} не найден в индексе")
            loaded = Loaded(name, row[1])
            with self.lock:
                self.items[name] = loaded
                while len(self.items) > self.size:
                    self.items.popitem(last=False)
            return loaded
        finally:
            with self.lock:
                self.loading.pop(name, None)
            ev.set()


ENVS = EnvCache()


# ---------------------------------------------------------------- данные объектов

def lookup_asset(bundle: str, path_id: int):
    return db().execute(
        "SELECT a.type, a.name FROM assets a JOIN bundles b ON b.id=a.bundle_id WHERE b.name=? AND a.path_id=?",
        (bundle, path_id)).fetchone()


def resolve_ref(loaded: Loaded, sf, file_id: int, path_id: int):
    if not path_id:
        return None
    if file_id == 0:
        bundle = loaded.name
    else:
        try:
            ext = sf.externals[file_id - 1].path
        except (IndexError, AttributeError):
            return None
        row = bundle_by_cab(simplify(ext))
        if not row:
            return {"ext": ext, "p": str(path_id)}
        bundle = row[0]
    ref = {"b": bundle, "p": str(path_id)}
    hit = lookup_asset(bundle, path_id)
    if hit:
        ref["t"], ref["n"] = hit
    return ref


def annotate(node, loaded: Loaded, sf, limit: int):
    if isinstance(node, dict):
        if "m_FileID" in node and "m_PathID" in node and len(node) == 2:
            ref = resolve_ref(loaded, sf, node["m_FileID"], node["m_PathID"])
            out = {"m_FileID": node["m_FileID"], "m_PathID": str(node["m_PathID"])}
            if ref:
                out["$ref"] = ref
            return out
        return {k: annotate(v, loaded, sf, limit) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        items = [annotate(v, loaded, sf, limit) for v in node[:limit]] if limit else \
            [annotate(v, loaded, sf, limit) for v in node]
        if limit and len(node) > limit:
            items.append(f"… ещё {len(node) - limit} элементов (полностью — в экспорте)")
        return items
    if isinstance(node, (bytes, bytearray, memoryview)):
        b = bytes(node)
        return b.hex() if len(b) <= 256 else f"<{len(b)} байт>"
    if isinstance(node, int) and not isinstance(node, bool) and abs(node) >= JS_SAFE:
        return str(node)
    if isinstance(node, float) and node != node:
        return "NaN"
    if isinstance(node, str) and len(node) > 20000:
        return node[:20000] + f"… (+{len(node) - 20000} символов)"
    return node


def object_data(loaded: Loaded, obj, limit: int = LIST_LIMIT):
    tree = obj.read_typetree()
    return annotate(tree, loaded, obj.assets_file, limit)


def object_info(loaded: Loaded, obj) -> dict:
    t = obj.type.name
    info = {"b": loaded.name, "p": str(obj.path_id), "type": t, "kind": kind_of(t),
            "name": obj.peek_name() or "", "size": obj.byte_size, "props": {}}
    props = info["props"]
    try:
        if t == "Texture2D":
            d = obj.read()
            props.update(width=d.m_Width, height=d.m_Height, format=_enum_name(d.m_TextureFormat),
                         mips=getattr(d, "m_MipCount", None))
            props["alpha"] = alpha_mode(asset_image(obj))
        elif t == "Sprite":
            d = obj.read()
            r = d.m_Rect
            props.update(width=round(r.width), height=round(r.height))
            props["alpha"] = alpha_mode(asset_image(obj))
            tex = d.m_RD.texture
            props["texture"] = resolve_ref(loaded, obj.assets_file, tex.m_FileID, tex.m_PathID)
        elif t == "AudioClip":
            d = obj.read()
            props.update(length=round(getattr(d, "m_Length", 0), 2), frequency=getattr(d, "m_Frequency", None),
                         channels=getattr(d, "m_Channels", None))
        elif t == "VideoClip":
            d = obj.read()
            props.update(width=d.Width, height=d.Height, frames=d.m_FrameCount, fps=round(d.m_FrameRate, 2),
                         source=d.m_OriginalPath)
        elif t == "Mesh":
            d = obj.parse_as_dict()
            props.update(vertices=d.get("m_VertexData", {}).get("m_VertexCount"),
                         submeshes=len(d.get("m_SubMeshes", [])))
        elif t == "AnimationClip":
            d = obj.parse_as_dict()
            mc = d.get("m_MuscleClip", {})
            props.update(length=round(mc.get("m_StopTime", 0) - mc.get("m_StartTime", 0), 3),
                         sampleRate=d.get("m_SampleRate"), loop=mc.get("m_LoopTime"),
                         bindings=len(d.get("m_ClipBindingConstant", {}).get("genericBindings", [])))
        elif t == "Material":
            d = obj.parse_as_dict()
            sh = d.get("m_Shader", {})
            props["shader"] = resolve_ref(loaded, obj.assets_file, sh.get("m_FileID", 0), sh.get("m_PathID", 0))
            texs = []
            for name, env in d.get("m_SavedProperties", {}).get("m_TexEnvs", []):
                tx = env.get("m_Texture", {})
                ref = resolve_ref(loaded, obj.assets_file, tx.get("m_FileID", 0), tx.get("m_PathID", 0))
                if ref:
                    texs.append({"slot": name, **ref})
            props["textures"] = texs
        elif t == "MonoBehaviour":
            d = obj.parse_as_dict()
            sc = d.get("m_Script", {})
            ref = resolve_ref(loaded, obj.assets_file, sc.get("m_FileID", 0), sc.get("m_PathID", 0))
            if ref and "b" in ref:
                try:
                    script = ENVS.get(ref["b"]).obj(int(ref["p"])).parse_as_dict()
                    props["script"] = ".".join(x for x in (script.get("m_Namespace"), script.get("m_ClassName")) if x)
                except Exception:
                    pass
        elif t == "Font":
            d = obj.read()
            props["bytes"] = len(d.m_FontData or b"")
    except Exception as e:
        props["error"] = f"{type(e).__name__}: {e}"
    return info


def _enum_name(v):
    from UnityPy.enums import TextureFormat

    try:
        return TextureFormat(v).name
    except ValueError:
        return getattr(v, "name", str(v))


def list_objects(loaded: Loaded) -> list:
    out = []
    for sf in loaded.own:
        for pid, obj in sf.objects.items():
            t = obj.type.name
            name = ""
            try:
                name = obj.peek_name() or ""
                if not name and t == "GameObject":
                    name = obj.parse_as_dict().get("m_Name", "")
            except Exception:
                pass
            out.append({"p": str(pid), "t": t, "n": name})
    return out


# ---------------------------------------------------------------- рендер и экспорт

_images: "OrderedDict[tuple, Image.Image]" = OrderedDict()
_images_lock = threading.Lock()


def asset_image(obj) -> Image.Image:
    """Декодированная картинка; последние несколько держим в памяти (превью, элементы, экспорт)."""
    key = (id(obj.assets_file), obj.path_id)
    with _images_lock:
        if key in _images:
            _images.move_to_end(key)
            return _images[key]
    d = obj.read()
    if obj.type.name == "Texture2D" and (not d.m_Width or not d.m_Height):
        raise ValueError("пустая текстура")
    img = d.image
    with _images_lock:
        _images[key] = img
        while len(_images) > 12:
            _images.popitem(last=False)
    return img


def alpha_mode(img: Image.Image) -> str:
    """none — альфы нет; transparent — настоящая прозрачность; mask — альфа используется как маска
    (нет ни одного прозрачного пикселя, но альфа меняется: так устроен арт карт)."""
    if img.mode not in ("RGBA", "LA"):
        return "none"
    lo, hi = img.getchannel("A").getextrema()
    if lo == 255:
        return "none"
    return "mask" if lo > 0 else "transparent"


def apply_image_opts(img: Image.Image, o: dict) -> Image.Image:
    crop = o.get("crop")
    if crop:
        x, y, w, h = (int(v) for v in crop)
        img = img.crop((x, y, x + w, y + h))
    alpha = o.get("alpha") or ("drop" if o.get("rgb") else "keep")
    if alpha == "drop" or (alpha == "auto" and alpha_mode(img) == "mask"):
        img = img.convert("RGB")
    if o.get("trim") and img.mode in ("RGBA", "LA"):
        bbox = img.getchannel("A").getbbox()
        if bbox:
            img = img.crop(bbox)
    pad = int(o.get("pad") or 0)
    if pad > 0:
        canvas = Image.new(img.mode, (img.width + 2 * pad, img.height + 2 * pad))
        canvas.paste(img, (pad, pad))
        img = canvas
    scale = float(o.get("scale") or 1)
    if scale != 1:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    return img


def encode_image(img: Image.Image, fmt: str) -> tuple:
    buf = io.BytesIO()
    if fmt == "jpg":
        if img.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGB", img.size, (0, 0, 0))
            rgba = img.convert("RGBA")
            bg.paste(rgba, mask=rgba.getchannel("A"))
            img = bg
        img.save(buf, "JPEG", quality=95)
        return buf.getvalue(), "image/jpeg", ".jpg"
    if fmt == "webp":
        img.save(buf, "WEBP", lossless=True)
        return buf.getvalue(), "image/webp", ".webp"
    img.save(buf, "PNG")
    return buf.getvalue(), "image/png", ".png"


def media_bytes(obj) -> tuple:
    """(байты, расширение) исходного видео или звука (WAV, декодированный без потерь)."""
    d = obj.read()
    if obj.type.name == "VideoClip":
        res = d.m_ExternalResources
        data = bytes(get_resource_data(res.m_Source, obj.assets_file, res.m_Offset, res.m_Size))
        return data, Path(d.m_OriginalPath).suffix or ".mp4"
    samples = d.samples
    if not samples:
        raise ValueError("клип без сэмплов")
    return next(iter(samples.values())), ".wav"


def media_cache_file(loaded: Loaded, obj) -> Path:
    """Для превью видео и звук кешируются на диск, чтобы отдавать их с поддержкой Range."""
    ext = expected_ext(obj, {})
    path = CACHE / "media" / f"{hx.safe_name(loaded.name)}_{obj.path_id}{ext}"
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    data, _ = media_bytes(obj)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return path


def render(loaded: Loaded, obj, opts: dict, full_data: bool = False) -> tuple:
    """-> (bytes | Path, mime, ext)"""
    t = obj.type.name
    k = kind_of(t)
    if k == "image":
        img = apply_image_opts(asset_image(obj), opts)
        return encode_image(img, opts.get("format", "png"))
    if k in ("audio", "video"):
        if full_data:
            data, ext = media_bytes(obj)
            return data, mimetypes.guess_type("x" + ext)[0] or "application/octet-stream", ext
        p = media_cache_file(loaded, obj)
        return p, mimetypes.guess_type(p.name)[0] or "application/octet-stream", p.suffix
    if t == "Font":
        raw = bytes(obj.read().m_FontData or b"")
        if not raw:
            raise ValueError("шрифт без данных (динамическая ссылка)")
        return raw, "font/otf" if raw[:4] == b"OTTO" else "font/ttf", ".otf" if raw[:4] == b"OTTO" else ".ttf"
    if t == "TextAsset":
        raw = obj.read().m_Script
        raw = raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else bytes(raw)
        try:
            raw.decode("utf-8")
            return raw, "text/plain; charset=utf-8", Path(obj.peek_name() or "").suffix or ".txt"
        except UnicodeDecodeError:
            return raw, "application/octet-stream", ".bytes"
    if t == "Shader":
        return obj.read().export().encode("utf-8", "replace"), "text/plain; charset=utf-8", ".shader"
    if t == "Mesh":
        return obj.read().export().encode("utf-8"), "text/plain; charset=utf-8", ".obj"
    data = object_data(loaded, obj, 0 if full_data else LIST_LIMIT)
    return json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8"), "application/json", ".json"


CATEGORY_DIRS = {
    "textures": "Текстуры", "sprites": "Спрайты", "audio": "Звуки", "video": "Видео", "fonts": "Шрифты",
    "text": "Тексты", "meshes": "Меши", "shaders": "Шейдеры", "animations": "Анимации",
    "materials": "Материалы", "mono": "Скрипты",
}


class Skipped(Exception):
    pass


class Cancelled(Exception):
    pass


def write_new(directory: Path, base: str, ext: str, data) -> Path:
    """Атомарно создаёт файл с уникальным именем (параллельные потоки не перезаписывают друг друга)."""
    directory.mkdir(parents=True, exist_ok=True)
    base = hx.safe_name(base)
    if ext and base.lower().endswith(ext.lower()):
        base = base[: -len(ext)]
    i = 1
    while True:
        target = directory / (f"{base}{ext}" if i == 1 else f"{base} ({i}){ext}")
        try:
            with open(target, "xb") as f:
                if isinstance(data, Path):
                    with open(data, "rb") as src:
                        shutil.copyfileobj(src, f, 1 << 20)
                else:
                    f.write(data)
            return target
        except FileExistsError:
            i += 1


def unique_path(directory: Path, base: str, ext: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    base = hx.safe_name(base)
    if ext and base.lower().endswith(ext.lower()):
        base = base[: -len(ext)]
    p = directory / f"{base}{ext}"
    i = 2
    while p.exists():
        p = directory / f"{base} ({i}){ext}"
        i += 1
    return p


def expected_ext(obj, opts: dict) -> str:
    t = obj.type.name
    if t in IMAGE_TYPES:
        return {"webp": ".webp", "jpg": ".jpg"}.get(opts.get("format"), ".png")
    if t == "AudioClip":
        return ".wav"
    if t == "VideoClip":
        return Path(obj.read().m_OriginalPath).suffix or ".mp4"
    if t == "Font":
        return ".ttf"
    if t == "TextAsset":
        return Path(obj.peek_name() or "").suffix or ".txt"
    return {"Shader": ".shader", "Mesh": ".obj"}.get(t, ".json")


def export_dir_for(item: dict, type_name: str, subdir: str, layout: str) -> Path:
    base = export_root() / subdir
    if layout != "tree":
        return base
    cat = hx.TYPE_TO_CATEGORY.get(type_name)
    folder = CATEGORY_DIRS[cat] if cat else str(Path("Прочее") / type_name)
    return base / folder / (item.get("g") or hx.bundle_group(item["b"]))


def export_one(item: dict, opts: dict, subdir: str, layout: str = "flat", skip_existing: bool = False) -> str:
    """item: {b, p, crop?: [x, y, w, h], suffix?: str} — crop вырезает фрагмент (элемент атласа)."""
    loaded = ENVS.get(item["b"])
    path_id = int(item["p"])
    if item.get("crop"):
        opts = {**opts, "crop": item["crop"]}
    with loaded.lock:
        obj = loaded.obj(path_id)
        name = obj.peek_name() or f"{obj.type.name}_{path_id}"
        if item.get("suffix"):
            name = f"{name}_{item['suffix']}"
        directory = export_dir_for(item, obj.type.name, subdir, layout)
        if skip_existing:
            ext = expected_ext(obj, opts)
            base = hx.safe_name(name)
            if (directory / (base if base.lower().endswith(ext.lower()) else base + ext)).exists():
                raise Skipped()
        data, _, ext = render(loaded, obj, opts, full_data=True)
    return str(write_new(directory, name, ext, data))


def copy_bundle(item: dict, opts: dict, subdir: str, layout: str = "flat", skip_existing: bool = False) -> str:
    """Исходный файл бандла как есть (.unity3d / .assets)."""
    row = bundle_row(item["b"])
    if not row:
        raise KeyError(f"бандл {item['b']} не найден")
    src = Path(row[1])
    directory = export_root() / subdir / hx.bundle_group(item["b"])
    if skip_existing and (directory / src.name).exists():
        raise Skipped()
    return str(write_new(directory, src.stem, src.suffix, src))


def export_root() -> Path:
    return Path(CFG["export_dir"])


JOBS: "OrderedDict[str, dict]" = OrderedDict()


def start_export_job(items: list, opts: dict, subdir: str, layout: str = "flat", skip_existing: bool = False,
                     worker=None) -> dict:
    """Экспорт идёт в фоне; интерфейс опрашивает /api/job, может отменить через /api/job_cancel."""
    import uuid

    worker = worker or export_one
    job = {"id": uuid.uuid4().hex[:10], "state": "running", "done": 0, "total": len(items), "count": 0,
           "skipped": 0, "cancelled": 0, "files": [], "errors": [], "errorCount": 0, "dir": str(export_root() / subdir),
           "cancel": False}
    JOBS[job["id"]] = job
    while len(JOBS) > 30:
        JOBS.popitem(last=False)

    if skip_existing and worker is export_one:
        # одноимённые ассеты в одной папке получают path_id в имени: так имя детерминировано
        # и докачка не примет второй «Glow» за уже скачанный первый
        def key(it):
            if layout != "tree":
                return (it.get("n") or "").lower()
            t = it.get("t", "")
            return (hx.TYPE_TO_CATEGORY.get(t, t), it.get("g") or hx.bundle_group(it["b"]), (it.get("n") or "").lower())

        from collections import Counter

        counts = Counter(key(it) for it in items if it.get("n"))
        items = [{**it, "suffix": it["p"]} if it.get("n") and not it.get("suffix") and counts[key(it)] > 1 else it
                 for it in items]

    def task(it):
        if job["cancel"]:
            raise Cancelled()
        return worker(it, opts, subdir, layout, skip_existing)

    def run():
        # по бандлам подряд, чтобы каждый бандл загружался один раз
        ordered = sorted(items, key=lambda it: (it["b"], str(it.get("suffix", ""))))
        with ThreadPoolExecutor(4) as pool:
            futs = {pool.submit(task, it): it for it in ordered}
            for fut in as_completed(futs):
                try:
                    path = fut.result()
                    job["count"] += 1
                    if len(job["files"]) < 50:
                        job["files"].append(path)
                except Cancelled:
                    job["cancelled"] += 1
                except Skipped:
                    job["skipped"] += 1
                except Exception as e:
                    it = futs[fut]
                    job["errorCount"] += 1
                    if len(job["errors"]) < 200:
                        job["errors"].append(f"{it['b']}:{it['p']} — {type(e).__name__}: {e}")
                job["done"] += 1
        job["files"].sort()
        job["state"] = "cancelled" if job["cancel"] else "done"

    threading.Thread(target=run, daemon=True).start()
    return job


def search_all(query: dict, cap: int = 500_000) -> list:
    items, offset = [], 0
    while len(items) < cap:
        page = search({**query, "limit": 20000, "offset": offset})["items"]
        items += page
        offset += len(page)
        if len(page) < 20000:
            break
    return items[:cap]


def hierarchy(loaded: Loaded, obj) -> dict:
    """Дерево префаба: корень по цепочке Transform.m_Father, дети — по m_Children."""
    objects = obj.assets_file.objects

    def tree(pid):
        o = objects.get(pid)
        return o.parse_as_dict() if o is not None else None

    def transform_of(go: dict):
        for c in go.get("m_Component", []):
            ref = c.get("component", {})
            o = objects.get(ref.get("m_PathID")) if ref.get("m_FileID") == 0 else None
            if o is not None and o.type.name in ("Transform", "RectTransform"):
                return o.parse_as_dict()
        return None

    if obj.type.name == "GameObject":
        go_pid = obj.path_id
    else:
        go_pid = obj.parse_as_dict().get("m_GameObject", {}).get("m_PathID")
        if not go_pid:
            raise ValueError("объект не принадлежит GameObject")
    selected = go_pid
    tr = transform_of(tree(go_pid) or {})
    guard = 0
    while tr and tr.get("m_Father", {}).get("m_PathID") and tr["m_Father"].get("m_FileID") == 0 and guard < 200:
        father = tree(tr["m_Father"]["m_PathID"])
        if not father:
            break
        go_pid = father["m_GameObject"]["m_PathID"]
        tr = father
        guard += 1

    count = [0]

    def node(pid):
        count[0] += 1
        go = tree(pid) or {}
        comps = []
        for c in go.get("m_Component", []):
            ref = c.get("component", {})
            o = objects.get(ref.get("m_PathID")) if ref.get("m_FileID") == 0 else None
            if o is not None:
                comps.append({"t": o.type.name, "p": str(ref["m_PathID"])})
        out = {"p": str(pid), "n": go.get("m_Name", ""), "active": bool(go.get("m_IsActive", 1)), "c": comps,
               "children": []}
        trd = transform_of(go)
        if trd:
            for ch in trd.get("m_Children", []):
                if ch.get("m_FileID") == 0 and count[0] < 5000:
                    child = tree(ch["m_PathID"])
                    if child:
                        out["children"].append(node(child["m_GameObject"]["m_PathID"]))
        return out

    return {"b": loaded.name, "root": node(go_pid), "selected": str(selected), "nodes": count[0]}


def find_islands(img: Image.Image, threshold: int = 32, merge: int = 2, min_size: int = 12) -> list:
    """Отдельные элементы атласа: связные области непрозрачных пикселей (с небольшим слиянием соседей)."""
    import numpy as np
    from scipy import ndimage

    if alpha_mode(img) != "transparent":
        return []
    mask = np.asarray(img.getchannel("A")) > threshold
    grown = ndimage.binary_dilation(mask, iterations=merge) if merge else mask
    labels, _ = ndimage.label(grown)
    boxes = []
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        if sl is None:
            continue
        own = mask[sl] & (labels[sl] == i)
        ys, xs = np.nonzero(own.any(axis=1))[0], np.nonzero(own.any(axis=0))[0]
        if not len(ys):
            continue
        x0, y0 = sl[1].start + int(xs[0]), sl[0].start + int(ys[0])
        w, h = int(xs[-1] - xs[0] + 1), int(ys[-1] - ys[0] + 1)
        if w >= min_size and h >= min_size:
            boxes.append([x0, y0, w, h])
    # порядок чтения: полосами сверху вниз, внутри полосы слева направо
    band = max(16, img.height // 64)
    boxes.sort(key=lambda b: (b[1] // band, b[0]))
    return boxes[:3000]


def guess_grid(img: Image.Image) -> dict:
    """Сетка спрайт-листа по автокорреляции: сдвиг на ширину кадра даёт сходство,
    сдвиг на полкадра — нет. Возвращает лучшие cols/rows."""
    import numpy as np

    small = img.convert("RGBA")
    small.thumbnail((512, 512))
    a = np.asarray(small, dtype=np.float32) / 255
    transparent = alpha_mode(img) == "transparent"
    lum = a[..., :3].mean(-1) * (a[..., 3] if transparent else 1)
    # у непрозрачных картинок (арт, фоны) соседние области похожи и без сетки — порог строже
    threshold = 0.08 if transparent else 0.3

    def corr(arr, s):
        if s <= 0 or s >= arr.shape[1]:
            return 0.0
        x, y = arr[:, :-s].ravel(), arr[:, s:].ravel()
        if x.std() < 1e-6 or y.std() < 1e-6:
            return 0.0
        return float(np.corrcoef(x, y)[0, 1])

    def best(arr, full):
        size = arr.shape[1]
        scored = []
        for n in range(2, 17):
            s = size / n
            if s < 6:
                break
            score = corr(arr, round(s)) - max(corr(arr, round(s / 2)), corr(arr, round(s * 1.5)))
            if full % n:
                score -= 0.05
            scored.append((score, n))
        top = max(scored, default=(0, 1))
        return (top[1] if top[0] > threshold else 1), round(top[0], 3)

    cols, sx = best(lum, img.width)
    rows, sy = best(lum.T, img.height)
    return {"cols": cols, "rows": rows, "scoreX": sx, "scoreY": sy}


def flipbook(req: dict) -> dict:
    loaded = ENVS.get(req["b"])
    with loaded.lock:
        obj = loaded.obj(int(req["p"]))
        name = obj.peek_name() or f"flipbook_{obj.path_id}"
        img = asset_image(obj).convert("RGBA")
    cols, rows = max(1, int(req.get("cols", 4))), max(1, int(req.get("rows", 4)))
    count = int(req.get("count") or cols * rows)
    fw, fh = img.width // cols, img.height // rows
    frames = []
    for i in range(min(count, cols * rows)):
        x, y = (i % cols) * fw, (i // cols) * fh
        frames.append(img.crop((x, y, x + fw, y + fh)))
    opts = {k: req.get(k) for k in ("scale", "alpha", "pad")}
    frames = [apply_image_opts(f, opts) for f in frames]
    if req.get("trim"):
        bbox = None
        for f in frames:
            b = f.getchannel("A").getbbox() if f.mode == "RGBA" else None
            if b:
                bbox = b if bbox is None else (min(bbox[0], b[0]), min(bbox[1], b[1]), max(bbox[2], b[2]), max(bbox[3], b[3]))
        if bbox:
            frames = [f.crop(bbox) for f in frames]
    fps = max(1, min(60, int(req.get("fps", 24))))
    duration = round(1000 / fps)
    fmt = req.get("format", "webp")
    subdir = req.get("subdir") or "Анимации"
    if fmt == "frames":
        folder = unique_path(export_root() / subdir, name, "")
        folder.mkdir(parents=True)
        for i, f in enumerate(frames):
            f.save(folder / f"{hx.safe_name(name)}_{i:03d}.png")
        return {"files": [str(folder)], "dir": str(folder.parent), "errors": []}
    buf = io.BytesIO()
    if fmt == "gif":
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=duration, loop=0,
                       disposal=2, transparency=0, optimize=False)
        ext = ".gif"
    elif fmt == "apng":
        frames[0].save(buf, "PNG", save_all=True, append_images=frames[1:], duration=duration, loop=0, disposal=1)
        ext = ".png"
    else:
        frames[0].save(buf, "WEBP", save_all=True, append_images=frames[1:], duration=duration, loop=0, lossless=True)
        ext = ".webp"
    target = unique_path(export_root() / subdir, name, ext)
    target.write_bytes(buf.getvalue())
    return {"files": [str(target)], "dir": str(target.parent), "errors": []}


def thumbnail(bundle: str, path_id: int, size: int) -> Path:
    path = CACHE / "thumbs" / hx.safe_name(bundle) / f"{path_id}_{size}_v2.webp"
    if path.exists():
        return path
    loaded = ENVS.get(bundle)
    with loaded.lock:
        img = asset_image(loaded.obj(path_id))
    img = img.convert("RGB") if alpha_mode(img) == "mask" else img.copy()
    img.thumbnail((size, size), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    img.save(tmp, "WEBP", quality=88)
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------- поиск

GROUP_PRESETS = {
    "ui": ["initial", "essential"],
    "cards": ["cardtexture"],
    "portraits": ["portpremium"],
}


def search(q: dict) -> dict:
    where, args = [], []
    text = (q.get("q") or "").strip()
    if text:
        for word in text.split():
            where.append("a.name LIKE ?")
            args.append(f"%{word}%")
    types = [t for t in (q.get("types") or "").split(",") if t]
    if types:
        where.append(f"a.type IN ({','.join('?' * len(types))})")
        args += types
    if q.get("grp"):
        where.append("b.grp = ?")
        args.append(q["grp"])
    if q.get("bundle"):
        where.append("b.name = ?")
        args.append(q["bundle"])
    prefixes = []
    for g in (q.get("groups") or "").split(","):
        prefixes += GROUP_PRESETS.get(g, [g] if g else [])
    if prefixes:
        where.append("(" + " OR ".join("b.grp LIKE ?" for _ in prefixes) + ")")
        args += [f"{p}%" for p in prefixes]
    lang = q.get("lang")
    if lang:
        where.append("(b.grp LIKE ? OR b.grp LIKE '%_global' OR b.grp NOT LIKE '%\\_%' ESCAPE '\\')")
        args.append(f"%_{lang}")
    min_size = int(q.get("min") or 0)
    if min_size:
        where.append("MAX(a.w, a.h) >= ?")
        args.append(min_size)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    order = {"size": "a.w * a.h DESC", "bundle": "b.name, a.name"}.get(q.get("sort"), "a.name COLLATE NOCASE")
    limit = min(int(q.get("limit") or 200), 20000)
    offset = int(q.get("offset") or 0)
    con = db()
    total = con.execute(f"SELECT COUNT(*) FROM assets a JOIN bundles b ON b.id=a.bundle_id {clause}", args).fetchone()[0]
    rows = con.execute(
        f"SELECT b.name, b.grp, a.path_id, a.type, a.name, a.w, a.h FROM assets a JOIN bundles b ON b.id=a.bundle_id "
        f"{clause} ORDER BY {order} LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
    return {"total": total, "items": [
        {"b": r[0], "g": r[1], "p": str(r[2]), "t": r[3], "n": r[4], "w": r[5], "h": r[6]} for r in rows]}


# ---------------------------------------------------------------- HTTP

class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "hsserver"

    def log_message(self, fmt, *args):
        if os.environ.get("HS_VERBOSE"):
            super().log_message(fmt, *args)

    # -- ответы
    def send_bytes(self, data: bytes, mime: str, status: int = 200, cache: bool = False, filename: str = ""):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        if filename:
            from urllib.parse import quote
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, obj, status: int = 200):
        self.send_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def send_file(self, path: Path, mime: str = "", cache: bool = True):
        size = path.stat().st_size
        mime = mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                    return
                remaining -= len(chunk)

    # -- маршруты
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method: str):
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if url.path.startswith("/api/"):
                body = {}
                if method == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n) or b"{}")
                route = url.path[5:]
                fn = getattr(self, f"api_{route.replace('/', '_')}", None)
                if fn is None:
                    raise ApiError(404, f"нет маршрута {url.path}")
                LAST_SEEN[0] = time.time()
                if CFG["game"] is None and route not in ("status", "set_game", "pick_game"):
                    raise ApiError(503, "папка игры не выбрана")
                if route not in ("status", "reindex", "set_game", "pick_game") and not db_ready():
                    raise ApiError(503, "индекс ещё строится")
                fn(q, body)
            else:
                self.serve_static(url.path)
        except ApiError as e:
            self.send_json({"error": str(e)}, e.status)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass
        except KeyError as e:
            self.send_json({"error": str(e).strip("'\"")}, 404)
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def serve_static(self, path: str):
        if not WEB_OUT.exists():
            self.send_bytes("Интерфейс не собран: выполните `npm run build` в web/ или запустите `npm run dev`."
                            .encode("utf-8"), "text/plain; charset=utf-8", 404)
            return
        rel = path.lstrip("/") or "index.html"
        target = (WEB_OUT / rel).resolve()
        if WEB_OUT.resolve() not in target.parents and target != WEB_OUT.resolve():
            raise ApiError(403, "запрещено")
        if target.is_dir():
            target = target / "index.html"
        if not target.exists() and (target.with_suffix(".html")).exists():
            target = target.with_suffix(".html")
        if not target.exists():
            target = WEB_OUT / "index.html"
        self.send_file(target, cache="/_next/static/" in path)

    def _obj(self, q):
        loaded = ENVS.get(q["b"])
        return loaded, loaded.obj(int(q["p"]))

    def api_status(self, q, body):
        counts = {}
        if db_ready() and STATE["state"] != "indexing":
            counts = dict(db().execute("SELECT type, COUNT(*) FROM assets GROUP BY type").fetchall())
        state = STATE if CFG["game"] else {**STATE, "state": "nogame"}
        self.send_json({**state, "ready": bool(CFG["game"]) and db_ready(), "game": str(CFG["game"] or ""),
                        "unity": CFG["unity"], "exportDir": str(export_root()), "counts": counts})

    def api_set_game(self, q, body):
        game = set_game(body.get("path", ""), CFG["jobs"])
        self.send_json({"game": str(game)})

    _pick_lock = threading.Lock()

    def api_pick_game(self, q, body):
        """Системный диалог выбора папки (окно приложения — браузер, у него нет доступа к путям)."""
        import tkinter as tk
        from tkinter import filedialog

        with self._pick_lock:
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askdirectory(title="Выберите папку Hearthstone", mustexist=True)
            root.destroy()
        self.send_json({"path": path or ""})

    def api_reindex(self, q, body):
        ensure_index(body.get("jobs") or max(1, (os.cpu_count() or 2) - 1), force=True)
        self.send_json({"ok": True})

    def api_groups(self, q, body):
        rows = db().execute("SELECT grp, COUNT(*), SUM(n), SUM(size) FROM bundles GROUP BY grp ORDER BY grp").fetchall()
        self.send_json([{"g": r[0], "bundles": r[1], "assets": r[2], "size": r[3]} for r in rows])

    def api_bundles(self, q, body):
        rows = db().execute("SELECT name, size, n FROM bundles WHERE grp=? ORDER BY name", (q.get("g", ""),)).fetchall()
        self.send_json([{"b": r[0], "size": r[1], "assets": r[2]} for r in rows])

    def api_types(self, q, body):
        rows = db().execute("SELECT type, COUNT(*) FROM assets GROUP BY type ORDER BY COUNT(*) DESC").fetchall()
        self.send_json([{"t": r[0], "count": r[1]} for r in rows])

    def api_type_groups(self, q, body):
        rows = db().execute("SELECT b.grp, COUNT(*) FROM assets a JOIN bundles b ON b.id=a.bundle_id "
                            "WHERE a.type=? GROUP BY b.grp ORDER BY b.grp", (q.get("t", ""),)).fetchall()
        self.send_json([{"g": r[0], "count": r[1]} for r in rows])

    def api_objects(self, q, body):
        loaded = ENVS.get(q["b"])
        with loaded.lock:
            self.send_json(list_objects(loaded))

    def api_search(self, q, body):
        self.send_json(search(q))

    def api_info(self, q, body):
        loaded, obj = self._obj(q)
        with loaded.lock:
            self.send_json(object_info(loaded, obj))

    def api_data(self, q, body):
        loaded, obj = self._obj(q)
        with loaded.lock:
            data = object_data(loaded, obj)
        self.send_json(data)

    def api_preview(self, q, body):
        loaded, obj = self._obj(q)
        opts = {"format": "png", "alpha": q.get("alpha") or "keep"}
        with loaded.lock:
            data, mime, _ = render(loaded, obj, opts)
        if isinstance(data, Path):
            self.send_file(data, mime)
        else:
            self.send_bytes(data, mime, cache=True)

    def api_text(self, q, body):
        loaded, obj = self._obj(q)
        limit = int(q.get("limit") or 400_000)
        with loaded.lock:
            data, _, _ = render(loaded, obj, {})
        text = data.decode("utf-8", "replace") if isinstance(data, bytes) else ""
        self.send_json({"text": text[:limit], "truncated": len(text) > limit, "length": len(text)})

    def api_thumb(self, q, body):
        size = max(32, min(512, int(q.get("s") or 192)))
        self.send_file(thumbnail(q["b"], int(q["p"]), size), "image/webp")

    def api_export(self, q, body):
        items = body.get("items") or []
        if body.get("query"):
            items = search_all(body["query"], int(body.get("max") or 500_000))
        for name in body.get("bundleAll") or []:
            loaded = ENVS.get(name)
            with loaded.lock:
                items += [{"b": name, "p": o["p"], "t": o["t"], "n": o["n"]} for o in list_objects(loaded)]
        if not items:
            raise ApiError(400, "нечего экспортировать")
        subdir = hx.safe_name(body["subdir"]) if body.get("subdir") else ""
        self.send_json(start_export_job(items, body.get("opts") or {}, subdir, body.get("layout") or "flat",
                                        bool(body.get("skipExisting"))))

    def api_export_raw(self, q, body):
        names = list(body.get("bundles") or [])
        if body.get("group"):
            names += [r[0] for r in db().execute("SELECT name FROM bundles WHERE grp=?", (body["group"],))]
        if body.get("all"):
            names = [r[0] for r in db().execute("SELECT name FROM bundles")]
        if not names:
            raise ApiError(400, "нечего копировать")
        items = [{"b": n, "p": "0"} for n in names]
        self.send_json(start_export_job(items, {}, "Бандлы", skip_existing=bool(body.get("skipExisting")),
                                        worker=copy_bundle))

    def api_job(self, q, body):
        job = JOBS.get(q.get("id", ""))
        if not job:
            raise ApiError(404, "задание не найдено")
        self.send_json(job)

    def api_job_cancel(self, q, body):
        job = JOBS.get(body.get("id", ""))
        if job:
            job["cancel"] = True
        self.send_json({"ok": bool(job)})

    def api_hierarchy(self, q, body):
        loaded, obj = self._obj(q)
        with loaded.lock:
            self.send_json(hierarchy(loaded, obj))

    def api_count(self, q, body):
        """Количество ассетов по типам для запроса (диалог «Скачать всё»)."""
        out = {}
        for t in [x for x in (q.get("types") or "").split(",") if x]:
            out[t] = search({**q, "types": t, "limit": 1})["total"]
        self.send_json(out)

    def api_islands(self, q, body):
        loaded, obj = self._obj(q)
        with loaded.lock:
            img = asset_image(obj)
        boxes = find_islands(img, int(q.get("t") or 32), int(q.get("m") or 2), int(q.get("min") or 12))
        self.send_json({"width": img.width, "height": img.height, "boxes": boxes})

    def api_grid(self, q, body):
        loaded, obj = self._obj(q)
        with loaded.lock:
            img = asset_image(obj)
        self.send_json(guess_grid(img))

    def api_flipbook(self, q, body):
        self.send_json(flipbook(body))

    def api_reveal(self, q, body):
        target = Path(body.get("path") or export_root()).resolve()
        root = export_root().resolve()
        if target != root and root not in target.parents:
            raise ApiError(403, "можно открывать только папку экспорта")
        if not target.exists():
            target = root
            target.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            if target.is_file():
                subprocess.Popen(["explorer", "/select,", str(target)])
            else:
                os.startfile(str(target))
        self.send_json({"ok": True})

    def api_settings(self, q, body):
        if body.get("exportDir"):
            p = Path(body["exportDir"]).expanduser()
            p.mkdir(parents=True, exist_ok=True)
            CFG["export_dir"] = str(p)
            save_settings()
        self.send_json({"exportDir": str(export_root())})


SETTINGS_PATH = CACHE / "settings.json"


def save_settings():
    data = {"exportDir": CFG["export_dir"], "gameDir": str(CFG["game"] or "")}
    SETTINGS_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def load_settings():
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def open_app_window(url: str):
    """Окно без адресной строки через Edge/Chrome (--app), иначе обычный браузер. Возвращает процесс окна."""
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for exe in candidates:
        if exe.exists():
            profile = CACHE / "browser-profile"
            return subprocess.Popen([str(exe), f"--app={url}", "--window-size=1600,1000", f"--user-data-dir={profile}",
                                     "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble"])
    webbrowser.open(url)
    return None


def downloads_dir() -> Path:
    """Системная папка «Загрузки» (учитывает перенос в OneDrive и на другой диск)."""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes
            import uuid

            guid = uuid.UUID("374DE290-123F-4565-9164-39C4925E467B")  # FOLDERID_Downloads
            buf = ctypes.c_wchar_p()
            fid = (ctypes.c_byte * 16).from_buffer_copy(guid.bytes_le)
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(buf)) == 0:
                path = Path(buf.value)
                ctypes.windll.ole32.CoTaskMemFree(buf)
                return path
        except Exception:
            pass
    return Path.home() / "Downloads"


def running_instance(port: int) -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1.5) as r:
            return "unity" in json.load(r)
    except Exception:
        return False


def watchdog(server, window) -> None:
    """Выход, когда окно закрыто и интерфейс давно не обращался к серверу (и нет активных выгрузок)."""
    while True:
        time.sleep(5)
        window_open = window is not None and window.poll() is None
        busy = any(j["state"] == "running" for j in list(JOBS.values()))
        if not window_open and not busy and time.time() - LAST_SEEN[0] > 150:
            print("Окно закрыто — выхожу")
            server.shutdown()
            return


def setup_logging() -> None:
    """В exe нет консоли: вывод и ошибки — в app.log рядом с кешем."""
    if not FROZEN and sys.stdout is not None:
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    log = CACHE / "app.log"
    if log.exists() and log.stat().st_size > 5 << 20:
        log.replace(CACHE / "app.old.log")
    stream = open(log, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = stream
    print(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} запуск ===")


def main() -> None:
    p = argparse.ArgumentParser(description="Hearthstone Asset Studio")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--game", default=None)
    p.add_argument("--export-dir", default=None)
    p.add_argument("--dev", action="store_true", help="не открывать окно (интерфейс через npm run dev)")
    p.add_argument("--no-open", action="store_true")
    p.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = p.parse_args()

    setup_logging()
    CACHE.mkdir(parents=True, exist_ok=True)
    gui = not args.dev and not args.no_open

    # уже запущено — просто показать окно
    if running_instance(args.port):
        if gui:
            open_app_window(f"http://127.0.0.1:{args.port}/")
        return

    settings = load_settings()
    CFG.update(jobs=args.jobs,
               export_dir=args.export_dir or settings.get("exportDir") or str(downloads_dir() / "Hearthstone Assets"))
    game = normalize_game_dir(args.game) if args.game else find_game_dir(settings.get("gameDir", ""))
    if game:
        CFG.update(game=game, unity=hx.detect_unity_version(game))
        UnityPy.config.FALLBACK_UNITY_VERSION = CFG["unity"]
        save_settings()
        ensure_index(args.jobs)
    else:
        print("Игра не найдена автоматически — выбор папки в интерфейсе")

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # порт занят другой программой
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Hearthstone Asset Studio: {url}  (игра: {game or 'не найдена'}, Unity {CFG['unity']}, индекс: {STATE['state']})")
    if gui:
        window = open_app_window(url)
        threading.Thread(target=watchdog, args=(server, window), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    main()
