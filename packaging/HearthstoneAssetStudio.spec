# PyInstaller: один exe без консоли. Сборка: packaging\build.bat
from PyInstaller.utils.hooks import collect_all

ROOT = SPECPATH + "\\.."

datas = [(ROOT + "\\web\\out", "web\\out")]
binaries = []
hiddenimports = ["scipy.ndimage", "tkinter", "tkinter.filedialog"]
# UnityPy: типы (tpk), FMOD для звука, декодеры текстур
for pkg in ("UnityPy", "texture2ddecoder", "etcpak", "astc_encoder", "fmod_toolkit", "pyfmodex", "archspec", "tpk_ar", "lz4"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

a = Analysis(
    [ROOT + "\\hsserver.py"],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["matplotlib", "pandas", "IPython", "pytest", "scipy.spatial.cKDTree", "PyQt5", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="HearthstoneAssetStudio",
    icon=SPECPATH + "\\app.ico",
    console=False,
    upx=False,
    version=SPECPATH + "\\version.txt",
)
