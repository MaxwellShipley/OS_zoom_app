#!/usr/bin/env python3
# local_client_gui.py
# Python 3.11+ recommended
#
# Install deps once:
#   pip install "python-socketio[client]"

import random
import signal
import sys
import threading
import time
from datetime import datetime
from functools import partial

import socketio  # python-socketio[client]
import tkinter as tk
from tkinter import ttk

# ─────────────────────────────────────────────────────────────
# Config (hardcoded for now, per your preference)
# ─────────────────────────────────────────────────────────────
SERVER_URL = "http://localhost:3000"   # use your ngrok/host in prod
SEND_INTERVAL_SEC = 1.0                # 1 Hz

# ─────────────────────────────────────────────────────────────
# Protocol constants
# ─────────────────────────────────────────────────────────────
CMD = {
    0x00: "TEST_CONNECTION",
    0x01: "CONNECTION_ESTABLISHED",
    0x02: "VALIDATE_USER",
    0x03: "USER_VALID",
    0x04: "USER_INVALID",
    0x07: "BEGIN_DATA",
    0x08: "DATA_TRANSMISSION",
    0x09: "END_DATA",
    0x0D: "MEETING_INFO",
    0x0E: "REGISTER_LOCAL",
    0x0F: "UNREGISTER_LOCAL",
}

def iso_now() -> str:
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"

def r2(x: float) -> float:
    return round(float(x), 2)

# ─────────────────────────────────────────────────────────────
# Module-level proxies so other modules can interact
# ─────────────────────────────────────────────────────────────
current_client = None

def send_probabilities_once(prob_1: float, prob_2: float) -> bool:
    """
    Convenience proxy. Returns True if sent, False if not ready.
    Import and call from other modules:
        from local_client_gui import send_probabilities_once
        send_probabilities_once(0.72, 0.31)
    """
    global current_client
    if current_client is None:
        return False
    return current_client.send_probabilities_once(prob_1, prob_2)

def is_ready_to_send() -> bool:
    """
    Quick boolean to know if you can start sending probabilities.
    True when: socket connected + user logged in + meeting known.
    """
    global current_client
    return current_client.is_ready_to_send() if current_client else False

def get_login_status() -> dict:
    """
    Structured status for dashboards/logic:
      { connected: bool, user_id: str|None, meeting_id: str|None, ready_to_send: bool }
    """
    global current_client
    if current_client is None:
        return {"connected": False, "user_id": None, "meeting_id": None, "ready_to_send": False}
    return current_client.get_status()

# ─────────────────────────────────────────────────────────────
# Socket client
# ─────────────────────────────────────────────────────────────
class LocalSocketClient:
    """
    Handles Socket.IO connection and OS protocol.
    - Login via VALIDATE_USER (0x02) → server checks DynamoDB.
    - On USER_VALID (0x03), registers local (0x0E).
    - Waits MEETING_INFO (0x0D) + BEGIN_DATA (0x07).
    - Sends DATA_TRANSMISSION (0x08) 1 Hz with prob_1 & prob_2.
    - Sign out sends END_DATA (0x09) + UNREGISTER_LOCAL (0x0F), then disconnects.
    """
    def __init__(self, server_url: str, ui_callback):
        self.server_url = server_url.rstrip("/")
        self.ui = ui_callback                       # thread-safe UI dispatcher: ui(action, **kwargs)
        self.sio = socketio.Client(
            logger=False, engineio_logger=False, reconnection=True
        )

        self.user_id = None
        self.meeting_id = None

        self._send_thread = None
        self._stop_event = threading.Event()
        self._interval = SEND_INTERVAL_SEC

        self._pending_login = None  # (username, password) queued if we need to connect first

        # bind events
        self.sio.on("connect", self._on_connect)
        self.sio.on("disconnect", self._on_disconnect)
        self.sio.on("os_packet", self._on_os_packet)

    # ——— lifecycle ————————————————————————————————————————————
    def connect(self):
        """Async connect; safe to call multiple times."""
        def _run():
            try:
                self.sio.connect(self.server_url, wait=True)
            except Exception as e:
                self.ui("login_error", msg=f"Could not connect to server.\n{e}")
        threading.Thread(target=_run, daemon=True).start()

    def disconnect(self):
        try:
            if self.sio.connected:
                self.sio.disconnect()
        except Exception:
            pass

    def close(self):
        self.stop_sending()
        self.disconnect()

    # ——— auth ————————————————————————————————————————————————
    def login(self, username: str, password: str):
        """
        If not connected, connect and queue this login for after connect.
        Otherwise, emit VALIDATE_USER (0x02) immediately.
        """
        username = (username or "").strip()
        if not self.sio.connected:
            self._pending_login = (username, password)
            self.connect()
            return
        pkt = {"cmd": 0x02, "data": {"username": username, "password": password}}
        self._log_send("server", pkt["cmd"], {**pkt["data"], "password": "***redacted***"})
        self.sio.emit("os_packet", pkt)

    def sign_out(self):
        """
        Politely stop streaming, tell server to END_DATA and UNREGISTER_LOCAL,
        then fully disconnect and clear local state.
        """
        try:
            if self.sio.connected and self.user_id:
                # courtesy end
                if self.meeting_id:
                    self.sio.emit("os_packet", {
                        "cmd": 0x09,
                        "data": {"meetingId": self.meeting_id, "originStoryUserId": self.user_id}
                    })
                # unregister this socket as local for user
                self.sio.emit("os_packet", {
                    "cmd": 0x0F,
                    "data": {"originStoryUserId": self.user_id}
                })
        except Exception:
            pass

        self.stop_sending()
        self.user_id = None
               # keep meeting_id for context? Clear to be safe:
        self.meeting_id = None
        self._pending_login = None
        # fully drop the connection so we “terminate the connection and return to sign in”
        self.disconnect()

    # ——— socket callbacks ————————————————————————————————————
    def _on_connect(self):
        self._log("Connected to server.")
        self.ui("server_connected")
        # If user clicked Sign In while disconnected, send the queued login now.
        if self._pending_login:
            u, p = self._pending_login
            self._pending_login = None
            pkt = {"cmd": 0x02, "data": {"username": u, "password": p}}
            self._log_send("server", pkt["cmd"], {**pkt["data"], "password": "***redacted***"})
            self.sio.emit("os_packet", pkt)

    def _on_disconnect(self):
        self._log("Disconnected from server.")
        self.stop_sending()
        self.ui("server_disconnected")

    def _on_os_packet(self, packet):
        try:
            cmd = int(packet.get("cmd"))
            data = packet.get("data") or {}
        except Exception:
            return
        self._log_recv(cmd, data)

        if cmd == 0x03:  # USER_VALID
            self.user_id = data.get("userId")
            # Immediately REGISTER_LOCAL
            reg = {"cmd": 0x0E, "data": {"originStoryUserId": self.user_id}}
            self._log_send("server", reg["cmd"], reg["data"])
            self.sio.emit("os_packet", reg)
            self.ui("login_ok", user_id=self.user_id)

        elif cmd == 0x04:  # USER_INVALID
            self.ui("login_fail", msg=data.get("error", "Invalid credentials."))

        elif cmd == 0x0D:  # MEETING_INFO
            self.meeting_id = data.get("meetingId") or data.get("meetingid")
            self.ui("meeting_info", meeting_id=self.meeting_id)

        elif cmd == 0x07:  # BEGIN_DATA
            # Start sending and show minimize countdown; after minimize, set "Data transmission in progress"
            if not self._send_thread or not self._send_thread.is_alive():
                self.start_sending()
            self.ui("begin_data")

        elif cmd == 0x09:  # END_DATA
            self.stop_sending()
            self.ui("end_data")

    # ——— utility for external use ————————————————————————————
    def is_ready_to_send(self) -> bool:
        return self.sio.connected and bool(self.meeting_id) and bool(self.user_id)

    def get_status(self) -> dict:
        return {
            "connected": bool(self.sio.connected),
            "user_id": self.user_id,
            "meeting_id": self.meeting_id,
            "ready_to_send": self.is_ready_to_send(),
        }

    def send_probabilities_once(self, prob_1: float, prob_2: float) -> bool:
        """
        Send one DATA_TRANSMISSION packet. Safe to call from other threads.
        Returns True if sent, False if not ready/invalid.
        """
        if not self.is_ready_to_send():
            return False
        try:
            p1 = r2(float(prob_1))
            p2 = r2(float(prob_2))
        except Exception:
            return False
        if not (0.0 <= p1 <= 1.0 and 0.0 <= p2 <= 1.0):
            return False

        pkt = {
            "cmd": 0x08,
            "data": {
                "meetingId": self.meeting_id,
                "originStoryUserId": self.user_id,
                "prob_1": p1,
                "prob_2": p2,
                "timestamp": iso_now(),
            },
        }
        self._log_send(f"room:{self.meeting_id}", pkt["cmd"], pkt["data"])
        try:
            self.sio.emit("os_packet", pkt)
            return True
        except Exception as e:
            self._log(f"Emit failed: {e}")
            return False

    # ——— sending loop ———————————————————————————————————————
    def start_sending(self):
        if self._send_thread and self._send_thread.is_alive():
            return
        self._stop_event.clear()
        self._send_thread = threading.Thread(target=self._loop, daemon=True)
        self._send_thread.start()

    def stop_sending(self):
        self._stop_event.set()
        if self._send_thread and self._send_thread.is_alive():
            self._send_thread.join(timeout=2.0)
        self._send_thread = None

    def _loop(self):
        while not self._stop_event.is_set():
            if not self.is_ready_to_send():
                time.sleep(0.25)
                continue
            prob_1, prob_2 = self.get_probabilities()
            self.send_probabilities_once(prob_1, prob_2)
            time.sleep(self._interval)

    # ——— hardware hook (replace later) ————————————————
    def get_probabilities(self):
        return random.random(), random.random()

    # ——— logging ————————————————————————————————————————————
    def _log(self, msg): print(msg)
    def _log_recv(self, cmd, data=None): print(f"⬇️  os_packet RECV [{CMD.get(cmd, cmd)}] {data or ''}")
    def _log_send(self, dest, cmd, data=None): print(f"⬆️  os_packet SEND → {dest} [{CMD.get(cmd, cmd)}] {data or ''}")

# ─────────────────────────────────────────────────────────────
# GUI (Tkinter) — simple, earlier style restored
# ─────────────────────────────────────────────────────────────
class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("OriginStory Local Client")
        self.root.geometry("520x360")
        self.root.minsize(480, 320)
        self.root.configure(bg="#e8efff")  # light only

        self.style = ttk.Style()
        try: self.style.theme_use("clam")
        except Exception: pass
        self.style.configure("Glass.TFrame", background="#ffffff")
        self.style.configure("H1.TLabel", font=("Helvetica", 18, "bold"), background="#ffffff", foreground="#0f172a")
        self.style.configure("TLabel", background="#ffffff", foreground="#0f172a")
        self.style.configure("Muted.TLabel", background="#ffffff", foreground="#475569")
        self.style.configure("TButton", font=("Helvetica", 10, "bold"))

        # Main “card” container (simple)
        self.container = ttk.Frame(self.root, padding=16, style="Glass.TFrame")
        self.container.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.92, relheight=0.86)

        # Screens
        self.login_frame = self._build_login()
        self.status_frame = self._build_status()

        self._show(self.login_frame)

        # Socket client (connects on first login if needed)
        self.client = LocalSocketClient(SERVER_URL, ui_callback=self._ui)

        # Expose to module-level proxies
        global current_client
        current_client = self.client

        # Sign-out suppression flag to ignore late server events
        self._just_signed_out = False

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    # UI dispatcher
    def _ui(self, action, **kwargs):
        self.root.after(0, partial(self._handle_ui, action, **kwargs))

    def _handle_ui(self, action, **kw):
        if action == "server_connected":
            pass  # quiet

        elif action == "server_disconnected":
            if self._just_signed_out:
                self._just_signed_out = False
                return
            if self._is_showing(self.login_frame):
                self._set_login_msg("Disconnected from server.", error=True)

        elif action == "login_ok":
            self._show(self.status_frame)
            self._set_status_title("Signed in")
            self._set_status_text("Waiting to connect to OriginStory Zoom App…")
            self.root.deiconify()

        elif action == "login_fail":
            self._show(self.login_frame)
            self._set_login_msg(kw.get("msg", "Invalid credentials."), error=True)

        elif action == "login_error":
            self._show(self.login_frame)
            self._set_login_msg(kw.get("msg", "Error."), error=True)

        elif action == "meeting_info":
            mid = kw.get("meeting_id", "")
            if self._is_showing(self.status_frame):
                self._set_status_text(f"Waiting to connect to OriginStory Zoom App…\n(meeting: {mid})")

        elif action == "begin_data":
            self._connected_countdown_and_minimize()

        elif action == "end_data":
            if self._just_signed_out:
                self._just_signed_out = False
                return
            if self.client and self.client.user_id:
                self.root.deiconify()
                self._show(self.status_frame)
                self._set_status_title("Connection ended")
                self._set_status_text("Waiting to connect to OriginStory Zoom App…")

        elif action == "status":
            self._set_login_msg(kw.get("text", ""), error=(kw.get("kind") == "error"))

    # Build Login screen
    def _build_login(self):
        f = ttk.Frame(self.container, padding=16, style="Glass.TFrame")

        ttk.Label(f, text="Welcome back", style="H1.TLabel").pack(anchor="w")
        ttk.Label(f, text="Sign in with your OriginStory username.", style="Muted.TLabel").pack(anchor="w", pady=(0, 10))

        self.username_var = tk.StringVar()
        self.password_var = tk.StringVar()

        row1 = ttk.Frame(f, style="Glass.TFrame"); row1.pack(fill="x", pady=6)
        ttk.Label(row1, text="Username").pack(anchor="w")
        u = ttk.Entry(row1, textvariable=self.username_var); u.pack(fill="x")
        u.focus_set()

        row2 = ttk.Frame(f, style="Glass.TFrame"); row2.pack(fill="x", pady=6)
        ttk.Label(row2, text="Password").pack(anchor="w")
        p = ttk.Entry(row2, textvariable=self.password_var, show="•"); p.pack(fill="x")
        p.bind("<Return>", lambda e: self._on_login_click())

        btn_row = ttk.Frame(f, style="Glass.TFrame"); btn_row.pack(fill="x", pady=8)
        self.login_btn = ttk.Button(btn_row, text="Sign In", command=self._on_login_click)
        self.login_btn.pack(side="left")

        self.login_msg = ttk.Label(f, text="", style="Muted.TLabel")
        self.login_msg.pack(anchor="w", pady=(8, 0))

        return f

    # Build Status screen (note appears once here)
    def _build_status(self):
        f = ttk.Frame(self.container, padding=16, style="Glass.TFrame")

        self.status_title = ttk.Label(f, text="Status", style="H1.TLabel")
        self.status_title.pack(anchor="w", pady=(0, 8))

        self.status_text = ttk.Label(f, text="Waiting…", style="TLabel", justify="left")
        self.status_text.pack(anchor="w")

        self.note_text = ttk.Label(
            f,
            text="Do NOT close this window.",
            style="Muted.TLabel",
            justify="left"
        )
        self.note_text.pack(anchor="w", pady=(12, 0))

        # Sign out button
        ttk.Button(f, text="Sign out", command=self._on_sign_out).pack(anchor="w", pady=(16, 0))
        return f

    # Helpers
    def _is_showing(self, frame) -> bool:
        return bool(frame.winfo_ismapped())

    def _show(self, frame):
        for child in (self.login_frame, self.status_frame):
            if child is not None:
                child.pack_forget()
        frame.pack(fill="both", expand=True)

    def _set_login_msg(self, msg, error=False):
        self.login_msg.configure(text=msg)
        self.login_msg.configure(foreground=("#b91c1c" if error else "#475569"))

    def _set_status_title(self, text):
        self.status_title.configure(text=text)

    def _set_status_text(self, text):
        self.status_text.configure(text=text)

    def _connected_countdown_and_minimize(self):
        self._show(self.status_frame)
        sec = 10

        def tick(n):
            # Show countdown ONLY (avoid duplicating the note label)
            self._set_status_title("Connected to OriginStory Zoom App")
            self._set_status_text(f"This window will minimize in {n}…")
            if n <= 0:
                try:
                    self.root.iconify()  # minimize to taskbar
                finally:
                    # After minimizing (and whenever restored), keep this message
                    self._set_status_title("Connected to OriginStory Zoom App")
                    self._set_status_text("Data transmission in progress.")
            else:
                self.root.after(1000, lambda: tick(n - 1))

        tick(sec)

    # Actions
    def _on_login_click(self):
        u = self.username_var.get().strip()
        p = self.password_var.get()
        if not u or not p:
            self._set_login_msg("Enter username and password.", error=True)
            return
        self.login_btn.configure(state=tk.DISABLED)
        self._set_login_msg("Signing in…")
        # Fire login in socket client (connects first if needed)
        self.client.login(u, p)
        # Re-enable after a short delay (server response will also update UI)
        self.root.after(1500, lambda: self.login_btn.configure(state=tk.NORMAL))

    def _on_sign_out(self):
        # Mark so late server events don't flip us back to "waiting"
        self._just_signed_out = True
        # Fully terminate and go back to Sign In page
        self.client.sign_out()
        self._show(self.login_frame)
        self._set_login_msg("Signed out. Please sign in again.", error=False)
        self.username_var.set("")
        self.password_var.set("")
        try:
            self.root.deiconify()
        except Exception:
            pass

    def on_close(self):
        try:
            self.client.close()
        except Exception:
            pass
        # Clear the module-level proxies on exit
        global current_client
        current_client = None
        self.root.destroy()

# Entrypoint
def main():
    root = tk.Tk()
    app = App(root)

    def _sigint(sig, frame):
        app.on_close(); sys.exit(0)

    signal.signal(signal.SIGINT, _sigint)
    root.mainloop()

if __name__ == "__main__":
    main()
