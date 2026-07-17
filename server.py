#!/usr/bin/env python3
"""Backend for andreisuslov.com — a stdlib-only HTTP server.

This single file does three things and nothing more (blog, uploads and an
admin page come later):

  1. Serves the existing static site (index.html, CSS, JS, images, fonts).
  2. Authenticates the site owner via Google Sign-In (ID-token flow),
     restricted to a single allow-listed email.
  3. Exposes a small homepage-content API the front-end uses to load and
     save `content.json`.

No third-party dependencies — only the Python 3.11+ standard library.

Run it locally:

    GOOGLE_SITE_CLIENT_ID=<web-oauth-client-id> python3 server.py --port 8000

Serving the static site needs no client id:

    python3 server.py --port 8000 --data /tmp/sitedata

Run the in-process test suite (no network) and exit non-zero on failure:

    python3 server.py --selftest

Notable flags (see --help):
    --site DIR          static files root (default: this file's directory)
    --data DIR          writable dir for content.json / sessions.json
    --client-id ID      Google web OAuth client id (or env GOOGLE_SITE_CLIENT_ID)
    --allow-email EMAIL the ONLY email allowed to authenticate
    --port N            listen port (default 8000 — the OAuth-authorized origin)
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Constants ---------------------------------------------------------------

COOKIE_NAME = "site_session"
SESSION_TTL = 30 * 24 * 60 * 60  # 30 days, in seconds
MAX_BODY = 1024 * 1024  # 1 MB cap on request bodies
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}

# Extension -> MIME type. Kept deliberately small; unknown types fall back to
# application/octet-stream.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


# --- Google token verification ----------------------------------------------

def verify_google_token(credential, client_id):
    """Verify a Google ID token via the tokeninfo endpoint.

    Returns the claims dict on success, else None. A token is valid when its
    `aud` matches `client_id`, `email_verified` is truthy, and `exp` is in the
    future. Any error (network, bad token, mismatch) yields None.
    """
    if not credential or not client_id:
        return None
    try:
        url = TOKENINFO_URL + "?" + urllib.parse.urlencode({"id_token": credential})
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return None
            claims = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    if not isinstance(claims, dict):
        return None
    if claims.get("iss") not in GOOGLE_ISSUERS:
        return None
    if claims.get("aud") != client_id:
        return None
    if not _truthy(claims.get("email_verified")):
        return None
    try:
        if int(claims.get("exp", 0)) <= int(time.time()):
            return None
    except (TypeError, ValueError):
        return None
    return claims


def _truthy(value):
    """Google returns email_verified as either bool True or the string 'true'."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return bool(value)


# --- Application state -------------------------------------------------------

class App:
    """Holds config, on-disk paths, the session store, and the (injectable)
    Google verifier. One instance is shared across all worker threads.
    """

    def __init__(self, site_dir, data_dir, client_id, allow_email,
                 verify=verify_google_token):
        self.site_dir = os.path.realpath(site_dir)
        self.data_dir = os.path.realpath(data_dir)
        self.client_id = client_id
        self.allow_email = allow_email
        # Injectable so --selftest never touches the network.
        self.verify = verify

        os.makedirs(self.data_dir, exist_ok=True)
        self.content_path = os.path.join(self.data_dir, "content.json")
        self.sessions_path = os.path.join(self.data_dir, "sessions.json")

        # Warn loudly if the data dir lives under the served site root: the
        # static handler already refuses to serve it, but keeping sessions out
        # of the document root entirely is the safer posture.
        if (self.data_dir == self.site_dir
                or self.data_dir.startswith(self.site_dir + os.sep)):
            sys.stderr.write(
                f"WARNING: data dir ({self.data_dir}) is inside the site root "
                f"({self.site_dir}). Static serving of it is blocked, but "
                f"prefer a --data path outside the site.\n"
            )

        self._lock = threading.Lock()

    # --- session store (guarded by a single lock) ---------------------------

    def _load_sessions(self):
        try:
            with open(self.sessions_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
                return data if isinstance(data, dict) else {}
        except (FileNotFoundError, ValueError):
            return {}

    def _save_sessions(self, sessions):
        _atomic_write_json(self.sessions_path, sessions)

    def create_session(self, email):
        sid = secrets.token_urlsafe(32)
        expires = int(time.time()) + SESSION_TTL
        with self._lock:
            sessions = self._prune(self._load_sessions())
            sessions[sid] = {"email": email, "expires": expires}
            self._save_sessions(sessions)
        return sid

    def get_session(self, sid):
        """Return the session record for `sid`, or None if absent/expired."""
        if not sid:
            return None
        with self._lock:
            sessions = self._load_sessions()
            rec = sessions.get(sid)
            if rec is None:
                return None
            if int(rec.get("expires", 0)) <= int(time.time()):
                # Expired: drop it and persist the prune.
                pruned = self._prune(sessions)
                self._save_sessions(pruned)
                return None
            return rec

    def delete_session(self, sid):
        if not sid:
            return
        with self._lock:
            sessions = self._load_sessions()
            if sid in sessions:
                del sessions[sid]
                self._save_sessions(sessions)

    @staticmethod
    def _prune(sessions):
        now = int(time.time())
        return {
            sid: rec
            for sid, rec in sessions.items()
            if int(rec.get("expires", 0)) > now
        }

    # --- content store ------------------------------------------------------

    def read_content(self):
        """Return (True, obj) if content.json exists and parses, else (False, None)."""
        with self._lock:
            try:
                with open(self.content_path, "r", encoding="utf-8") as fh:
                    return True, json.load(fh)
            except (FileNotFoundError, ValueError):
                return False, None

    def write_content(self, obj):
        with self._lock:
            _atomic_write_json(self.content_path, obj)


def _atomic_write_json(path, obj):
    """Write JSON to `path` atomically (temp file in the same dir + os.replace)."""
    directory = os.path.dirname(path)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


# --- HTTP handler ------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "andreisuslov-com/1.0"
    protocol_version = "HTTP/1.1"
    # Per-connection socket timeout: drop slow clients rather than let a worker
    # thread be held open indefinitely (slowloris defense).
    timeout = 30

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    # -- small response helpers ---------------------------------------------

    def _send(self, status, body=b"", content_type="text/plain; charset=utf-8",
              extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, val in (extra_headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj, extra_headers=None):
        headers = {"Cache-Control": "no-store"}
        if extra_headers:
            headers.update(extra_headers)
        body = json.dumps(obj).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", headers)

    # -- cookie / session helpers -------------------------------------------

    def _cookie_sid(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            jar = SimpleCookie()
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def _session(self):
        """Return the current valid session record, or None."""
        return self.app.get_session(self._cookie_sid())

    def _is_https(self):
        return (self.headers.get("X-Forwarded-Proto", "").lower() == "https")

    def _set_cookie_header(self, sid, max_age):
        attrs = [
            f"{COOKIE_NAME}={sid}",
            "HttpOnly",
            "SameSite=Lax",
            "Path=/",
            f"Max-Age={max_age}",
        ]
        if self._is_https():
            attrs.append("Secure")
        return "; ".join(attrs)

    # -- request-body / security helpers ------------------------------------

    def _read_body(self):
        """Read the request body, enforcing the size cap.

        Returns (ok, bytes). When the body is too large, sends 413 and returns
        (False, b"").
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length > MAX_BODY:
            # We refuse to drain a huge body; close the connection instead so
            # the unread bytes don't desync the next request under keep-alive.
            self.close_connection = True
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                       {"error": "body too large"},
                       {"Connection": "close"})
            return False, b""
        if length <= 0:
            return True, b""
        return True, self.rfile.read(length)

    def _origin_ok(self):
        """On writes, if an Origin header is present its host must equal Host's."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        origin_host = urllib.parse.urlsplit(origin).netloc
        host = self.headers.get("Host", "")
        return bool(origin_host) and origin_host == host

    # -- request logging (one concise line, never secrets) ------------------

    def log_message(self, fmt, *args):  # noqa: A003 (stdlib signature)
        # Suppress the default logger; we log explicitly after routing so we can
        # include the final status while guaranteeing no cookies/tokens leak.
        pass

    def _log(self, status):
        path = urllib.parse.urlsplit(self.path).path
        sys.stderr.write(
            f"{self.address_string()} {self.command} {path} -> {int(status)}\n"
        )

    # -- HTTP verbs ---------------------------------------------------------

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/me":
            return self._api_me()
        if path == "/api/content":
            return self._api_get_content()
        if path.startswith("/api/"):
            return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})
        return self._static(path)

    def do_HEAD(self):
        # Serve headers only for static assets; APIs are GET/POST/PUT.
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/"):
            return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})
        return self._static(path)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/auth/google":
            return self._api_auth_google()
        if path == "/api/auth/logout":
            return self._api_auth_logout()
        return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})

    def do_PUT(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/content":
            return self._api_put_content()
        return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})

    # -- routing helpers ----------------------------------------------------

    def _finish(self, status, sender, *args):
        """Call a sender (self._json/self._send) then log the status once."""
        sender(status, *args)
        self._log(status)

    # -- static serving -----------------------------------------------------

    def _static(self, url_path):
        # Decode %xx, strip the leading slash, and join under the site root.
        rel = urllib.parse.unquote(url_path).lstrip("/")

        # Defensive segment checks: never serve dotfiles (e.g. .git,
        # .sessions.json.tmp) or anything explicitly named `_data`, regardless
        # of where the data dir actually lives.
        segments = [s for s in rel.split("/") if s not in ("", ".")]
        for seg in segments:
            if seg.startswith(".") or seg == "_data":
                return self._finish(HTTPStatus.NOT_FOUND, self._send,
                                    "404 Not Found", "text/plain; charset=utf-8")

        target = os.path.realpath(os.path.join(self.app.site_dir, rel))

        # Directory-traversal protection: the resolved path must stay inside
        # the site root (or be the root itself).
        site_root = self.app.site_dir
        if target != site_root and not target.startswith(site_root + os.sep):
            return self._finish(HTTPStatus.NOT_FOUND, self._send,
                                "404 Not Found", "text/plain; charset=utf-8")

        # Never serve anything inside the data dir, even if it sits under the
        # site root (the documented default used to put it there). This is the
        # primary defense and holds regardless of --data location.
        data_root = self.app.data_dir
        if target == data_root or target.startswith(data_root + os.sep):
            return self._finish(HTTPStatus.NOT_FOUND, self._send,
                                "404 Not Found", "text/plain; charset=utf-8")

        # Directories resolve to their index.html.
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")

        if not os.path.isfile(target):
            return self._finish(HTTPStatus.NOT_FOUND, self._send,
                                "404 Not Found", "text/plain; charset=utf-8")

        ext = os.path.splitext(target)[1].lower()
        ctype = MIME_TYPES.get(ext, "application/octet-stream")
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            return self._finish(HTTPStatus.NOT_FOUND, self._send,
                                "404 Not Found", "text/plain; charset=utf-8")
        self._send(HTTPStatus.OK, data, ctype)
        self._log(HTTPStatus.OK)

    # -- API: auth ----------------------------------------------------------

    def _api_auth_google(self):
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json, {"error": "bad origin"})
        ok, raw = self._read_body()
        if not ok:
            self._log(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        try:
            payload = json.loads(raw or b"{}")
            credential = payload.get("credential")
        except (ValueError, AttributeError):
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "invalid request"})

        claims = self.app.verify(credential, self.app.client_id)
        if not claims:
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "invalid token"})

        email = claims.get("email")
        if email != self.app.allow_email or not _truthy(claims.get("email_verified")):
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "not authorized"})

        sid = self.app.create_session(email)
        cookie = self._set_cookie_header(sid, SESSION_TTL)
        self._json(HTTPStatus.OK, {"email": email, "editor": True},
                   {"Set-Cookie": cookie})
        self._log(HTTPStatus.OK)

    def _api_auth_logout(self):
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json, {"error": "bad origin"})
        self.app.delete_session(self._cookie_sid())
        cookie = self._set_cookie_header("", 0)
        self._json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})
        self._log(HTTPStatus.OK)

    def _api_me(self):
        rec = self._session()
        if rec:
            return self._finish(HTTPStatus.OK, self._json,
                                {"email": rec.get("email"), "editor": True})
        return self._finish(HTTPStatus.OK, self._json, {"email": None, "editor": False})

    # -- API: content -------------------------------------------------------

    def _api_get_content(self):
        exists, obj = self.app.read_content()
        if not exists:
            return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "no content"})
        return self._finish(HTTPStatus.OK, self._json, obj)

    def _api_put_content(self):
        if not self._session():
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "unauthorized"})
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json, {"error": "bad origin"})
        ok, raw = self._read_body()
        if not ok:
            self._log(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        try:
            obj = json.loads(raw or b"")
        except ValueError:
            return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                {"error": "invalid json"})
        if not isinstance(obj, dict):
            return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                {"error": "content must be an object"})
        self.app.write_content(obj)
        return self._finish(HTTPStatus.OK, self._json, {"ok": True})


# --- Server plumbing ---------------------------------------------------------

def make_server(app, host="127.0.0.1", port=8000):
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.app = app  # type: ignore[attr-defined]
    httpd.daemon_threads = True
    return httpd


def run(app, host, port):
    httpd = make_server(app, host, port)
    actual = httpd.server_address[1]
    sys.stderr.write(
        f"Serving {app.site_dir}\n"
        f"Data dir {app.data_dir}\n"
        f"Listening on http://{host}:{actual}  (allow-email: {app.allow_email}, "
        f"client-id: {'set' if app.client_id else 'MISSING — auth disabled'})\n"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nShutting down.\n")
    finally:
        httpd.server_close()


# --- Self test (no network) --------------------------------------------------

def selftest():
    """Drive a live server on an ephemeral port with a fake Google verifier."""
    import http.client
    import tempfile

    client_id = "test-client-id.apps.googleusercontent.com"
    allow_email = "truvord@gmail.com"
    good_credential = "GOOD-SENTINEL-CREDENTIAL"

    def fake_verify(credential, cid):
        if credential == good_credential:
            return {"email": allow_email, "email_verified": True, "aud": cid}
        if credential == "OTHER-EMAIL":
            return {"email": "someone.else@gmail.com", "email_verified": True, "aud": cid}
        return None

    tmpdir = tempfile.mkdtemp(prefix="server-selftest-")
    # A trivial site so static serving has something (not exercised here).
    with open(os.path.join(tmpdir, "index.html"), "w", encoding="utf-8") as fh:
        fh.write("<!doctype html><title>selftest</title>ok")

    app = App(site_dir=tmpdir, data_dir=os.path.join(tmpdir, "_data"),
              client_id=client_id, allow_email=allow_email, verify=fake_verify)
    httpd = make_server(app, "127.0.0.1", 0)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    results = []

    def check(name, condition):
        results.append((name, bool(condition)))

    def request(method, path, body=None, cookie=None, origin=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = f"{COOKIE_NAME}={cookie}"
        if origin:
            headers["Origin"] = origin
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        set_cookie = resp.getheader("Set-Cookie")
        conn.close()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        return resp.status, parsed, set_cookie

    def cookie_from(set_cookie):
        if not set_cookie:
            return None
        jar = SimpleCookie()
        jar.load(set_cookie)
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    origin = f"http://127.0.0.1:{port}"

    try:
        # 1. No content yet -> 404
        status, _, _ = request("GET", "/api/content")
        check("1. GET /api/content before write -> 404", status == 404)

        # 2. PUT content with no cookie -> 401
        status, _, _ = request("PUT", "/api/content", body={"x": 1}, origin=origin)
        check("2. PUT /api/content without session -> 401", status == 401)

        # 3a. Good sentinel -> 200 + Set-Cookie
        status, body, set_cookie = request(
            "POST", "/api/auth/google", body={"credential": good_credential},
            origin=origin)
        sid = cookie_from(set_cookie)
        check("3a. POST auth/google (good) -> 200 + cookie + editor:true",
              status == 200 and sid and body and body.get("editor") is True)

        # 3b. Bad credential -> 401, no cookie
        status, _, bad_cookie = request(
            "POST", "/api/auth/google", body={"credential": "NOPE"}, origin=origin)
        check("3b. POST auth/google (bad) -> 401 + no cookie",
              status == 401 and not cookie_from(bad_cookie))

        # 3c. Non-allowed email -> 401
        status, _, other_cookie = request(
            "POST", "/api/auth/google", body={"credential": "OTHER-EMAIL"},
            origin=origin)
        check("3c. POST auth/google (non-allowed email) -> 401 + no cookie",
              status == 401 and not cookie_from(other_cookie))

        # 4. /api/me with and without cookie
        status, body, _ = request("GET", "/api/me", cookie=sid)
        check("4a. GET /api/me with cookie -> editor:true",
              status == 200 and body.get("editor") is True
              and body.get("email") == allow_email)
        status, body, _ = request("GET", "/api/me")
        check("4b. GET /api/me without cookie -> editor:false",
              status == 200 and body.get("editor") is False
              and body.get("email") is None)

        # 5a. PUT content, valid cookie, mismatched Origin -> 403
        status, _, _ = request("PUT", "/api/content", body={"hero": "hi"},
                               cookie=sid, origin="http://evil.example.com")
        check("5a. PUT /api/content mismatched Origin -> 403", status == 403)

        # 5b. PUT content, valid cookie, matching Origin -> 200
        payload = {"hero": {"heading": "Hi"}, "n": 42}
        status, body, _ = request("PUT", "/api/content", body=payload,
                                  cookie=sid, origin=origin)
        check("5b. PUT /api/content matching Origin -> 200",
              status == 200 and body.get("ok") is True)

        # 5c. GET content returns the written object
        status, body, _ = request("GET", "/api/content")
        check("5c. GET /api/content returns the written object",
              status == 200 and body == payload)

        # 6. PUT non-object body -> 400
        status, _, _ = request("PUT", "/api/content", body=[1, 2, 3],
                               cookie=sid, origin=origin)
        check("6. PUT /api/content with non-object body -> 400", status == 400)

        # 7. Logout invalidates the session
        status, _, logout_cookie = request("POST", "/api/auth/logout",
                                           cookie=sid, origin=origin)
        cleared = SimpleCookie()
        if logout_cookie:
            cleared.load(logout_cookie)
        max_age = cleared.get(COOKIE_NAME)["max-age"] if cleared.get(COOKIE_NAME) else None
        check("7a. POST auth/logout -> 200 + cookie cleared (Max-Age=0)",
              status == 200 and str(max_age) == "0")
        status, body, _ = request("GET", "/api/me", cookie=sid)
        check("7b. GET /api/me after logout -> editor:false",
              status == 200 and body.get("editor") is False)

        # 8. The session store must NEVER be served over HTTP. In this selftest
        #    layout the data dir lives under the site root (tmpdir/_data), so a
        #    naive static handler would happily serve _data/sessions.json.
        assert os.path.exists(app.sessions_path), "sessions file should exist"
        s_dot, _, _ = request("GET", "/_data/sessions.json")
        s_content, _, _ = request("GET", "/_data/content.json")
        check("8. Session/content store not served over HTTP -> 404",
              s_dot == 404 and s_content == 404)

        # 9. verify_google_token must require a Google `iss` claim. Fake the
        #    network so this stays offline.
        import urllib.request as _urlreq

        class _FakeResp:
            def __init__(self, payload):
                self.status = 200
                self._data = json.dumps(payload).encode("utf-8")

            def read(self):
                return self._data

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_urlopen_factory(payload):
            def _fake(req, timeout=None):
                return _FakeResp(payload)
            return _fake

        base_claims = {
            "aud": client_id, "email": allow_email,
            "email_verified": "true", "exp": str(int(time.time()) + 3600),
        }
        orig_urlopen = _urlreq.urlopen
        try:
            _urlreq.urlopen = _fake_urlopen_factory(
                {**base_claims, "iss": "https://accounts.google.com"})
            iss_good = verify_google_token("x", client_id) is not None
            _urlreq.urlopen = _fake_urlopen_factory(
                {**base_claims, "iss": "https://evil.example.com"})
            iss_bad = verify_google_token("x", client_id) is None
            _urlreq.urlopen = _fake_urlopen_factory(dict(base_claims))  # no iss
            iss_missing = verify_google_token("x", client_id) is None
        finally:
            _urlreq.urlopen = orig_urlopen
        check("9. verify_google_token requires a Google iss claim",
              iss_good and iss_bad and iss_missing)

        # 10. Static serving of index.html still works.
        status, _, _ = request("GET", "/")
        check("10. GET / serves index.html -> 200", status == 200)

    finally:
        httpd.shutdown()
        httpd.server_close()

    print("\nSelftest results:")
    passed = 0
    for name, ok in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        passed += ok
    total = len(results)
    print(f"\n{passed}/{total} checks passed.")
    return passed == total


# --- CLI ---------------------------------------------------------------------

def parse_args(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="andreisuslov.com backend server")
    parser.add_argument("--site", default=here,
                        help="static files root (default: this file's directory)")
    parser.add_argument("--data", default=None,
                        help="writable dir for content.json / sessions.json "
                             "(default: a sibling of --site, OUTSIDE the served "
                             "root: <site>/../andreisuslov-site-data)")
    parser.add_argument("--client-id", default=None,
                        help="Google web OAuth client id (env GOOGLE_SITE_CLIENT_ID)")
    parser.add_argument("--allow-email", default="truvord@gmail.com",
                        help="the ONLY email allowed to authenticate")
    parser.add_argument("--host", default="127.0.0.1", help="bind host")
    parser.add_argument("--port", type=int, default=8000,
                        help="listen port (default 8000 — the OAuth-authorized origin)")
    parser.add_argument("--selftest", action="store_true",
                        help="run the in-process test suite and exit")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    if args.selftest:
        ok = selftest()
        return 0 if ok else 1

    client_id = args.client_id or os.environ.get("GOOGLE_SITE_CLIENT_ID")
    # Default the data dir to a sibling of the site root so it is never inside
    # the served document root.
    site_real = os.path.realpath(args.site)
    data_dir = args.data or os.path.join(os.path.dirname(site_real),
                                         "andreisuslov-site-data")
    app = App(site_dir=args.site, data_dir=data_dir,
              client_id=client_id, allow_email=args.allow_email)
    run(app, args.host, args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
