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
import datetime
import html
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Constants ---------------------------------------------------------------

COOKIE_NAME = "site_session"
SESSION_TTL = 30 * 24 * 60 * 60  # 30 days, in seconds
MAX_BODY = 1024 * 1024  # 1 MB cap on JSON request bodies
MAX_UPLOAD = 8 * 1024 * 1024  # 8 MB cap on uploaded image bodies
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}

# Accepted upload content-types -> the extension we store them under. The raw
# request Content-Type must match one of these exactly (case-insensitive, minus
# any charset/parameters); nothing else is written to disk.
UPLOAD_MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
# Reverse map used when serving an upload back out (extension -> content-type).
UPLOAD_EXT_MIME = {ext: mime for mime, ext in UPLOAD_MIME_EXT.items()}

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

# --- Blog: slugs and HTML sanitize -------------------------------------------

# A slug is both a filename (<data>/posts/<slug>.json) AND a URL segment, so it
# is validated against this strict regex on every read/write. It permits only
# lowercase letters, digits and hyphens, must start with an alphanumeric, and is
# capped at 81 chars. This makes path traversal (`../`, absolute paths, NUL,
# dots) structurally impossible — a valid slug can never contain a separator.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")

# HTML sanitize allow-list (stdlib HTMLParser, not regex). Everything not listed
# here is dropped. `<script>`/`<style>` are dropped WITH their contents; other
# disallowed tags are dropped but their text children are kept and escaped. Any
# `on*` event-handler attribute is stripped, and href/src URLs using
# javascript:/vbscript:/data: (except data:image/...) are neutralized. This is
# defense-in-depth for a single-author blog; the body still comes from a trusted
# editor (Quill, in C5b) and /uploads already sends nosniff.
SANITIZE_ALLOWED_TAGS = {
    "p", "br", "hr", "span", "div",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup",
    "a", "img",
    "ul", "ol", "li",
    "blockquote", "code", "pre",
}
# Per-tag attribute allow-list. Tags absent here keep no attributes at all.
SANITIZE_ALLOWED_ATTRS = {
    "a": {"href", "title", "target", "rel"},
    "img": {"src", "alt", "title", "width", "height"},
    "span": {"class"},
    "div": {"class"},
    "code": {"class"},
    "pre": {"class"},
    "ol": {"start"},
    "li": {"class"},
}
# Void elements are emitted self-closing and have no end tag.
SANITIZE_VOID_TAGS = {"br", "hr", "img"}
# Dropped WITH their contents (children discarded, not just the tag).
SANITIZE_DROP_TAGS = {"script", "style"}
# Attributes that carry URLs and must be scheme-checked.
SANITIZE_URL_ATTRS = {"href", "src"}

# Content-Security-Policy for the server-rendered blog pages. These pages run NO
# JavaScript and load only same-origin /style.css plus Google Fonts (the exact
# hosts _page_shell emits: fonts.googleapis.com for the CSS, fonts.gstatic.com
# for the woff2 files). img-src allows same-origin uploads and data: images
# (which the sanitizer permits inline). This makes any hypothetical future
# sanitizer gap inert — injected script simply cannot execute.
BLOG_CSP = (
    "default-src 'self'; "
    "script-src 'none'; "
    "style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' data:; "
    "base-uri 'none'; "
    "frame-ancestors 'none'"
)


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
        # Uploaded images live in a dedicated subdir of the data dir. This is the
        # ONLY part of the data dir ever served over HTTP (via GET /uploads/…);
        # the rest (sessions.json, content.json) stays unreachable.
        self.uploads_dir = os.path.join(self.data_dir, "uploads")
        # Blog posts live as one JSON file per slug under posts/. Never served
        # as static files — only through the /api/posts and /blog routes.
        self.posts_dir = os.path.join(self.data_dir, "posts")

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

    # --- uploads store ------------------------------------------------------

    def save_upload(self, name, ext, data):
        """Write `data` to <data>/uploads/<name><ext> atomically and return the
        public URL path (/uploads/<name><ext>). `name` is caller-generated and
        unguessable; `ext` comes from the validated content-type map."""
        os.makedirs(self.uploads_dir, exist_ok=True)
        filename = name + ext
        path = os.path.join(self.uploads_dir, filename)
        tmp = path + f".{os.getpid()}.tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return "/uploads/" + filename

    # --- posts store --------------------------------------------------------
    # All post file access goes through _post_path, which re-validates the slug
    # and confines the resolved path to posts_dir (defense-in-depth on top of
    # the SLUG_RE check callers already apply).

    def _post_path(self, slug):
        if not SLUG_RE.match(slug or ""):
            return None
        root = os.path.realpath(self.posts_dir)
        path = os.path.realpath(os.path.join(root, slug + ".json"))
        if not path.startswith(root + os.sep):
            return None
        return path

    def read_post(self, slug):
        """Return the post dict for `slug`, or None if absent/invalid."""
        path = self._post_path(slug)
        if not path:
            return None
        with self._lock:
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    obj = json.load(fh)
                    return obj if isinstance(obj, dict) else None
            except (FileNotFoundError, ValueError):
                return None

    def list_posts(self):
        """Return all post dicts (unsorted, unfiltered — caller decides)."""
        out = []
        with self._lock:
            try:
                names = os.listdir(self.posts_dir)
            except FileNotFoundError:
                names = []
            for name in names:
                if not name.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(self.posts_dir, name), "r",
                              encoding="utf-8") as fh:
                        obj = json.load(fh)
                except (OSError, ValueError):
                    continue
                if isinstance(obj, dict):
                    out.append(obj)
        return out

    def existing_slugs(self):
        with self._lock:
            try:
                return {n[:-5] for n in os.listdir(self.posts_dir)
                        if n.endswith(".json")}
            except FileNotFoundError:
                return set()

    def write_post(self, slug, obj):
        path = self._post_path(slug)
        if not path:
            return False
        with self._lock:
            os.makedirs(self.posts_dir, exist_ok=True)
            _atomic_write_json(path, obj)
        return True

    def delete_post(self, slug):
        path = self._post_path(slug)
        if not path:
            return False
        with self._lock:
            try:
                os.remove(path)
                return True
            except FileNotFoundError:
                return False


def _atomic_write_json(path, obj):
    """Write JSON to `path` atomically (temp file in the same dir + os.replace)."""
    directory = os.path.dirname(path)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


# --- Blog helpers: slug, sanitize, text, page rendering ----------------------

def slugify(title):
    """Derive a valid slug from a title: lowercase, non-alphanumerics -> single
    hyphens, trimmed. Falls back to "post" if nothing usable remains. Capped
    short enough that a "-2"/"-3" uniqueness suffix still satisfies SLUG_RE."""
    s = (title or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    s = s[:72].strip("-")
    if not s or not SLUG_RE.match(s):
        return "post"
    return s


def unique_slug(base, existing):
    """Return `base`, or base-2/base-3/... until it is not in `existing`."""
    slug = base
    n = 2
    while slug in existing:
        slug = f"{base}-{n}"
        n += 1
    return slug


def _safe_url(value, attr):
    """Return the URL if safe to keep, else None. Neutralizes javascript: and
    vbscript: everywhere. data: URLs are dropped entirely on `href` and allowed
    only as `data:image/...` on `src` (so inline images work but a data: link
    can't smuggle a navigable document). Leading control/whitespace chars
    (which browsers ignore when resolving the scheme) are stripped first."""
    v = (value or "").strip()
    # A scheme cannot contain these; stripping them prevents `java\tscript:` etc.
    probe = re.sub(r"[\x00-\x20]+", "", v).lower()
    if probe.startswith(("javascript:", "vbscript:")):
        return None
    if probe.startswith("data:"):
        # data: only ever allowed as an inline image source, never as a link.
        if attr == "src" and probe.startswith("data:image/"):
            return v
        return None
    return v


class _Sanitizer(HTMLParser):
    """Whitelist HTML sanitizer built on the stdlib parser (no regex on markup,
    no bleach). See SANITIZE_* constants for the allowed tag/attr set."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self._drop_depth = 0  # >0 while inside a script/style subtree

    def _render_start(self, tag, attrs, self_close):
        allowed = SANITIZE_ALLOWED_ATTRS.get(tag, ())
        parts = [tag]
        kept = {}  # lowercased attr name -> emitted value (for post-processing)
        for name, val in attrs:
            name = name.lower()
            if name.startswith("on") or name not in allowed:
                continue
            if val is None:
                parts.append(name)
                kept[name] = None
                continue
            if name in SANITIZE_URL_ATTRS:
                safe = _safe_url(val, name)
                if safe is None:
                    continue
                val = safe
            parts.append(f'{name}="{html.escape(val, quote=True)}"')
            kept[name] = val
        # Reverse-tabnabbing guard: any anchor that opens a new context must
        # carry rel="noopener noreferrer". Force it on output, merging with (and
        # de-duplicating) whatever rel the author supplied.
        if tag == "a" and (kept.get("target") or "").lower() == "_blank":
            tokens = (kept.get("rel") or "").split()
            for required in ("noopener", "noreferrer"):
                if required not in tokens:
                    tokens.append(required)
            rel_val = " ".join(tokens)
            if "rel" in kept:
                # Replace the rel attribute already appended above.
                parts = [p for p in parts if not p.startswith('rel="')]
            parts.append(f'rel="{html.escape(rel_val, quote=True)}"')
        inner = " ".join(parts)
        return f"<{inner} />" if self_close else f"<{inner}>"

    def handle_starttag(self, tag, attrs):
        if tag in SANITIZE_DROP_TAGS:
            self._drop_depth += 1
            return
        if self._drop_depth or tag not in SANITIZE_ALLOWED_TAGS:
            return
        self.out.append(
            self._render_start(tag, attrs, tag in SANITIZE_VOID_TAGS))

    def handle_startendtag(self, tag, attrs):
        if tag in SANITIZE_DROP_TAGS or self._drop_depth:
            return
        if tag not in SANITIZE_ALLOWED_TAGS:
            return
        self.out.append(self._render_start(tag, attrs, True))

    def handle_endtag(self, tag):
        if tag in SANITIZE_DROP_TAGS:
            if self._drop_depth:
                self._drop_depth -= 1
            return
        if self._drop_depth or tag not in SANITIZE_ALLOWED_TAGS:
            return
        if tag in SANITIZE_VOID_TAGS:
            return
        self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if self._drop_depth:
            return
        self.out.append(html.escape(data, quote=False))


def sanitize_html(raw):
    """Return a sanitized copy of `raw` HTML (see SANITIZE_* / _Sanitizer)."""
    if not raw:
        return ""
    parser = _Sanitizer()
    try:
        parser.feed(str(raw))
        parser.close()
    except Exception:
        # Never store un-sanitized markup: on any parse error, fall back to a
        # fully escaped (inert) version of the input.
        return html.escape(str(raw))
    return "".join(parser.out)


# Block-level tags: their boundaries become whitespace when flattening to text,
# so "<p>a</p><p>b</p>" reads "a b" (not "ab") in excerpts.
_TEXT_BLOCK_TAGS = {
    "p", "br", "hr", "div", "li", "ul", "ol", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6",
}


class _TextExtractor(HTMLParser):
    """Collects visible text (skipping script/style) for excerpt generation."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._drop_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in SANITIZE_DROP_TAGS:
            self._drop_depth += 1
        elif tag in _TEXT_BLOCK_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in SANITIZE_DROP_TAGS and self._drop_depth:
            self._drop_depth -= 1
        elif tag in _TEXT_BLOCK_TAGS:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._drop_depth:
            self.parts.append(data)


def html_to_text(raw):
    parser = _TextExtractor()
    try:
        parser.feed(str(raw or ""))
        parser.close()
    except Exception:
        return ""
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()


def make_excerpt(html_body, limit=200):
    text = html_to_text(html_body)
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip() + "…"


def clean_tags(value):
    """Coerce arbitrary input into a clean list of short string tags."""
    if not isinstance(value, list):
        return []
    out = []
    for tag in value:
        if isinstance(tag, str):
            tag = tag.strip()
            if tag:
                out.append(tag[:40])
    return out[:20]


def valid_date(value):
    """Return `value` if it is an ISO YYYY-MM-DD date, else None."""
    if not isinstance(value, str):
        return None
    try:
        datetime.date.fromisoformat(value)
        return value
    except ValueError:
        return None


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def post_summary(post, include_draft=False):
    """A list-view summary of a post (no full html)."""
    summary = {
        "slug": post.get("slug"),
        "title": post.get("title"),
        "excerpt": post.get("excerpt", ""),
        "date": post.get("date"),
        "tags": post.get("tags") or [],
    }
    if include_draft:
        summary["draft"] = bool(post.get("draft"))
    return summary


def _post_sort_key(post):
    # Newest first: order by publish date, then creation timestamp as tiebreak.
    return (post.get("date") or "", post.get("created") or "")


# --- Server-rendered public blog pages ---------------------------------------

_FAVICON = ("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' "
            "viewBox='0 0 100 100'><text y='.9em' font-size='90'>📝</text></svg>")


def _page_shell(page_title, body_html, description=""):
    """Wrap page body in the site chrome (nav, fonts, style.css). Matches
    index.html so blog pages inherit the site's look."""
    return (
        "<!DOCTYPE html>\n"
        "<html lang=\"en\">\n"
        "<head>\n"
        "  <meta charset=\"UTF-8\">\n"
        "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
        f"  <meta name=\"description\" content=\"{html.escape(description, quote=True)}\">\n"
        f"  <title>{html.escape(page_title)}</title>\n"
        f"  <link rel=\"icon\" href=\"{_FAVICON}\">\n"
        "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n"
        "  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n"
        "  <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n"
        "  <link rel=\"stylesheet\" href=\"/style.css\">\n"
        "</head>\n"
        "<body>\n"
        "  <nav class=\"nav\">\n"
        "    <div class=\"container\">\n"
        "      <a href=\"/\" class=\"nav__logo\">Andrei Suslov</a>\n"
        "    </div>\n"
        "  </nav>\n"
        f"  <main class=\"container\">\n{body_html}\n  </main>\n"
        "</body>\n"
        "</html>\n"
    )


def _render_meta(post):
    """The date + tags line shared by index and post pages (all text escaped)."""
    bits = []
    date = post.get("date")
    if date:
        bits.append(f"<time datetime=\"{html.escape(str(date), quote=True)}\">"
                    f"{html.escape(str(date))}</time>")
    tags = post.get("tags") or []
    if tags:
        spans = "".join(
            f"<span class=\"tag\">{html.escape(str(t))}</span>" for t in tags)
        bits.append(f"<span class=\"blog__tags\">{spans}</span>")
    if not bits:
        return ""
    return "<div class=\"blog__meta\">" + " ".join(bits) + "</div>"


def render_blog_index(posts):
    if posts:
        items = []
        for post in posts:
            slug = post.get("slug") or ""
            href = "/blog/" + urllib.parse.quote(slug)
            excerpt = post.get("excerpt") or ""
            items.append(
                "      <li class=\"blog__item\">\n"
                f"        <a class=\"blog__item-link\" href=\"{html.escape(href, quote=True)}\">"
                f"<h2 class=\"blog__item-title\">{html.escape(post.get('title') or slug)}</h2></a>\n"
                f"        {_render_meta(post)}\n"
                f"        <p class=\"blog__excerpt\">{html.escape(excerpt)}</p>\n"
                "      </li>"
            )
        body = ("    <section class=\"blog\">\n"
                "      <h1 class=\"blog__title\">Blog</h1>\n"
                "      <ul class=\"blog__list\">\n"
                + "\n".join(items) +
                "\n      </ul>\n    </section>")
    else:
        body = ("    <section class=\"blog\">\n"
                "      <h1 class=\"blog__title\">Blog</h1>\n"
                "      <p class=\"blog__empty\">No posts yet.</p>\n"
                "    </section>")
    return _page_shell("Blog — Andrei Suslov", body,
                       "Writing by Andrei Suslov.")


def render_blog_post(post):
    slug = post.get("slug") or ""
    title = post.get("title") or slug
    # The body was sanitized on store; inject it as-is (do NOT escape it).
    body = (
        "    <article class=\"post\">\n"
        f"      <h1 class=\"post__title\">{html.escape(title)}</h1>\n"
        f"      {_render_meta(post)}\n"
        f"      <div class=\"post__body\">{post.get('html') or ''}</div>\n"
        "      <p class=\"post__back\"><a href=\"/blog\">← Back to blog</a></p>\n"
        "    </article>"
    )
    description = post.get("excerpt") or make_excerpt(post.get("html") or "")
    return _page_shell(f"{title} — Andrei Suslov", body, description)


def render_blog_404():
    body = ("    <section class=\"blog\">\n"
            "      <h1 class=\"blog__title\">Not found</h1>\n"
            "      <p class=\"blog__empty\">That post doesn’t exist. "
            "<a href=\"/blog\">← Back to blog</a></p>\n"
            "    </section>")
    return _page_shell("Not found — Andrei Suslov", body)


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

    def _read_body(self, max_bytes=MAX_BODY):
        """Read the request body, enforcing a size cap.

        Returns (ok, bytes). When the body is too large, sends 413 and returns
        (False, b""). `max_bytes` defaults to the JSON cap; the upload route
        passes the larger image cap.
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length > max_bytes:
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
        if path == "/api/config":
            return self._api_config()
        if path == "/api/me":
            return self._api_me()
        if path == "/api/content":
            return self._api_get_content()
        if path == "/api/posts":
            return self._api_list_posts()
        if path.startswith("/api/posts/"):
            return self._api_get_post(path[len("/api/posts/"):])
        if path.startswith("/api/"):
            return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})
        # Server-rendered public blog pages (published posts only).
        if path == "/blog" or path == "/blog/":
            return self._blog_index()
        if path.startswith("/blog/"):
            return self._blog_post(path[len("/blog/"):])
        # Uploaded images are public and served from the data dir's uploads/
        # subdir (NOT the site root). Kept above _static so the site handler
        # never sees these paths.
        if path.startswith("/uploads/"):
            return self._serve_upload(path)
        # The admin console is a static shell (admin.html). It is NOT gated
        # server-side: the page gates its own UI client-side and the content
        # API stays auth-protected. Both /admin and /admin/ serve the same file.
        if path == "/admin" or path == "/admin/":
            return self._static("/admin.html")
        return self._static(path)

    def do_HEAD(self):
        # Serve headers only for static assets and blog pages; APIs are
        # GET/POST/PUT/DELETE. _send omits the body for HEAD automatically.
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/"):
            return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})
        if path == "/blog" or path == "/blog/":
            return self._blog_index()
        if path.startswith("/blog/"):
            return self._blog_post(path[len("/blog/"):])
        if path.startswith("/uploads/"):
            return self._serve_upload(path)
        return self._static(path)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/auth/google":
            return self._api_auth_google()
        if path == "/api/auth/logout":
            return self._api_auth_logout()
        if path == "/api/uploads":
            return self._api_upload()
        if path == "/api/posts":
            return self._api_create_post()
        return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})

    def do_PUT(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/content":
            return self._api_put_content()
        if path.startswith("/api/posts/"):
            return self._api_update_post(path[len("/api/posts/"):])
        return self._finish(HTTPStatus.NOT_FOUND, self._json, {"error": "not found"})

    def do_DELETE(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/posts/"):
            return self._api_delete_post(path[len("/api/posts/"):])
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

    # -- uploads: serve (public) --------------------------------------------

    def _serve_upload(self, url_path):
        """Serve a single file from <data>/uploads/. PUBLIC (uploaded page/blog
        images are meant to be public), but strictly confined to the uploads
        subdir: no subpaths, no dotfiles, and a realpath containment check so a
        crafted `/uploads/../…` can never escape into the rest of the data dir.
        """
        def not_found():
            return self._finish(HTTPStatus.NOT_FOUND, self._send,
                                "404 Not Found", "text/plain; charset=utf-8")

        rel = urllib.parse.unquote(url_path[len("/uploads/"):])
        # A single flat filename only: reject empties, dotfiles, path separators
        # (what `../` traversal would carry), and NUL bytes — an embedded NUL
        # (e.g. x%00.png) otherwise makes os.path.realpath raise ValueError.
        if (not rel or "/" in rel or "\\" in rel or "\x00" in rel
                or rel.startswith(".")):
            return not_found()

        uploads_root = os.path.realpath(self.app.uploads_dir)
        target = os.path.realpath(os.path.join(uploads_root, rel))
        # Containment: the resolved path must stay strictly inside uploads/.
        if not target.startswith(uploads_root + os.sep):
            return not_found()
        if not os.path.isfile(target):
            return not_found()

        ext = os.path.splitext(target)[1].lower()
        ctype = UPLOAD_EXT_MIME.get(ext) or MIME_TYPES.get(ext, "application/octet-stream")
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            return not_found()
        # Uploaded assets are immutable (unguessable names, never overwritten),
        # so they can be cached hard. nosniff stops a browser from ever sniffing
        # a mis-typed upload into executable same-origin content (these get
        # embedded in author-authored HTML).
        self._send(HTTPStatus.OK, data, ctype, {
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        })
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

    def _api_config(self):
        # Public: lets the front-end configure the Google Sign-In button without
        # hardcoding the web client id. Never cached — the id may change per env.
        return self._finish(HTTPStatus.OK, self._json,
                            {"googleClientId": self.app.client_id or ""})

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

    # -- API: posts ---------------------------------------------------------

    def _post_slug(self, raw):
        """Decode a slug from a URL path segment and validate it. Returns the
        slug, or None if it fails SLUG_RE (which is also what blocks traversal
        payloads like `..%2f..%2fsessions`)."""
        slug = urllib.parse.unquote(raw)
        return slug if SLUG_RE.match(slug) else None

    def _read_json_object(self):
        """Read + parse a JSON object body. Returns (obj, None) on success or
        (None, response_already_sent_flag) where the error response is sent
        here. Callers check `obj is None`."""
        ok, raw = self._read_body()
        if not ok:
            self._log(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None, True
        try:
            obj = json.loads(raw or b"")
        except ValueError:
            self._finish(HTTPStatus.BAD_REQUEST, self._json,
                         {"error": "invalid json"})
            return None, True
        if not isinstance(obj, dict):
            self._finish(HTTPStatus.BAD_REQUEST, self._json,
                         {"error": "body must be an object"})
            return None, True
        return obj, False

    def _api_list_posts(self):
        """List posts, newest first. Public callers see published summaries;
        the owner (valid session) additionally sees drafts, each flagged."""
        owner = self._session() is not None
        posts = sorted(self.app.list_posts(), key=_post_sort_key, reverse=True)
        items = [post_summary(p, include_draft=owner)
                 for p in posts if owner or not p.get("draft")]
        return self._finish(HTTPStatus.OK, self._json, {"posts": items})

    def _api_get_post(self, raw):
        slug = self._post_slug(raw)
        if not slug:
            return self._finish(HTTPStatus.NOT_FOUND, self._json,
                                {"error": "not found"})
        post = self.app.read_post(slug)
        # Drafts are invisible to the public — 404 (not 403) so their existence
        # isn't leaked; the owner sees them.
        if not post or (post.get("draft") and not self._session()):
            return self._finish(HTTPStatus.NOT_FOUND, self._json,
                                {"error": "not found"})
        return self._finish(HTTPStatus.OK, self._json, post)

    def _api_create_post(self):
        if not self._session():
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "unauthorized"})
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json,
                                {"error": "bad origin"})
        obj, _ = self._read_json_object()
        if obj is None:
            return
        title = str(obj.get("title") or "").strip()
        if not title:
            return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                {"error": "title required"})
        # Slug: accept an explicit valid + unused one, else derive from title
        # and disambiguate against existing files.
        supplied = obj.get("slug")
        if supplied not in (None, ""):
            slug = str(supplied)
            if not SLUG_RE.match(slug):
                return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                    {"error": "invalid slug"})
            if self.app.read_post(slug):
                return self._finish(HTTPStatus.CONFLICT, self._json,
                                    {"error": "slug already exists"})
        else:
            slug = unique_slug(slugify(title), self.app.existing_slugs())
        clean_html = sanitize_html(obj.get("html") or "")
        excerpt = str(obj.get("excerpt") or "").strip() or make_excerpt(clean_html)
        now = _now_iso()
        post = {
            "slug": slug,
            "title": title,
            "html": clean_html,
            "excerpt": excerpt,
            "tags": clean_tags(obj.get("tags")),
            "date": valid_date(obj.get("date")) or datetime.date.today().isoformat(),
            "created": now,
            "updated": now,
            "draft": bool(obj.get("draft")),
        }
        if not self.app.write_post(slug, post):
            return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                {"error": "invalid slug"})
        return self._finish(HTTPStatus.CREATED, self._json, post)

    def _api_update_post(self, raw):
        """Update an existing post. The slug is IMMUTABLE on PUT — only the
        listed fields are merged; html is re-sanitized and `updated` is bumped."""
        if not self._session():
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "unauthorized"})
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json,
                                {"error": "bad origin"})
        slug = self._post_slug(raw)
        post = self.app.read_post(slug) if slug else None
        if not post:
            return self._finish(HTTPStatus.NOT_FOUND, self._json,
                                {"error": "not found"})
        obj, _ = self._read_json_object()
        if obj is None:
            return
        if "title" in obj:
            title = str(obj.get("title") or "").strip()
            if not title:
                return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                    {"error": "title required"})
            post["title"] = title
        if "html" in obj:
            post["html"] = sanitize_html(obj.get("html") or "")
        if "excerpt" in obj:
            post["excerpt"] = str(obj.get("excerpt") or "").strip()
        if "tags" in obj:
            post["tags"] = clean_tags(obj.get("tags"))
        if "date" in obj:
            date = valid_date(obj.get("date"))
            if date:
                post["date"] = date
        if "draft" in obj:
            post["draft"] = bool(obj.get("draft"))
        post["slug"] = slug  # never changes
        post["updated"] = _now_iso()
        self.app.write_post(slug, post)
        return self._finish(HTTPStatus.OK, self._json, post)

    def _api_delete_post(self, raw):
        if not self._session():
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "unauthorized"})
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json,
                                {"error": "bad origin"})
        slug = self._post_slug(raw)
        if not slug or not self.app.delete_post(slug):
            return self._finish(HTTPStatus.NOT_FOUND, self._json,
                                {"error": "not found"})
        return self._finish(HTTPStatus.OK, self._json, {"ok": True})

    # -- Public blog pages (server-rendered HTML) ---------------------------

    def _send_blog(self, status, body):
        """Send a server-rendered blog page with a strict Content-Security-
        Policy. These pages carry no JS, so the CSP is defense-in-depth against
        any future sanitizer gap."""
        self._send(status, body, "text/html; charset=utf-8",
                   {"Content-Security-Policy": BLOG_CSP})
        self._log(status)

    def _blog_index(self):
        posts = [p for p in self.app.list_posts() if not p.get("draft")]
        posts.sort(key=_post_sort_key, reverse=True)
        self._send_blog(HTTPStatus.OK, render_blog_index(posts))

    def _blog_post(self, raw):
        slug = self._post_slug(raw)
        post = self.app.read_post(slug) if slug else None
        if not post or post.get("draft"):
            return self._send_blog(HTTPStatus.NOT_FOUND, render_blog_404())
        self._send_blog(HTTPStatus.OK, render_blog_post(post))

    # -- API: uploads (auth'd write) ----------------------------------------

    def _api_upload(self):
        """Accept a RAW image body (not multipart — cgi is gone in 3.13) and
        store it under an unguessable name. Requires a valid session and a
        same-origin request, mirroring the content-write protections.
        """
        if not self._session():
            return self._finish(HTTPStatus.UNAUTHORIZED, self._json,
                                {"error": "unauthorized"})
        if not self._origin_ok():
            return self._finish(HTTPStatus.FORBIDDEN, self._json, {"error": "bad origin"})
        # Validate the declared type BEFORE reading the body. On rejection we do
        # not drain the (possibly large) body, so close the connection to avoid
        # desyncing the next keep-alive request.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        ext = UPLOAD_MIME_EXT.get(ctype)
        if not ext:
            self.close_connection = True
            return self._finish(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, self._json,
                                {"error": "unsupported content-type"},
                                {"Connection": "close"})
        ok, raw = self._read_body(MAX_UPLOAD)
        if not ok:
            self._log(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        if not raw:
            return self._finish(HTTPStatus.BAD_REQUEST, self._json,
                                {"error": "empty body"})
        url = self.app.save_upload(secrets.token_urlsafe(16), ext, raw)
        return self._finish(HTTPStatus.OK, self._json, {"url": url})


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
    # The admin shell served at /admin.
    with open(os.path.join(tmpdir, "admin.html"), "w", encoding="utf-8") as fh:
        fh.write("<!doctype html><title>admin selftest</title>admin-ok")

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

        # 11. /api/config exposes the configured client id (public, no auth).
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/api/config")
        cfg_resp = conn.getresponse()
        cfg_body = json.loads(cfg_resp.read())
        cfg_cache = cfg_resp.getheader("Cache-Control")
        conn.close()
        check("11. GET /api/config returns the configured client id (no-store)",
              cfg_resp.status == 200
              and cfg_body.get("googleClientId") == client_id
              and cfg_cache == "no-store")

        # 12. /admin (and /admin/) serve the admin shell as HTML, ungated.
        def get_html(path):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", path)
            resp = conn.getresponse()
            body = resp.read()
            ctype = resp.getheader("Content-Type") or ""
            conn.close()
            return resp.status, ctype, body

        a_status, a_ctype, a_body = get_html("/admin")
        s_status, _, _ = get_html("/admin/")
        check("12. GET /admin (and /admin/) serve admin.html as HTML -> 200",
              a_status == 200 and s_status == 200
              and "text/html" in a_ctype and b"admin-ok" in a_body)

        # --- uploads ------------------------------------------------------
        # A minimal but valid 1x1 PNG. The server validates the declared
        # Content-Type, not the bytes, but a real image keeps the test honest.
        png = bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
        )

        def raw_request(method, path, body=None, content_type=None,
                        cookie=None, origin=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            headers = {}
            if content_type:
                headers["Content-Type"] = content_type
            if cookie:
                headers["Cookie"] = f"{COOKIE_NAME}={cookie}"
            if origin:
                headers["Origin"] = origin
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            status = resp.status
            resp_ctype = resp.getheader("Content-Type")
            conn.close()
            return status, raw, resp_ctype

        # Fresh session (the earlier `sid` was invalidated by the logout in 7).
        _, _, up_cookie = request(
            "POST", "/api/auth/google", body={"credential": good_credential},
            origin=origin)
        up_sid = cookie_from(up_cookie)

        # 13. Upload without a session -> 401.
        s13, _, _ = raw_request("POST", "/api/uploads", body=png,
                                content_type="image/png", origin=origin)
        check("13. POST /api/uploads without session -> 401", s13 == 401)

        # 14. Upload with a disallowed content-type -> 415.
        s14, _, _ = raw_request("POST", "/api/uploads", body=b"nope",
                                content_type="text/plain", cookie=up_sid,
                                origin=origin)
        check("14. POST /api/uploads with disallowed content-type -> 415",
              s14 == 415)

        # 15. Successful upload -> 200 + /uploads/ url; then the file is
        #     retrievable (publicly, no cookie) with the right content-type.
        s15, body15, _ = raw_request("POST", "/api/uploads", body=png,
                                     content_type="image/png", cookie=up_sid,
                                     origin=origin)
        up_url = None
        try:
            up_url = json.loads(body15).get("url")
        except (ValueError, AttributeError):
            up_url = None
        upload_ok = (s15 == 200 and isinstance(up_url, str)
                     and up_url.startswith("/uploads/"))
        get_status, get_body, get_ctype = (
            raw_request("GET", up_url) if upload_ok else (None, None, None))
        check("15. POST /api/uploads (valid) -> url, then GET serves the image",
              upload_ok and get_status == 200 and get_ctype == "image/png"
              and get_body == png)

        # 16. Path traversal out of uploads/ is blocked. Point at the sessions
        #     store, which really exists one level up in the data dir.
        s16, _, _ = raw_request("GET", "/uploads/../sessions.json")
        check("16. GET /uploads/../sessions.json (traversal) -> 404",
              s16 == 404)

        # 17. An embedded NUL in the name must be rejected as 404 (not raise a
        #     ValueError from os.path.realpath -> uncaught 500).
        s17, _, _ = raw_request("GET", "/uploads/x%00.png")
        check("17. GET /uploads/x%00.png (null byte) -> 404", s17 == 404)

        # 18. Served uploads carry X-Content-Type-Options: nosniff so a browser
        #     never sniffs a mis-typed upload into executable same-origin content.
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", up_url)
        nosniff_resp = conn.getresponse()
        nosniff_resp.read()
        nosniff = nosniff_resp.getheader("X-Content-Type-Options")
        conn.close()
        check("18. GET /uploads/<file> sends X-Content-Type-Options: nosniff",
              (nosniff or "").lower() == "nosniff")

        # --- blog posts ---------------------------------------------------
        # `up_sid` (from the uploads section) is a valid owner session.

        # 19. Create without a session -> 401.
        s19, _, _ = request("POST", "/api/posts",
                            body={"title": "Hello World", "html": "<p>hi</p>"},
                            origin=origin)
        check("19. POST /api/posts without session -> 401", s19 == 401)

        # 20. Create with a session -> 201, slug generated from the title.
        s20, b20, _ = request("POST", "/api/posts",
                             body={"title": "Hello World",
                                   "html": "<p>hello body</p>"},
                             cookie=up_sid, origin=origin)
        slug1 = b20.get("slug") if b20 else None
        check("20. POST /api/posts (session) -> 201 + slug from title",
              s20 == 201 and slug1 == "hello-world"
              and b20.get("created") and b20.get("updated"))

        # 21. Same title again -> a distinct, unique slug.
        s21, b21, _ = request("POST", "/api/posts",
                             body={"title": "Hello World",
                                   "html": "<p>second</p>"},
                             cookie=up_sid, origin=origin)
        slug2 = b21.get("slug") if b21 else None
        check("21. Second same-title post -> distinct slug",
              s21 == 201 and slug2 == "hello-world-2" and slug2 != slug1)

        # 22. Create a draft.
        s22, b22, _ = request("POST", "/api/posts",
                             body={"title": "Secret Draft",
                                   "html": "<p>wip</p>", "draft": True},
                             cookie=up_sid, origin=origin)
        draft_slug = b22.get("slug") if b22 else None
        check("22. Create a draft -> 201 + draft slug",
              s22 == 201 and draft_slug == "secret-draft"
              and b22.get("draft") is True)

        # 23. Public list hides drafts; owner list shows them flagged.
        _, pub_list, _ = request("GET", "/api/posts")
        pub_slugs = {p["slug"] for p in (pub_list or {}).get("posts", [])}
        _, own_list, _ = request("GET", "/api/posts", cookie=up_sid)
        own_posts = (own_list or {}).get("posts", [])
        own_slugs = {p["slug"] for p in own_posts}
        own_draft_flag = any(p["slug"] == draft_slug and p.get("draft") is True
                             for p in own_posts)
        no_html_in_summary = all("html" not in p for p in own_posts)
        check("23. Public list hides drafts; owner sees them flagged (no html)",
              draft_slug not in pub_slugs and slug1 in pub_slugs
              and draft_slug in own_slugs and own_draft_flag
              and no_html_in_summary)

        # 24. Single draft: 404 for the public, 200 for the owner.
        s24pub, _, _ = request("GET", "/api/posts/" + draft_slug)
        s24own, b24own, _ = request("GET", "/api/posts/" + draft_slug,
                                    cookie=up_sid)
        check("24. GET draft post -> 404 public, 200 owner",
              s24pub == 404 and s24own == 200
              and b24own.get("slug") == draft_slug)

        # 25. Sanitizer: a <script> in submitted html is stripped on store.
        s25, b25, _ = request("POST", "/api/posts",
                             body={"title": "Script Test",
                                   "html": "<p>ok</p><script>alert(1)</script>"
                                           "<a href=\"javascript:evil()\">x</a>"},
                             cookie=up_sid, origin=origin)
        stored_html = b25.get("html", "") if b25 else ""
        check("25. Sanitizer strips <script> and javascript: URLs on store",
              s25 == 201 and "<script" not in stored_html
              and "alert(1)" not in stored_html and "ok" in stored_html
              and "javascript:" not in stored_html)

        # 26. PUT is auth-gated; with a session it updates and bumps `updated`.
        s26no, _, _ = request("PUT", "/api/posts/" + slug2,
                              body={"title": "Renamed"}, origin=origin)
        s26yes, b26, _ = request("PUT", "/api/posts/" + slug2,
                                body={"title": "Renamed"}, cookie=up_sid,
                                origin=origin)
        check("26. PUT /api/posts/<slug> -> 401 no session, 200 owner (slug kept)",
              s26no == 401 and s26yes == 200
              and b26.get("title") == "Renamed" and b26.get("slug") == slug2)

        # 27. DELETE is auth-gated; with a session it removes the file.
        s27no, _, _ = request("DELETE", "/api/posts/" + slug2, origin=origin)
        s27yes, _, _ = request("DELETE", "/api/posts/" + slug2, cookie=up_sid,
                               origin=origin)
        s27gone, _, _ = request("GET", "/api/posts/" + slug2)
        file_gone = not os.path.exists(
            os.path.join(app.posts_dir, slug2 + ".json"))
        check("27. DELETE -> 401 no session, 200 owner, file removed",
              s27no == 401 and s27yes == 200 and s27gone == 404 and file_gone)

        # 28. Blog index renders HTML.
        bi_status, bi_ctype, bi_body = get_html("/blog")
        check("28. GET /blog -> 200 HTML",
              bi_status == 200 and "text/html" in bi_ctype
              and b"Blog" in bi_body and slug1.encode() in bi_body)

        # 29. Published post page renders and contains the title.
        bp_status, bp_ctype, bp_body = get_html("/blog/" + slug1)
        check("29. GET /blog/<published> -> 200 + contains title",
              bp_status == 200 and "text/html" in bp_ctype
              and b"Hello World" in bp_body and b"hello body" in bp_body)

        # 30. Draft and nonexistent post pages -> 404.
        bd_status, _, _ = get_html("/blog/" + draft_slug)
        bn_status, _, _ = get_html("/blog/does-not-exist")
        check("30. GET /blog/<draft> and /blog/<missing> -> 404",
              bd_status == 404 and bn_status == 404)

        # 31. Slug traversal is rejected and the posts dir never escaped.
        st_api, _, _ = request("GET", "/api/posts/..%2f..%2fsessions")
        st_put, _, _ = request("PUT", "/api/posts/..%2f..%2fsessions",
                              body={"title": "x"}, cookie=up_sid, origin=origin)
        st_post, _, _ = request("POST", "/api/posts",
                              body={"title": "x", "slug": "../evil"},
                              cookie=up_sid, origin=origin)
        posts_files = sorted(os.listdir(app.posts_dir))
        confined = all(SLUG_RE.match(n[:-5]) for n in posts_files
                       if n.endswith(".json"))
        check("31. Slug traversal rejected; posts dir stays confined",
              st_api == 404 and st_put == 404 and st_post == 400 and confined)

        # --- defense-in-depth hardening -----------------------------------

        # 32. Server-rendered blog pages carry the strict CSP header.
        def header_of(path, name):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", path)
            resp = conn.getresponse()
            resp.read()
            val = resp.getheader(name)
            conn.close()
            return val

        csp_index = header_of("/blog", "Content-Security-Policy")
        csp_post = header_of("/blog/" + slug1, "Content-Security-Policy")
        csp_404 = header_of("/blog/does-not-exist", "Content-Security-Policy")
        check("32. /blog, /blog/<slug> and blog 404 send the strict CSP header",
              csp_index == BLOG_CSP and csp_post == BLOG_CSP
              and csp_404 == BLOG_CSP
              and "script-src 'none'" in (csp_index or "")
              and "fonts.googleapis.com" in (csp_index or "")
              and "fonts.gstatic.com" in (csp_index or ""))

        # 33. target="_blank" anchors get rel="noopener noreferrer" on store.
        _, b33, _ = request("POST", "/api/posts",
                           body={"title": "Tab Nabbing",
                                 "html": "<a href=\"/x\" target=\"_blank\">go</a>"},
                           cookie=up_sid, origin=origin)
        html33 = b33.get("html", "") if b33 else ""
        check("33. target=_blank anchor forced to rel=noopener noreferrer",
              'target="_blank"' in html33 and "noopener" in html33
              and "noreferrer" in html33)

        # 34. data:text/html on href is dropped; data:image on src is kept.
        _, b34, _ = request("POST", "/api/posts",
                           body={"title": "Data URLs",
                                 "html": "<a href=\"data:text/html,<b>x</b>\">l</a>"
                                         "<img src=\"data:image/png;base64,AAAA\" "
                                         "alt=\"i\">"},
                           cookie=up_sid, origin=origin)
        html34 = b34.get("html", "") if b34 else ""
        check("34. data: href dropped; data:image src kept",
              "data:text/html" not in html34
              and "data:image/png;base64,AAAA" in html34)

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
