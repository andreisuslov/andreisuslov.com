# andreisuslov.com

Source for my personal site — a static, single-page portfolio.

## Structure

- `index.html` — page shell and markup
- `data.js` — all site content (hero, about, projects, experience, contact) in one object
- `script.js` — renders the content into the DOM and handles scroll/hover effects
- `style.css` — styles and responsive layout
- `face-serious.webp` / `face-happy.webp` — hero portrait; the grinning face swaps in on hover

To change copy or add a project, edit `data.js`. No build step.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Backend

`server.py` is a single-file, stdlib-only Python 3 server (`http.server`). It
serves the static site, authenticates the owner via Google Sign-In (ID-token
flow, restricted to one email), and exposes a small content API
(`GET`/`PUT /api/content`) the front-end uses to load and save `content.json`.

Run it locally (a Google web OAuth client id is needed only for sign-in;
static serving works without one):

```bash
GOOGLE_SITE_CLIENT_ID=… python3 server.py --port 8000
# open http://localhost:8000
```

Content and sessions are written under `--data`. The default is a sibling of
the site root (`<site>/../andreisuslov-site-data`) so the session store is
never inside the served document root — the static handler also refuses to
serve the data dir, dotfiles, and any `_data` path. Run the in-process test
suite (no network) with:

```bash
python3 server.py --selftest
```
