"""Run the local MSOB MCP and ngrok tunnel from the Windows system tray."""

from __future__ import annotations

import atexit
import ctypes
from ctypes import wintypes
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from PIL import Image
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
load_dotenv(ROOT / ".env")
ICON_PATH = PROJECT_ROOT / "Archive" / "Logo_upper.png"
if not ICON_PATH.exists():
    ICON_PATH = PROJECT_ROOT / "frontend" / "Logo_upper.png"
PORT = int(os.getenv("MCP_PORT", "8002"))
PUBLIC_BASE = os.getenv("MCP_PUBLIC_URL", "").strip().rstrip("/")
LOCAL_HEALTH = f"http://127.0.0.1:{PORT}/health"
LOCAL_APP_DATA = Path(os.getenv("MSOB_RUNTIME_DIR", str(ROOT / "runtime")))
LOCAL_APP_DATA.mkdir(parents=True, exist_ok=True)
ICO_PATH = LOCAL_APP_DATA / "mcp-tray.ico"
LOG_PATH = LOCAL_APP_DATA / "mcp-tray.log"
SERVER_LOG_PATH = LOCAL_APP_DATA / "mcp-server.log"
NGROK_LOG_PATH = LOCAL_APP_DATA / "mcp-ngrok.log"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_COMMAND = 0x0111
WM_LBUTTONUP = 0x0202
WM_RBUTTONUP = 0x0205
WM_USER = 0x0400
WM_TRAY = WM_USER + 20
NIM_ADD = 0x00000000
NIM_DELETE = 0x00000002
NIM_SETVERSION = 0x00000004
NIF_MESSAGE = 0x00000001
NIF_ICON = 0x00000002
NIF_TIP = 0x00000004
NOTIFYICON_VERSION_4 = 4
IMAGE_ICON = 1
LR_LOADFROMFILE = 0x0010
LR_DEFAULTSIZE = 0x0040
MF_STRING = 0x0000
MF_GRAYED = 0x0001
MF_SEPARATOR = 0x0800
TPM_RIGHTBUTTON = 0x0002
TPM_RETURNCMD = 0x0100
MENU_OPEN = 1002
MENU_CLOSE = 1003

user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32

user32.DefWindowProcW.restype = ctypes.c_ssize_t
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreatePopupMenu.restype = wintypes.HMENU
user32.LoadImageW.restype = wintypes.HANDLE
kernel32.GetModuleHandleW.restype = wintypes.HMODULE


class WNDCLASSW(ctypes.Structure):
    pass


WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t,
    wintypes.HWND,
    wintypes.UINT,
    wintypes.WPARAM,
    wintypes.LPARAM,
)

WNDCLASSW._fields_ = [
    ("style", wintypes.UINT),
    ("lpfnWndProc", WNDPROC),
    ("cbClsExtra", ctypes.c_int),
    ("cbWndExtra", ctypes.c_int),
    ("hInstance", wintypes.HINSTANCE),
    ("hIcon", wintypes.HICON),
    ("hCursor", wintypes.HANDLE),
    ("hbrBackground", wintypes.HBRUSH),
    ("lpszMenuName", wintypes.LPCWSTR),
    ("lpszClassName", wintypes.LPCWSTR),
]


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", ctypes.c_byte * 16),
        ("hBalloonIcon", wintypes.HICON),
    ]


def _log(message: str) -> None:
    with LOG_PATH.open("a", encoding="utf-8") as stream:
        stream.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")


def _single_instance() -> bool:
    handle = kernel32.CreateMutexW(None, False, "MSOB_AI_MCP_TRAY_V2")
    return bool(handle) and kernel32.GetLastError() != 183


def _find_ngrok() -> str | None:
    found = shutil.which("ngrok.exe") or shutil.which("ngrok")
    if found:
        return found
    packages = Path(os.getenv("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    matches = list(packages.glob("**/ngrok.exe")) if packages.exists() else []
    return str(matches[0]) if matches else None


def _health_ready() -> bool:
    try:
        with urllib.request.urlopen(LOCAL_HEALTH, timeout=2) as response:
            return json.loads(response.read().decode("utf-8")).get("status") == "ok"
    except Exception:
        return False


def _matching_tunnel() -> dict | None:
    try:
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as response:
            tunnels = json.loads(response.read().decode("utf-8")).get("tunnels", [])
            return next((item for item in tunnels if item.get("public_url") == PUBLIC_BASE), None)
    except Exception:
        return None


def _ngrok_ready() -> bool:
    return _matching_tunnel() is not None


def _wait_for(check, seconds: int) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.4)
    return False


def _terminate_process(process: subprocess.Popen | None) -> None:
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def _stop_matching_tunnel() -> None:
    tunnel = _matching_tunnel()
    name = str((tunnel or {}).get("name") or "")
    if not name:
        return
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:4040/api/tunnels/{urllib.parse.quote(name, safe='')}",
            method="DELETE",
        )
        urllib.request.urlopen(request, timeout=3).close()
    except Exception:
        pass


def _listening_pid() -> int | None:
    result = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        capture_output=True,
        text=True,
        creationflags=CREATE_NO_WINDOW,
        check=False,
    )
    for line in result.stdout.splitlines():
        columns = line.split()
        if len(columns) < 5 or columns[3].upper() != "LISTENING":
            continue
        if columns[1].rsplit(":", 1)[-1] == str(PORT) and columns[-1].isdigit():
            return int(columns[-1])
    return None


def _stop_existing_server() -> None:
    if not _health_ready():
        return
    pid = _listening_pid()
    if pid:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )


class NativeTray:
    def __init__(self) -> None:
        self.server: subprocess.Popen | None = None
        self.ngrok: subprocess.Popen | None = None
        self.server_log = None
        self.ngrok_log = None
        self.stopping = False
        self.hwnd: int | None = None
        self.icon_data: NOTIFYICONDATAW | None = None
        self.window_proc = WNDPROC(self._window_proc)

    def start_components(self) -> None:
        _stop_existing_server()
        _stop_matching_tunnel()
        self.server_log = SERVER_LOG_PATH.open("a", encoding="utf-8")
        self.server = subprocess.Popen(
            [sys.executable, str(ROOT / "mcp_server.py")],
            cwd=ROOT,
            stdout=self.server_log,
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        if not _wait_for(_health_ready, 30):
            raise RuntimeError("The local MCP did not pass its health check.")

        ngrok = _find_ngrok()
        if ngrok and PUBLIC_BASE:
            self.ngrok_log = NGROK_LOG_PATH.open("a", encoding="utf-8")
            self.ngrok = subprocess.Popen(
                [ngrok, "http", str(PORT), f"--url={PUBLIC_BASE}"],
                cwd=ROOT,
                stdout=self.ngrok_log,
                stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW,
            )
            if not _wait_for(_ngrok_ready, 30):
                _log("The optional public MCP tunnel did not become ready; local MCP remains active.")
                _terminate_process(self.ngrok)
                self.ngrok = None
        endpoint = f"; public endpoint {PUBLIC_BASE}/sse" if _ngrok_ready() else ""
        _log(f"MCP ready at {LOCAL_HEALTH}{endpoint}")

    def _create_icon_file(self) -> None:
        with Image.open(ICON_PATH).convert("RGBA") as image:
            image.save(
                ICO_PATH,
                format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)],
            )

    def _show_menu(self) -> None:
        point = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        menu = user32.CreatePopupMenu()
        user32.AppendMenuW(menu, MF_STRING | MF_GRAYED, 1001, "MCP actif")
        user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
        user32.AppendMenuW(menu, MF_STRING, MENU_OPEN, "Ouvrir l'état")
        user32.AppendMenuW(menu, MF_STRING, MENU_CLOSE, "Fermer le MCP")
        user32.SetForegroundWindow(self.hwnd)
        command = user32.TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_RETURNCMD,
            point.x,
            point.y,
            0,
            self.hwnd,
            None,
        )
        user32.DestroyMenu(menu)
        if command == MENU_OPEN:
            webbrowser.open(LOCAL_HEALTH)
        elif command == MENU_CLOSE:
            user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)

    def _window_proc(self, hwnd, message, wparam, lparam):
        if message == WM_TRAY:
            event_code = int(lparam) & 0xFFFF
            if event_code == WM_LBUTTONUP:
                webbrowser.open(LOCAL_HEALTH)
            elif event_code == WM_RBUTTONUP:
                self._show_menu()
            return 0
        if message == WM_COMMAND:
            return 0
        if message == WM_CLOSE:
            self.close_components()
            user32.DestroyWindow(hwnd)
            return 0
        if message == WM_DESTROY:
            if self.icon_data is not None:
                shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self.icon_data))
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def create_tray(self) -> None:
        self._create_icon_file()
        instance = kernel32.GetModuleHandleW(None)
        class_name = "MSOB_AI_MCP_Tray_Window"
        window_class = WNDCLASSW()
        window_class.lpfnWndProc = self.window_proc
        window_class.hInstance = instance
        window_class.lpszClassName = class_name
        atom = user32.RegisterClassW(ctypes.byref(window_class))
        if not atom and kernel32.GetLastError() != 1410:
            raise ctypes.WinError()
        self.hwnd = user32.CreateWindowExW(
            0, class_name, "MSOB AI MCP", 0, 0, 0, 0, 0, None, None, instance, None
        )
        if not self.hwnd:
            raise ctypes.WinError()
        icon_handle = user32.LoadImageW(
            None, str(ICO_PATH), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE
        )
        if not icon_handle:
            raise ctypes.WinError()

        data = NOTIFYICONDATAW()
        data.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        data.hWnd = self.hwnd
        data.uID = 1
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        data.uCallbackMessage = WM_TRAY
        data.hIcon = icon_handle
        data.szTip = "MSOB AI MCP"
        self.icon_data = data
        if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(data)):
            raise ctypes.WinError()
        data.uVersion = NOTIFYICON_VERSION_4
        shell32.Shell_NotifyIconW(NIM_SETVERSION, ctypes.byref(data))

    def monitor(self) -> None:
        while not self.stopping:
            time.sleep(3)
            if self.server and self.server.poll() is not None:
                _log("The MCP process stopped unexpectedly.")
                if self.hwnd:
                    user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)
                return

    def close_components(self) -> None:
        if self.stopping:
            return
        self.stopping = True
        _stop_matching_tunnel()
        _terminate_process(self.ngrok)
        _terminate_process(self.server)
        if self.ngrok_log:
            self.ngrok_log.close()
        if self.server_log:
            self.server_log.close()
        _log("MCP closed from the system tray.")

    def run(self) -> None:
        try:
            self.start_components()
            self.create_tray()
        except Exception as error:
            _log(f"Startup failed: {error}")
            self.close_components()
            return
        threading.Thread(target=self.monitor, daemon=True).start()
        atexit.register(self.close_components)
        message = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))


if __name__ == "__main__" and _single_instance():
    NativeTray().run()
