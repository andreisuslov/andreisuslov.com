# andreisuslov.com

Source for my personal site — a portfolio homepage plus a small blog, served by
a single stdlib-only Python backend and edited through a Google-gated admin
console.

## Homepage: a block document

The homepage is a **document of blocks**, not hand-written markup. Each block
has a stable `id`, a `type` (`portrait`, `heading`, `richtext`, `list`,
`projects`, `experience`, `socials`, `image`), and typed fields:

```js
{ version: 1, blocks: [ { id: "hero-heading", type: "heading", level: 1, text: "Hi, I'm Andrei" }, ... ] }
```

- `content-default.js` exposes `DEFAULT_CONTENT`, the default document that
  reproduces the site. The public page renders it immediately (no blank flash),
  then fetches `GET /api/content` and re-renders from the saved document if one
  exists.
- `script.js` renders blocks read-only into `#content` and wires the scroll
  reveal and hover face-swap. It never mutates content.
- `index.html` is just the shell (nav + `#content`) and a Content-Security-Policy.
- `style.css` / `face-serious.webp` / `face-happy.webp` — styles and the hero
  portrait (the grinning face swaps in on hover).

### Canvas layout (free positioning)

A doc may carry `layout: {mode: "canvas", width}` plus per-block
`frame: {x, y, w}` (design-space px, height always auto). `script.js` then
positions blocks absolutely inside a `.canvas` div: scale-to-fit shrinks the
whole composition on viewports narrower than the design width, and below 768px
frames are ignored entirely — blocks stack in array order (kept y-sorted on
save), which is exactly the old mobile layout. Docs without `layout` render
through the original flow path unchanged.

## On-page visual builder (`editor.js`)

The signed-in owner sees a floating **Edit** button on the homepage
(`/api/me` gate); clicking it lazy-loads `editor.js` + `editor.css` — visitors
never fetch them. The first activation on a flow doc migrates it to canvas by
measuring the live rendering (nothing persists until Save). In the editor:

- click selects; drag moves (`frame.x/y`); edge handles resize width; snap
  guides against the canvas and other blocks (Alt disables)
- double-click edits text in place: headings, paragraphs (with a small
  bold/italic/link toolbar), list items (Enter/Backspace add/remove), card
  names/subtitles/descriptions, tag chips; card ×/+ and social +/edit
  affordances appear in edit mode
- ⌘Z/⇧⌘Z undo/redo per gesture; Save PUTs to `/api/content` (y-sorting blocks
  so mobile order matches), Discard/Exit recover the last saved state
- no native alert/confirm/prompt — toasts, two-step confirms, and a floating
  input panel instead (they'd block the renderer)

`/admin` (below) remains as the structural/fallback editor; it preserves the
`layout`/`frame` fields it doesn't know about, and blocks added there are
auto-stacked below the canvas until the next on-page save frames them.

## Admin console (`/admin`)

`admin.html` + `admin.js` are a client-gated console for the site owner. Sign in
with Google (restricted to one allow-listed email); the API stays
auth-protected regardless of the client-side gate. It has two views:

- **Page** — a block editor for the homepage document (`richtext` blocks use a
  vendored Quill 2 editor, no runtime CDN). Saves via `PUT /api/content`.
- **Blog** — create/edit/delete posts (Quill body, tags, publish date, draft
  flag) via the posts API.

## Blog (`/blog`)

Posts are server-rendered HTML at `/blog` (index) and `/blog/<slug>` (post).
Each post is one JSON file under the data dir's `posts/`, never served as a
static file. Drafts are visible only to the authenticated owner (404 to the
public). Post HTML is sanitized on store (stdlib allow-list parser) and the
public pages carry a strict CSP.

## Backend (`server.py`)

A single-file, stdlib-only Python 3.11+ server (`http.server`, no third-party
deps). It:

1. serves the static site and uploaded images,
2. authenticates the owner via Google Sign-In (ID-token flow, one allowed
   email), and
3. exposes the content, posts, and uploads APIs.

Endpoints:

| Route | Method(s) | Notes |
| --- | --- | --- |
| `/api/config` | GET | public web OAuth client id for the Sign-In button |
| `/api/auth/google`, `/api/auth/logout` | POST | session cookie login / logout |
| `/api/me` | GET | current session (`{email, editor}`) |
| `/api/content` | GET / PUT | homepage block document (PUT is auth'd, same-origin, and sanitized on store) |
| `/api/posts`, `/api/posts/<slug>` | GET / POST / PUT / DELETE | blog posts (writes auth'd; HTML sanitized) |
| `/api/uploads` | POST | auth'd raw-image upload → `/uploads/<name>` |
| `/blog`, `/blog/<slug>` | GET | server-rendered public blog pages |

Writes require a valid session cookie **and** a same-origin `Origin`; content
and post HTML is sanitized before it is written to disk.

## Run it locally

```bash
# Static serving works without a client id; sign-in needs the web OAuth client id.
GOOGLE_SITE_CLIENT_ID=… python3 server.py --port 8000 --data ./_data
# open http://localhost:8000  (admin at http://localhost:8000/admin)
```

`--data` is the writable dir for `content.json`, `sessions.json`, `posts/`, and
`uploads/`. **Its real default is a sibling of the site root outside the served
tree** (`<site>/../andreisuslov-site-data`), so the session store is never
inside the document root. For local dev, `--data ./_data` keeps everything in
the repo — `_data/` is gitignored, and the static handler refuses to serve the
data dir, dotfiles, and any `_data` path regardless.

Run the in-process test suite (no network):

```bash
python3 server.py --selftest
```
