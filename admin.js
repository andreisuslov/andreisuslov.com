// Admin console shell (Task C2). This is the /admin page's only script — it
// never loads or touches the public render path (script.js) or the retired
// in-page editor (editor.js). For now the console is READ-ONLY: it authenticates
// the owner, loads the current block document, and lists the blocks. Editing,
// drag/reorder, WYSIWYG and Save arrive in C3.
//
// Everything lives inside this IIFE so admin identifiers stay off the global
// scope. The sign-in flow mirrors editor.js exactly (lazy GIS + /api/config +
// /api/auth/google). A tiny `window.__admin` hook exposes `start()` so the auth
// gate can be re-driven (e.g. after a mocked /api/me in tests) without a reload.
(function () {
  "use strict";

  const root = document.getElementById("admin-root");
  let gisPromise = null;

  // The working document (set once the dashboard loads content). C3 mutates it.
  // It is ONLY non-null when we truly know the server's state: either the server
  // has no content yet (404 -> DEFAULT_CONTENT) or it returned a real document.
  // On any load error `doc` stays null and `loadError` is set, so C3's Save path
  // can refuse to overwrite unknown server state with defaults.
  let doc = null;
  let loadError = false;

  // --- tiny DOM helpers ---------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clearRoot() {
    root.replaceChildren();
  }

  // --- block previews -----------------------------------------------------

  // Strip HTML to plain text for the preview. DOMParser builds an INERT
  // document: unlike innerHTML on a live node, it never loads resources or runs
  // scripts, so parsing owner-authored richtext to read its words is safe.
  function stripTags(html) {
    const parsed = new DOMParser().parseFromString(html || "", "text/html");
    return (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + "…";
  }

  // A short human preview for one block, keyed by type. Unknown types fall back
  // to a neutral label so a stray block never throws.
  function blockPreview(block) {
    const type = block && block.type;
    switch (type) {
      case "portrait":
        return "portrait — " + (block.width ?? 180) + "px wide, offset " +
          (block.offsetX ?? 212) + "px";
      case "heading":
        return truncate(block.text || "", 80) || "(empty heading)";
      case "richtext":
        return truncate(stripTags(block.html), 80) || "(empty)";
      case "list":
        return count(block.items) + " items";
      case "projects":
      case "experience":
        return count(block.items) + " cards";
      case "socials":
        return count(block.items) + " links";
      default:
        return "";
    }
  }

  function count(arr) {
    return Array.isArray(arr) ? arr.length : 0;
  }

  // --- dashboard (READ-ONLY for C2) --------------------------------------

  function renderDashboard(me) {
    clearRoot();

    const shell = el("div", "admin-shell");

    // Header bar: title, signed-in email, sign-out.
    const header = el("header", "admin-header");
    header.appendChild(el("span", "admin-header__title", "Admin"));

    const right = el("div", "admin-header__right");
    right.appendChild(el("span", "admin-header__email", (me && me.email) || ""));
    const signOutBtn = el("button", "admin-btn admin-btn--ghost", "Sign out");
    signOutBtn.type = "button";
    signOutBtn.addEventListener("click", signOut);
    right.appendChild(signOutBtn);
    header.appendChild(right);
    shell.appendChild(header);

    const main = el("main", "admin-main");
    main.appendChild(el("p", "admin-note",
      "Read-only preview of the homepage document. Editing coming in the next step."));

    // The block list is filled once content loads; show it immediately with a
    // placeholder so the layout never flashes empty.
    const list = el("div", "admin-blocks");
    list.appendChild(el("p", "admin-note", "Loading content…"));
    main.appendChild(list);

    shell.appendChild(main);
    root.appendChild(shell);

    loadContent().then((result) => {
      loadError = !!result.error;
      doc = result.doc;
      if (loadError) {
        renderLoadError(list);
      } else {
        renderBlockList(list, doc);
      }
    });
  }

  // Load the server document, distinguishing the failure modes so C3's Save path
  // never overwrites unknown server state with defaults. Resolves to
  // { doc, error }:
  //   - 404               -> first run, nothing saved yet: seed DEFAULT_CONTENT.
  //                          This is the ONLY case that silently uses defaults.
  //   - ok + {blocks:[…>0]} -> the authoritative server document.
  //   - any other non-ok (500/503/…), a network failure, bad JSON, or an ok
  //     response that isn't a non-empty block doc -> { doc:null, error:true }.
  //     doc stays null so a future Save can refuse until server state is known.
  function loadContent() {
    return fetch("/api/content", { credentials: "same-origin" })
      .then((res) => {
        if (res.status === 404) {
          return { doc: DEFAULT_CONTENT, error: false };
        }
        if (!res.ok) {
          return { doc: null, error: true };
        }
        return res.json().then((content) => {
          if (
            content &&
            typeof content === "object" &&
            Array.isArray(content.blocks) &&
            content.blocks.length > 0
          ) {
            return { doc: content, error: false };
          }
          // 200 but not a usable block doc (empty/truncated/malformed). Treat as
          // unknown state, NOT a silent reset to defaults.
          return { doc: null, error: true };
        });
      })
      .catch(() => ({ doc: null, error: true }));
  }

  // Visible error state shown in the dashboard body when content can't be loaded
  // and defaults must NOT be substituted. Leaves `doc` null (set by the caller).
  function renderLoadError(container) {
    container.replaceChildren();
    const box = el("div", "admin-error");
    box.appendChild(el("p", "admin-error__msg",
      "Couldn't load your content — the server returned an error. " +
      "Reload to try again."));
    const retry = el("button", "admin-btn", "Reload");
    retry.type = "button";
    retry.addEventListener("click", () => location.reload());
    box.appendChild(retry);
    container.appendChild(box);
  }

  function renderBlockList(container, document_) {
    container.replaceChildren();
    const blocks = (document_ && Array.isArray(document_.blocks))
      ? document_.blocks
      : [];

    if (blocks.length === 0) {
      container.appendChild(el("p", "admin-note", "No blocks."));
      return;
    }

    blocks.forEach((block, i) => {
      const row = el("div", "admin-block");

      const badge = el("span", "admin-block__badge", block.type || "?");
      row.appendChild(badge);

      const body = el("div", "admin-block__body");
      body.appendChild(el("div", "admin-block__preview", blockPreview(block)));
      if (block.id) {
        body.appendChild(el("div", "admin-block__id", block.id));
      }
      row.appendChild(body);

      row.appendChild(el("span", "admin-block__index", "#" + (i + 1)));
      container.appendChild(row);
    });
  }

  // --- sign-in screen (mirrors editor.js's GIS flow) ----------------------

  function renderSignIn(message) {
    clearRoot();

    const wrap = el("div", "admin-signin");
    const card = el("div", "admin-signin__card");
    card.appendChild(el("h1", "admin-signin__title", "Admin"));
    card.appendChild(el("p", "admin-signin__sub",
      "Sign in with Google to manage this site."));

    const host = el("div", "admin-signin__button");
    card.appendChild(host);

    const msg = el("div", "admin-signin__msg");
    if (message) msg.textContent = message;
    card.appendChild(msg);

    wrap.appendChild(card);
    root.appendChild(wrap);

    function setMsg(text) {
      msg.textContent = text;
    }

    fetch("/api/config", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((cfg) => {
        const clientId = cfg && cfg.googleClientId;
        if (!clientId) {
          setMsg("Sign-in is unavailable (no client id configured).");
          return null;
        }
        return loadGis().then(() => clientId);
      })
      .then((clientId) => {
        if (!clientId) return;
        if (!window.google || !google.accounts || !google.accounts.id) {
          setMsg("Google Sign-In failed to initialize.");
          return;
        }
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp) => onGoogleCredential(resp, setMsg),
        });
        google.accounts.id.renderButton(host, {
          theme: "outline",
          size: "large",
          text: "signin_with",
        });
      })
      .catch(() => setMsg("Could not load Google Sign-In."));
  }

  // Inject Google Identity Services exactly once, on demand. No third-party
  // script loads until the sign-in path needs it.
  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("gsi load failed"));
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  // Exchange the Google ID token for a session cookie, then re-check /api/me.
  function onGoogleCredential(response, setMsg) {
    const credential = response && response.credential;
    if (!credential) {
      setMsg("No credential received.");
      return;
    }
    fetch("/api/auth/google", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    })
      .then((res) => {
        if (!res.ok) {
          setMsg("Sign-in was rejected.");
          return;
        }
        return start();
      })
      .catch(() => setMsg("Sign-in failed."));
  }

  function signOut() {
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    })
      .catch(() => {})
      .finally(() => {
        if (window.google && google.accounts && google.accounts.id) {
          try {
            google.accounts.id.disableAutoSelect();
          } catch (e) {
            /* ignore */
          }
        }
        renderSignIn();
      });
  }

  // --- auth gate ----------------------------------------------------------

  // Ask the server who we are and render the matching screen. Exposed via
  // window.__admin.start so the gate can be re-driven after a mocked /api/me.
  function start() {
    return fetch("/api/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .catch(() => ({ editor: false }))
      .then((me) => {
        if (me && me.editor) {
          renderDashboard(me);
        } else {
          renderSignIn();
        }
      })
      .catch(() => renderSignIn("Something went wrong loading the console."));
  }

  // Internal signals C3 can read: the loaded document (null until we truly know
  // the server's state) and whether the last load errored.
  window.__admin = {
    start: start,
    getDoc: function () { return doc; },
    hasLoadError: function () { return loadError; },
  };

  start();
})();
