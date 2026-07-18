// Admin console (Task C3a). This is the /admin page's only script — it never
// loads or touches the public render path (script.js) or the retired in-page
// editor (editor.js). It authenticates the owner, loads the current block
// document, and now lets the owner EDIT it: reorder/add/delete blocks, edit the
// text blocks (heading / richtext via Quill / list / portrait), and Save back
// to /api/content. Structured-card editors (projects / experience / socials)
// arrive in C3b — here they render a read-only placeholder whose data is kept
// untouched so Save round-trips it.
//
// Everything lives inside this IIFE so admin identifiers stay off the global
// scope. The sign-in flow mirrors editor.js exactly (lazy GIS + /api/config +
// /api/auth/google). A tiny `window.__admin` hook exposes `start()` so the auth
// gate can be re-driven (e.g. after a mocked /api/me in tests) without a reload.
(function () {
  "use strict";

  const root = document.getElementById("admin-root");
  let gisPromise = null;

  // The working document (set once the dashboard loads content). Editing mutates
  // it in place. It is ONLY non-null when we truly know the server's state:
  // either the server has no content yet (404 -> DEFAULT_CONTENT) or it returned
  // a real document. On any load error `doc` stays null and `loadError` is set,
  // so the Save path can refuse to overwrite unknown server state with defaults.
  let doc = null;
  let loadError = false;

  // Dirty tracking + Save-bar handles (reset per dashboard render).
  let dirty = false;
  let saving = false;
  let saveBtn = null;
  let saveStatusEl = null;
  let blocksContainer = null;

  // Set only when a Save is rejected by a 401: the in-memory (still unsaved)
  // document, stashed across the forced re-sign-in so re-auth restores the
  // user's edits instead of reloading server/default content over them.
  let pendingUnsavedDoc = null;

  // Monotonic id sequence for freshly added blocks (no Math.random needed).
  let blockIdSeq = 0;

  // --- Stale-async / generation guards ------------------------------------
  // `screenGen` bumps on every SCREEN switch (sign-in <-> dashboard). Async work
  // that outlives its screen (content load, Save) checks it so a resolved fetch
  // can't clobber a newer screen. `renderGen` bumps on every full editor list
  // re-render; deferred per-card work (Quill init/text-change) checks it so a
  // stale Quill instance can't write into a re-rendered DOM/doc.
  let screenGen = 0;
  let renderGen = 0;

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

  function count(arr) {
    return Array.isArray(arr) ? arr.length : 0;
  }

  // Deep clone a plain block document (structuredClone where available, else a
  // JSON round-trip). Used so seeding from DEFAULT_CONTENT never mutates it.
  function cloneDoc(obj) {
    if (typeof structuredClone === "function") return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  }

  // --- toasts -------------------------------------------------------------

  let toastHost = null;

  function toast(message, kind) {
    if (!toastHost) {
      toastHost = el("div", "admin-toasts");
      document.body.appendChild(toastHost);
    }
    const t = el("div", "admin-toast" + (kind ? " admin-toast--" + kind : ""), message);
    toastHost.appendChild(t);
    setTimeout(() => {
      t.classList.add("is-out");
      setTimeout(() => t.remove(), 200);
    }, 2600);
  }

  // --- dirty state --------------------------------------------------------

  function markDirty() {
    dirty = true;
    updateSaveBar();
  }

  function clearDirty() {
    dirty = false;
    updateSaveBar();
  }

  function updateSaveBar() {
    if (!saveBtn || !saveStatusEl) return;
    if (loadError) {
      saveStatusEl.textContent = "Content failed to load — reload before saving.";
      saveStatusEl.className = "admin-savebar__status admin-savebar__status--error";
      saveBtn.disabled = false; // enabled so the refusal path is reachable
      return;
    }
    if (saving) {
      saveStatusEl.textContent = "Saving…";
      saveStatusEl.className = "admin-savebar__status";
      saveBtn.disabled = true;
      return;
    }
    if (dirty) {
      saveStatusEl.textContent = "Unsaved changes";
      saveStatusEl.className = "admin-savebar__status admin-savebar__status--dirty";
      saveBtn.disabled = false;
    } else {
      saveStatusEl.textContent = "All changes saved";
      saveStatusEl.className = "admin-savebar__status";
      saveBtn.disabled = true;
    }
  }

  // --- Save ---------------------------------------------------------------

  function save() {
    if (saving) return;
    // Refuse when the document never loaded: we must not overwrite unknown
    // server state with a placeholder/empty doc. Tell the user to reload.
    if (loadError || !doc) {
      toast("Couldn't load your content — reload before saving.", "error");
      return;
    }
    saving = true;
    const myScreen = screenGen;
    updateSaveBar();

    fetch("/api/content", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    })
      .then((res) => {
        if (myScreen !== screenGen) return; // signed out / screen changed mid-save
        saving = false;
        if (res.ok) {
          clearDirty();
          toast("Saved", "success");
          return;
        }
        if (res.status === 401) {
          // Session expired mid-save. The edits are NOT persisted — never drop
          // them: stash the working doc, bounce to sign-in with a persistent
          // warning, and keep `dirty` true so beforeunload still guards. On
          // re-auth, renderDashboard restores this doc instead of reloading.
          pendingUnsavedDoc = doc;
          toast("Not saved — your session expired.", "error");
          renderSignIn(
            "Your session expired and your changes were NOT saved. " +
              "Sign in again, then click Save."
          );
          dirty = true; // renderSignIn cleared it; restore so we still warn
          return;
        }
        toast("Save failed (" + res.status + ")", "error");
        updateSaveBar();
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        saving = false;
        toast("Save failed — network error", "error");
        updateSaveBar();
      });
  }

  // --- structural ops -----------------------------------------------------

  function newId(type) {
    const existing = new Set(
      ((doc && doc.blocks) || []).map((b) => b && b.id).filter(Boolean)
    );
    let id;
    do {
      id = type + "-" + ++blockIdSeq;
    } while (existing.has(id));
    return id;
  }

  // Sensible default field templates per type. Kept minimal but valid so the new
  // block renders on the public page immediately.
  const TEMPLATES = {
    heading: () => ({ level: 2, text: "New heading" }),
    richtext: () => ({ html: "<p></p>" }),
    list: () => ({ items: ["New item"] }),
    portrait: () => ({ width: 180, offsetX: 212 }),
    projects: () => ({ items: [] }),
    experience: () => ({ items: [] }),
    socials: () => ({ items: [] }),
  };

  function addBlock(type) {
    const make = TEMPLATES[type];
    if (!make || !doc) return;
    const block = Object.assign({ id: newId(type), type: type }, make());
    doc.blocks.push(block);
    markDirty();
    renderEditor(blocksContainer);
  }

  function deleteBlock(i) {
    if (!doc || !doc.blocks[i]) return;
    const label = doc.blocks[i].type || "block";
    // window.confirm kept for humans, but skippable where it's unavailable.
    const ok =
      typeof window.confirm === "function"
        ? window.confirm("Delete this " + label + " block?")
        : true;
    if (!ok) return;
    doc.blocks.splice(i, 1);
    markDirty();
    renderEditor(blocksContainer);
  }

  function moveBlock(from, to) {
    if (!doc) return;
    const blocks = doc.blocks;
    if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length) return;
    if (from === to) return;
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    markDirty();
    renderEditor(blocksContainer);
  }

  // --- drag-and-drop reorder (native HTML5) -------------------------------
  // Only the handle arms dragging (card.draggable is false the rest of the time
  // so inputs/toolbars stay interactive and text stays selectable).

  let dragFrom = null;
  let armedCard = null; // card whose handle was pressed (draggable armed)

  function attachDrag(card, handle, index) {
    handle.addEventListener("mousedown", () => {
      armedCard = card;
      card.draggable = true;
    });
    // NB: a press-on-handle then release-over-the-body starts no drag, so
    // neither dragend nor a handle mouseup fires — the document-level mouseup
    // (registered once, below) disarms it so no card is left stuck draggable.
    card.addEventListener("dragstart", (e) => {
      dragFrom = index;
      card.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", String(index));
        } catch (_) {
          /* some browsers restrict setData; index is tracked in dragFrom */
        }
      }
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.classList.remove("is-dragging");
      card.classList.remove("is-drop-target");
      dragFrom = null;
      armedCard = null;
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      card.classList.add("is-drop-target");
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("is-drop-target");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("is-drop-target");
      const from = dragFrom;
      if (from == null || from === index) return;
      moveBlock(from, index);
    });
  }

  // --- per-type editors ---------------------------------------------------

  const QUILL_TOOLBAR = [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["link", "blockquote"],
    ["clean"],
  ];

  function buildHeading(block) {
    const wrap = el("div", "admin-field");

    const input = el("input", "admin-input");
    input.type = "text";
    input.placeholder = "Heading text";
    input.value = block.text || "";
    input.addEventListener("input", () => {
      block.text = input.value;
      markDirty();
    });
    wrap.appendChild(input);

    const seg = el("div", "admin-seg");
    [1, 2].forEach((lvl) => {
      const b = el("button", "admin-seg__btn", "H" + lvl);
      b.type = "button";
      if ((block.level === 1 ? 1 : 2) === lvl) b.classList.add("is-active");
      b.addEventListener("click", () => {
        block.level = lvl;
        markDirty();
        seg.querySelectorAll(".admin-seg__btn").forEach((x) =>
          x.classList.remove("is-active")
        );
        b.classList.add("is-active");
      });
      seg.appendChild(b);
    });
    wrap.appendChild(seg);

    return wrap;
  }

  function buildRichtext(block, myRender) {
    const wrap = el("div", "admin-field");
    const host = el("div", "admin-quill");
    wrap.appendChild(host);

    // Graceful fallback if Quill somehow failed to load: a plain textarea still
    // edits block.html (the same field the public renderer innerHTMLs).
    if (typeof Quill === "undefined") {
      const ta = el("textarea", "admin-input admin-textarea");
      ta.value = block.html || "";
      ta.addEventListener("input", () => {
        block.html = ta.value;
        markDirty();
      });
      host.replaceWith(ta);
      return wrap;
    }

    const myScreen = screenGen;
    // Defer init one tick: the host is in the DOM by then, and the generation
    // guard means a re-render or sign-out before this fires cancels it cleanly.
    setTimeout(() => {
      if (myRender !== renderGen || myScreen !== screenGen) return;
      const q = new Quill(host, {
        theme: "snow",
        modules: { toolbar: QUILL_TOOLBAR },
        placeholder: "Write…",
      });
      // Seed from the stored HTML FIRST, then bind text-change, so the initial
      // programmatic fill doesn't mark the doc dirty.
      if (block.html) q.clipboard.dangerouslyPasteHTML(block.html);
      q.on("text-change", () => {
        if (myRender !== renderGen || myScreen !== screenGen) return;
        block.html = q.root.innerHTML;
        markDirty();
      });
    }, 0);

    return wrap;
  }

  function buildList(block) {
    const wrap = el("div", "admin-field");
    if (!Array.isArray(block.items)) block.items = [];

    block.items.forEach((item, idx) => {
      const row = el("div", "admin-list-row");
      const input = el("input", "admin-input");
      input.type = "text";
      input.value = item == null ? "" : String(item);
      input.addEventListener("input", () => {
        block.items[idx] = input.value;
        markDirty();
      });
      const rm = el("button", "admin-btn admin-btn--danger admin-btn--sm", "Remove");
      rm.type = "button";
      rm.addEventListener("click", () => {
        block.items.splice(idx, 1);
        markDirty();
        renderEditor(blocksContainer);
      });
      row.appendChild(input);
      row.appendChild(rm);
      wrap.appendChild(row);
    });

    const add = el("button", "admin-btn admin-btn--sm", "+ Add item");
    add.type = "button";
    add.addEventListener("click", () => {
      block.items.push("New item");
      markDirty();
      renderEditor(blocksContainer);
    });
    wrap.appendChild(add);

    return wrap;
  }

  function numberField(label, value, onChange) {
    const field = el("label", "admin-numfield");
    field.appendChild(el("span", "admin-numfield__label", label));
    const input = el("input", "admin-input admin-input--num");
    input.type = "number";
    input.value = String(value);
    input.addEventListener("input", () => {
      const n = input.valueAsNumber;
      if (Number.isFinite(n)) onChange(n); // Number.isFinite(0) === true -> 0 allowed
    });
    field.appendChild(input);
    return field;
  }

  function buildPortrait(block) {
    const wrap = el("div", "admin-field admin-field--inline");
    // Nullish coalescing so a stored 0 shows as 0, not the default.
    wrap.appendChild(
      numberField("Width (px)", block.width ?? 180, (n) => {
        block.width = n;
        markDirty();
      })
    );
    wrap.appendChild(
      numberField("Offset X (px)", block.offsetX ?? 212, (n) => {
        block.offsetX = n;
        markDirty();
      })
    );
    return wrap;
  }

  // Read-only placeholder for the structured-card blocks (C3b). Their data lives
  // in `doc` untouched, so Save round-trips it faithfully.
  function buildPlaceholder(block) {
    const wrap = el("div", "admin-field");
    const box = el("div", "admin-placeholder");
    const n = count(block.items);
    const noun = block.type === "socials" ? "link" : "card";
    box.appendChild(
      el("div", "admin-placeholder__count", n + " " + noun + (n === 1 ? "" : "s"))
    );
    box.appendChild(
      el("div", "admin-placeholder__note", "Structured editing coming next.")
    );
    wrap.appendChild(box);
    return wrap;
  }

  function buildUnknown(block) {
    const wrap = el("div", "admin-field");
    wrap.appendChild(
      el("div", "admin-placeholder__note", "Unknown block type — left untouched.")
    );
    return wrap;
  }

  const EDITORS = {
    heading: buildHeading,
    richtext: buildRichtext,
    list: buildList,
    portrait: buildPortrait,
    projects: buildPlaceholder,
    experience: buildPlaceholder,
    socials: buildPlaceholder,
  };

  // --- one block card -----------------------------------------------------

  function buildCard(block, i, total, myRender) {
    const card = el("div", "admin-card");
    card.dataset.index = String(i);

    const head = el("div", "admin-card__head");

    const handle = el("button", "admin-card__handle", "⠿");
    handle.type = "button";
    handle.title = "Drag to reorder";
    handle.setAttribute("aria-label", "Drag to reorder");
    head.appendChild(handle);

    head.appendChild(el("span", "admin-card__badge", block.type || "?"));
    if (block.id) head.appendChild(el("span", "admin-card__id", block.id));

    head.appendChild(el("span", "admin-card__spacer"));

    // Keyboard-accessible reorder fallback alongside drag.
    const up = el("button", "admin-card__move", "▲");
    up.type = "button";
    up.title = "Move up";
    up.setAttribute("aria-label", "Move block up");
    up.disabled = i === 0;
    up.addEventListener("click", () => moveBlock(i, i - 1));
    head.appendChild(up);

    const down = el("button", "admin-card__move", "▼");
    down.type = "button";
    down.title = "Move down";
    down.setAttribute("aria-label", "Move block down");
    down.disabled = i === total - 1;
    down.addEventListener("click", () => moveBlock(i, i + 1));
    head.appendChild(down);

    const del = el("button", "admin-btn admin-btn--danger admin-btn--sm", "Delete");
    del.type = "button";
    del.addEventListener("click", () => deleteBlock(i));
    head.appendChild(del);

    card.appendChild(head);

    const builder = EDITORS[block.type];
    card.appendChild(builder ? builder(block, myRender) : buildUnknown(block));

    attachDrag(card, handle, i);
    return card;
  }

  // --- editor list --------------------------------------------------------

  function renderEditor(container) {
    if (!container) return;
    const myRender = ++renderGen; // invalidates any in-flight per-card deferrals
    container.replaceChildren();
    const blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
    if (blocks.length === 0) {
      container.appendChild(
        el("p", "admin-note", "No blocks yet. Add one with the menu above.")
      );
      return;
    }
    blocks.forEach((block, i) =>
      container.appendChild(buildCard(block, i, blocks.length, myRender))
    );
  }

  // --- add-block + save bars ---------------------------------------------

  function buildAddBar() {
    const bar = el("div", "admin-addbar");
    bar.appendChild(el("span", "admin-addbar__label", "Add a block:"));

    const select = el("select", "admin-select");
    [
      ["heading", "Heading"],
      ["richtext", "Rich text"],
      ["list", "List"],
      ["portrait", "Portrait"],
      ["projects", "Projects"],
      ["experience", "Experience"],
      ["socials", "Socials"],
    ].forEach(([value, label]) => {
      const o = el("option", null, label);
      o.value = value;
      select.appendChild(o);
    });
    bar.appendChild(select);

    const btn = el("button", "admin-btn", "Add block");
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (loadError || !doc) return;
      addBlock(select.value);
    });
    bar.appendChild(btn);

    return bar;
  }

  function buildSaveBar() {
    const bar = el("div", "admin-savebar");
    saveStatusEl = el("span", "admin-savebar__status", "");
    saveBtn = el("button", "admin-btn admin-btn--primary", "Save");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", save);
    bar.appendChild(saveStatusEl);
    bar.appendChild(saveBtn);
    return bar;
  }

  // --- dashboard ----------------------------------------------------------

  function renderDashboard(me) {
    const myScreen = ++screenGen;
    dirty = false;
    saving = false;
    // Reset so the brief "Loading…" state reflects THIS session, not carryover
    // from a previous one. (Restored below if we have unsaved edits to recover.)
    doc = null;
    loadError = false;
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
    main.appendChild(
      el(
        "p",
        "admin-note",
        "Edit the homepage document below. Drag the handle to reorder, edit " +
          "fields inline, then Save."
      )
    );

    main.appendChild(buildAddBar());

    const list = el("div", "admin-blocks");
    list.appendChild(el("p", "admin-note", "Loading content…"));
    main.appendChild(list);
    blocksContainer = list;

    shell.appendChild(main);
    shell.appendChild(buildSaveBar());
    root.appendChild(shell);

    updateSaveBar();

    // Recovering from a mid-save 401: the user just re-authenticated and we have
    // their unsaved edits stashed. Restore them verbatim (do NOT reload server
    // content over the top) so they can retry Save, and keep the doc dirty.
    if (pendingUnsavedDoc) {
      doc = pendingUnsavedDoc;
      pendingUnsavedDoc = null;
      loadError = false;
      dirty = true;
      renderEditor(list);
      updateSaveBar();
      toast("Signed back in — your unsaved edits are here. Click Save.", "success");
      return;
    }

    loadContent().then((result) => {
      if (myScreen !== screenGen) return; // signed out / navigated before load
      loadError = !!result.error;
      doc = result.doc;
      if (loadError) {
        renderLoadError(list);
      } else {
        renderEditor(list);
      }
      updateSaveBar();
    });
  }

  // Load the server document, distinguishing the failure modes so the Save path
  // never overwrites unknown server state with defaults. Resolves to
  // { doc, error }:
  //   - 404               -> first run, nothing saved yet: seed DEFAULT_CONTENT.
  //                          This is the ONLY case that silently uses defaults.
  //   - ok + {blocks:[…>0]} -> the authoritative server document.
  //   - any other non-ok (500/503/…), a network failure, bad JSON, or an ok
  //     response that isn't a non-empty block doc -> { doc:null, error:true }.
  function loadContent() {
    return fetch("/api/content", { credentials: "same-origin" })
      .then((res) => {
        if (res.status === 404) {
          // Clone: the editor mutates `doc` in place, and DEFAULT_CONTENT is a
          // shared module global we must not scribble on.
          return { doc: cloneDoc(DEFAULT_CONTENT), error: false };
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
    box.appendChild(
      el(
        "p",
        "admin-error__msg",
        "Couldn't load your content — the server returned an error. " +
          "Reload to try again. (Saving is disabled until it loads.)"
      )
    );
    const retry = el("button", "admin-btn", "Reload");
    retry.type = "button";
    retry.addEventListener("click", () => location.reload());
    box.appendChild(retry);
    container.appendChild(box);
  }

  // --- sign-in screen (mirrors editor.js's GIS flow) ----------------------

  function renderSignIn(message) {
    ++screenGen; // any in-flight dashboard async is now stale
    dirty = false;
    saveBtn = null;
    saveStatusEl = null;
    blocksContainer = null;
    clearRoot();

    const wrap = el("div", "admin-signin");
    const card = el("div", "admin-signin__card");
    card.appendChild(el("h1", "admin-signin__title", "Admin"));
    card.appendChild(
      el("p", "admin-signin__sub", "Sign in with Google to manage this site.")
    );

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

  // Warn before leaving with unsaved edits.
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Disarm a handle-armed card on any mouse release (covers the case where a
  // drag never started, which fires no dragend).
  document.addEventListener("mouseup", () => {
    if (armedCard) {
      armedCard.draggable = false;
      armedCard = null;
    }
  });

  // Internal signals for tests/inspection: the loaded document (null until we
  // truly know the server's state), the load-error flag, and dirty state.
  window.__admin = {
    start: start,
    getDoc: function () {
      return doc;
    },
    hasLoadError: function () {
      return loadError;
    },
    isDirty: function () {
      return dirty;
    },
  };

  start();
})();
