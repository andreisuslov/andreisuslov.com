// Admin console (Task C3a). This is the /admin page's only script — it never
// loads or touches the public render path (script.js) or the retired in-page
// editor (editor.js). It authenticates the owner, loads the current block
// document, and now lets the owner EDIT it: reorder/add/delete blocks, edit the
// text blocks (heading / richtext via Quill / list / portrait), the structured
// card lists (projects / experience) and socials, and Save back to
// /api/content.
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
  // `screenGen` bumps on every SCREEN switch (sign-in <-> dashboard) AND on every
  // top-level view switch (Page <-> Blog). Async work that outlives its screen
  // (content load, Save, list load, upload) checks it so a resolved fetch can't
  // clobber a newer screen/view. `renderGen` bumps on every full editor list /
  // post-editor re-render; deferred per-card work (Quill init/text-change) checks
  // it so a stale Quill instance can't write into a re-rendered DOM/model.
  let screenGen = 0;
  let renderGen = 0;

  // --- top-level view switch (Page block editor <-> Blog manager) ---------
  // Both views live behind the same auth gate and share the single `dirty` flag
  // (so beforeunload and the switch-confirm cover whichever view is active).
  // `onDirtyChange` is the active view's save-bar updater; markDirty/clearDirty
  // call it so each view reflects its own dirty state without the other's DOM.
  let currentView = "page"; // "page" | "blog" — defaults to Page
  let viewHost = null; // container the active view renders into
  let currentMe = null; // last /api/me payload, for header re-renders
  let onDirtyChange = null;
  let pageTab = null;
  let blogTab = null;

  // --- blog manager state -------------------------------------------------
  let postModel = null; // working post object in the editor (mutated in place)
  let postCreate = false; // true = create mode (slug editable, POST on save)
  let blogSaving = false;
  let blogSaveBtn = null;
  let blogSaveStatusEl = null;
  // Set only when a blog Save/upload is rejected by a 401: the in-memory (still
  // unsaved) post + its mode, stashed across the forced re-sign-in so re-auth
  // restores the editor instead of dropping the draft. Mirrors pendingUnsavedDoc.
  let pendingUnsavedPost = null;

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
    if (onDirtyChange) onDirtyChange();
  }

  function clearDirty() {
    dirty = false;
    if (onDirtyChange) onDirtyChange();
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
    image: () => ({ src: "", alt: "" }),
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

  // Blog body toolbar: the page toolbar plus an image button (its handler is
  // overridden to upload to /api/uploads and insert an <img src="/uploads/…">
  // rather than base64-embedding the bytes).
  const QUILL_TOOLBAR_BLOG = [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["link", "image", "blockquote"],
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

  // --- image block --------------------------------------------------------
  // An upload control (raw-bytes POST to /api/uploads) plus an alt-text field.
  // Keystrokes in the alt field only mutate `doc` + markDirty (no re-render, so
  // focus/caret survive); a successful upload sets block.src and refreshes just
  // this block's preview via renderPreview (guarded by the render generation).

  function uploadImage(file, block, myRender, renderPreview, btn) {
    const myScreen = screenGen;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Uploading…";
    const restore = () => {
      btn.disabled = false;
      btn.textContent = label;
    };
    fetch("/api/uploads", {
      method: "POST",
      credentials: "same-origin",
      // Raw image bytes — the server reads Content-Type, not multipart.
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    })
      .then((res) => {
        if (myScreen !== screenGen) return; // signed out / screen changed
        if (res.ok) {
          return res.json().then((data) => {
            block.src = (data && data.url) || "";
            markDirty();
            // Only repaint the preview if this card's render is still current.
            // If a re-render landed mid-upload the preview node is stale, so we
            // skip it: block.src is already set on the doc, and the fresh card's
            // renderPreview() (next render) shows the image — a brief empty
            // state that self-heals, not a lost src.
            if (myRender === renderGen) renderPreview();
            restore();
            toast("Image uploaded", "success");
          });
        }
        if (res.status === 401) {
          // Session expired mid-upload. Mirror Save's recovery: stash the
          // working doc, bounce to sign-in, keep dirty so beforeunload guards.
          pendingUnsavedDoc = doc;
          toast("Not uploaded — your session expired.", "error");
          renderSignIn(
            "Your session expired and your changes were NOT saved. " +
              "Sign in again, then re-upload and click Save."
          );
          dirty = true;
          return;
        }
        restore();
        if (res.status === 413) {
          toast("Image too large (max 8 MB).", "error");
          return;
        }
        if (res.status === 415) {
          toast("Unsupported image type (use PNG, JPEG, WebP or GIF).", "error");
          return;
        }
        toast("Upload failed (" + res.status + ")", "error");
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        restore();
        toast("Upload failed — network error", "error");
      });
  }

  function buildImage(block, myRender) {
    const wrap = el("div", "admin-field admin-image");

    const preview = el("div", "admin-image__preview");
    function renderPreview() {
      preview.replaceChildren();
      if (block.src) {
        const img = el("img", "admin-image__img");
        img.src = block.src;
        img.alt = block.alt || "";
        preview.appendChild(img);
      } else {
        preview.appendChild(
          el("span", "admin-image__empty", "No image uploaded yet.")
        );
      }
    }
    renderPreview();
    wrap.appendChild(preview);

    // Upload control: a styled button that proxies to a hidden file input.
    const controls = el("div", "admin-image__controls");
    const btn = el("button", "admin-btn admin-btn--sm", "Upload image");
    btn.type = "button";
    const fileInput = el("input", "admin-image__file");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) uploadImage(file, block, myRender, renderPreview, btn);
      fileInput.value = ""; // let the same file be picked again later
    });
    btn.addEventListener("click", () => fileInput.click());
    controls.appendChild(btn);
    controls.appendChild(fileInput);
    wrap.appendChild(controls);

    // Alt text (plain input, focus-preserving).
    const altField = el("label", "admin-subfield admin-image__alt");
    altField.appendChild(el("span", "admin-subfield__label", "Alt text"));
    const altInput = el("input", "admin-input");
    altInput.type = "text";
    altInput.placeholder = "Describe the image (for screen readers)";
    altInput.value = block.alt || "";
    altInput.addEventListener("input", () => {
      block.alt = altInput.value;
      const img = preview.querySelector(".admin-image__img");
      if (img) img.alt = block.alt; // keep preview in sync, no re-render
      markDirty();
    });
    altField.appendChild(altInput);
    wrap.appendChild(altField);

    return wrap;
  }

  // --- structured card lists (projects / experience / socials) -----------
  // These edit a block's `items` array in place. The discipline mirrors the
  // text editors: a field KEYSTROKE only mutates `doc` + markDirty() (never a
  // re-render, so focus/caret survive), while STRUCTURAL changes (add / delete /
  // reorder a card, add / remove a tag) re-render just this block's item list
  // (or, for a tag change, just the one card) — never the whole editor list, so
  // other blocks' Quill instances and focus are untouched.

  // Valid social-icon keys. KEEP IN SYNC with ICON_PATHS in script.js — the
  // public renderer draws the SVG for whichever key is stored here.
  const ICON_KEYS = ["github", "linkedin", "mail", "external"];

  // Minimal copy of the icon paths for the admin-side preview only. KEEP IN SYNC
  // with ICON_PATHS in script.js (script.js is not loaded on /admin).
  const ICON_PREVIEW = {
    github:
      "M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z",
    linkedin:
      "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
    mail:
      "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
    external:
      "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  };

  function iconSvg(iconName) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON_PREVIEW[iconName] || "");
    svg.appendChild(path);
    return svg;
  }

  // A labelled single-line text field that writes value -> onInput on every
  // keystroke and NEVER re-renders. Returns { field, input } so callers can tag
  // the input (e.g. as the focus target after adding a card).
  function textField(label, value, placeholder, onInput) {
    const field = el("label", "admin-subfield");
    field.appendChild(el("span", "admin-subfield__label", label));
    const input = el("input", "admin-input");
    input.type = "text";
    if (placeholder) input.placeholder = placeholder;
    input.value = value == null ? "" : String(value);
    input.addEventListener("input", () => onInput(input.value));
    field.appendChild(input);
    return { field: field, input: input };
  }

  // A labelled plain-text (NOT rich-text) multi-line field. The public renderer
  // puts project/experience descriptions in via textContent, so plain text is
  // exactly right here — no Quill.
  function textareaField(label, value, placeholder, onInput) {
    const field = el("label", "admin-subfield");
    field.appendChild(el("span", "admin-subfield__label", label));
    const ta = el("textarea", "admin-input admin-textarea admin-textarea--plain");
    if (placeholder) ta.placeholder = placeholder;
    ta.value = value == null ? "" : String(value);
    ta.addEventListener("input", () => onInput(ta.value));
    field.appendChild(ta);
    return field;
  }

  // Move items[from] -> items[to] within one block. Returns whether it moved.
  function moveItem(items, from, to) {
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return false;
    if (from === to) return false;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    markDirty();
    return true;
  }

  // Shared sub-card header: index label, an optional lead node (e.g. an icon
  // preview), reorder up/down, and a confirm-gated delete. `rerender` rebuilds
  // the whole block's item list after a structural change.
  function subCardHead(items, idx, rerender, leadNode) {
    const head = el("div", "admin-subcard__head");
    head.appendChild(el("span", "admin-subcard__num", "#" + (idx + 1)));
    if (leadNode) head.appendChild(leadNode);
    head.appendChild(el("span", "admin-card__spacer"));

    const up = el("button", "admin-card__move", "▲");
    up.type = "button";
    up.title = "Move up";
    up.setAttribute("aria-label", "Move card up");
    up.disabled = idx === 0;
    up.addEventListener("click", () => {
      if (moveItem(items, idx, idx - 1)) rerender();
    });
    head.appendChild(up);

    const down = el("button", "admin-card__move", "▼");
    down.type = "button";
    down.title = "Move down";
    down.setAttribute("aria-label", "Move card down");
    down.disabled = idx === items.length - 1;
    down.addEventListener("click", () => {
      if (moveItem(items, idx, idx + 1)) rerender();
    });
    head.appendChild(down);

    const del = el("button", "admin-btn admin-btn--danger admin-btn--sm", "Delete");
    del.type = "button";
    del.addEventListener("click", () => {
      const ok =
        typeof window.confirm === "function"
          ? window.confirm("Delete this card?")
          : true;
      if (!ok) return;
      items.splice(idx, 1);
      markDirty();
      rerender();
    });
    head.appendChild(del);

    return head;
  }

  // Editable tag chips for one item. Text edits mutate doc+dirty with no
  // re-render (focus-preserving); add/remove re-renders just the owning card via
  // `rerenderCard` (rerenderCard(true) focuses the freshly added tag input).
  function buildTags(item, rerenderCard) {
    if (!Array.isArray(item.tags)) item.tags = [];
    const wrap = el("div", "admin-tags");

    item.tags.forEach((tag, ti) => {
      const chip = el("div", "admin-tag");
      const input = el("input", "admin-tag__input");
      input.type = "text";
      input.value = tag == null ? "" : String(tag);
      input.size = Math.max(3, input.value.length);
      input.setAttribute("aria-label", "Tag text");
      input.addEventListener("input", () => {
        item.tags[ti] = input.value;
        input.size = Math.max(3, input.value.length);
        markDirty();
      });
      const rm = el("button", "admin-tag__rm", "×");
      rm.type = "button";
      rm.title = "Remove tag";
      rm.setAttribute("aria-label", "Remove tag");
      rm.addEventListener("click", () => {
        item.tags.splice(ti, 1);
        markDirty();
        rerenderCard();
      });
      chip.appendChild(input);
      chip.appendChild(rm);
      wrap.appendChild(chip);
    });

    const add = el("button", "admin-tag-add", "+ add tag");
    add.type = "button";
    add.addEventListener("click", () => {
      item.tags.push("");
      markDirty();
      rerenderCard(true);
    });
    wrap.appendChild(add);

    return wrap;
  }

  // One projects/experience sub-card. `kind` is "projects" | "experience".
  // `rerender` rebuilds the whole block's item list (used after delete/reorder,
  // where indices shift); tag add/remove re-renders just this card in place.
  function buildItemCard(block, idx, kind, rerender) {
    const items = block.items;
    const item = items[idx];
    const card = el("div", "admin-subcard");

    card.appendChild(subCardHead(items, idx, rerender));

    const name = textField("Name", item.name, "Name", (v) => {
      item.name = v;
      markDirty();
    });
    name.input.classList.add("admin-subcard__name-input");
    card.appendChild(name.field);

    if (kind === "experience") {
      card.appendChild(
        textField("Subtitle", item.subtitle, "Role · dates", (v) => {
          item.subtitle = v;
          markDirty();
        }).field
      );
    }

    card.appendChild(
      textareaField("Description", item.description, "Plain-text description…", (v) => {
        item.description = v;
        markDirty();
      })
    );

    const tagsField = el("div", "admin-subfield");
    tagsField.appendChild(el("span", "admin-subfield__label", "Tags"));
    tagsField.appendChild(
      buildTags(item, (focusNew) => {
        // Surgical re-render of just this card (index unchanged by a tag edit).
        const fresh = buildItemCard(block, idx, kind, rerender);
        card.replaceWith(fresh);
        if (focusNew) {
          const inputs = fresh.querySelectorAll(".admin-tag__input");
          const last = inputs[inputs.length - 1];
          if (last) last.focus();
        }
      })
    );
    card.appendChild(tagsField);

    if (kind === "projects") {
      card.appendChild(
        textField("GitHub URL", item.github, "https://github.com/…", (v) => {
          item.github = v;
          markDirty();
        }).field
      );
    }

    return card;
  }

  // Projects/experience block editor (card list). Only this block's item host is
  // re-rendered on structural change.
  function buildItemListEditor(block, kind) {
    if (!Array.isArray(block.items)) block.items = [];
    const wrap = el("div", "admin-field");
    const host = el("div", "admin-subcards");
    wrap.appendChild(host);

    function renderItems(focusIdx) {
      host.replaceChildren();
      block.items.forEach((_, idx) =>
        host.appendChild(buildItemCard(block, idx, kind, renderItems))
      );
      if (focusIdx != null) {
        const card = host.children[focusIdx];
        const input = card && card.querySelector(".admin-subcard__name-input");
        if (input) {
          input.focus();
          input.select();
        }
      }
    }

    const add = el("button", "admin-btn admin-btn--sm admin-addcard", "+ Add card");
    add.type = "button";
    add.addEventListener("click", () => {
      block.items.push(
        kind === "projects"
          ? { name: "New project", description: "", tags: [], github: "" }
          : { name: "New role", subtitle: "", description: "", tags: [] }
      );
      markDirty();
      renderItems(block.items.length - 1);
    });

    renderItems();
    wrap.appendChild(add);
    return wrap;
  }

  function buildProjects(block) {
    return buildItemListEditor(block, "projects");
  }

  function buildExperience(block) {
    return buildItemListEditor(block, "experience");
  }

  // One social link sub-card: name, url, and an icon <select> (with a live SVG
  // preview in the header). Icon change updates the preview without a re-render.
  function buildSocialCard(block, idx, rerender) {
    const items = block.items;
    const item = items[idx];
    const card = el("div", "admin-subcard");

    const preview = el("span", "admin-social-preview");
    preview.appendChild(iconSvg(item.icon));
    card.appendChild(subCardHead(items, idx, rerender, preview));

    const name = textField("Name", item.name, "Label (aria-label)", (v) => {
      item.name = v;
      markDirty();
    });
    name.input.classList.add("admin-subcard__name-input");
    card.appendChild(name.field);

    card.appendChild(
      textField("URL", item.url, "https://… or mailto:…", (v) => {
        item.url = v;
        markDirty();
      }).field
    );

    const iconField = el("label", "admin-subfield");
    iconField.appendChild(el("span", "admin-subfield__label", "Icon"));
    const sel = el("select", "admin-select admin-select--icon");
    ICON_KEYS.forEach((key) => {
      const o = el("option", null, key);
      o.value = key;
      if ((item.icon || "github") === key) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      item.icon = sel.value;
      markDirty();
      preview.replaceChildren(iconSvg(item.icon));
    });
    iconField.appendChild(sel);
    card.appendChild(iconField);

    return card;
  }

  function buildSocials(block) {
    if (!Array.isArray(block.items)) block.items = [];
    const wrap = el("div", "admin-field");
    const host = el("div", "admin-subcards");
    wrap.appendChild(host);

    function renderItems(focusIdx) {
      host.replaceChildren();
      block.items.forEach((_, idx) =>
        host.appendChild(buildSocialCard(block, idx, renderItems))
      );
      if (focusIdx != null) {
        const card = host.children[focusIdx];
        const input = card && card.querySelector(".admin-subcard__name-input");
        if (input) {
          input.focus();
          input.select();
        }
      }
    }

    const add = el("button", "admin-btn admin-btn--sm admin-addcard", "+ Add");
    add.type = "button";
    add.addEventListener("click", () => {
      block.items.push({ name: "Link", url: "https://", icon: "github" });
      markDirty();
      renderItems(block.items.length - 1);
    });

    renderItems();
    wrap.appendChild(add);
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
    image: buildImage,
    portrait: buildPortrait,
    projects: buildProjects,
    experience: buildExperience,
    socials: buildSocials,
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
      ["image", "Image"],
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

  // --- dashboard shell + view switcher ------------------------------------

  // Build the persistent dashboard chrome (header with Page/Blog tabs, the
  // signed-in email and sign-out) once, then render whichever view is active
  // into `viewHost`. A 401-recovery (pendingUnsavedDoc/pendingUnsavedPost) lands
  // here after re-auth: `currentView` is preserved across the sign-in bounce, so
  // renderView dispatches back to the right view, which restores the draft.
  function renderDashboard(me) {
    ++screenGen;
    currentMe = me;
    clearRoot();

    const shell = el("div", "admin-shell");

    const header = el("header", "admin-header");
    header.appendChild(el("span", "admin-header__title", "Admin"));

    const tabs = el("nav", "admin-tabs");
    pageTab = el("button", "admin-tab", "Page");
    pageTab.type = "button";
    pageTab.addEventListener("click", () => switchView("page"));
    blogTab = el("button", "admin-tab", "Blog");
    blogTab.type = "button";
    blogTab.addEventListener("click", () => switchView("blog"));
    tabs.appendChild(pageTab);
    tabs.appendChild(blogTab);
    header.appendChild(tabs);

    const right = el("div", "admin-header__right");
    right.appendChild(el("span", "admin-header__email", (me && me.email) || ""));
    const signOutBtn = el("button", "admin-btn admin-btn--ghost", "Sign out");
    signOutBtn.type = "button";
    signOutBtn.addEventListener("click", signOut);
    right.appendChild(signOutBtn);
    header.appendChild(right);
    shell.appendChild(header);

    viewHost = el("div", "admin-viewhost");
    shell.appendChild(viewHost);
    root.appendChild(shell);

    renderView();
  }

  function setActiveTab() {
    if (pageTab) pageTab.classList.toggle("is-active", currentView === "page");
    if (blogTab) blogTab.classList.toggle("is-active", currentView === "blog");
  }

  // Switch top-level view. Confirms first if the current view has unsaved edits
  // (both views share the single `dirty` flag). Discards dirty on switch.
  function switchView(target) {
    if (target === currentView) return;
    if (dirty) {
      const ok =
        typeof window.confirm === "function"
          ? window.confirm("You have unsaved changes. Discard them and switch?")
          : true;
      if (!ok) return;
    }
    currentView = target;
    dirty = false;
    renderView();
  }

  // Render the active view into viewHost. Bumps screenGen so any in-flight async
  // from the view we're leaving cancels itself, and resets both views' save-bar
  // handles so a stale updater can't touch a detached node.
  function renderView() {
    ++screenGen;
    setActiveTab();
    onDirtyChange = null;
    saveBtn = null;
    saveStatusEl = null;
    blocksContainer = null;
    blogSaveBtn = null;
    blogSaveStatusEl = null;
    // Clear any stranded saving flags: a Save whose response resolves after a
    // screen/view switch early-returns without resetting these, so reset them
    // wherever a view (re)mounts (the page editor resets `saving` the same way).
    saving = false;
    blogSaving = false;
    viewHost.replaceChildren();
    if (currentView === "blog") {
      renderBlogView();
    } else {
      renderPageView();
    }
  }

  // --- Page view (the existing block editor) ------------------------------

  function renderPageView() {
    const myScreen = screenGen;
    dirty = false;
    saving = false;
    // Reset so the brief "Loading…" state reflects THIS session, not carryover.
    doc = null;
    loadError = false;
    onDirtyChange = updateSaveBar;

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

    viewHost.appendChild(main);
    viewHost.appendChild(buildSaveBar());

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

  // ========================================================================
  // Blog view — post list + Quill post editor
  // ========================================================================

  // Local YYYY-MM-DD for the date input's default (browser-local, not UTC).
  function isoToday() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // Client-side slug preview for the create form. Mirrors server slugify()
  // (lowercase, non-alphanumerics -> single hyphens, trimmed, capped). The
  // server remains authoritative — this is only the editable default.
  function clientSlugify(title) {
    const s = (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72)
      .replace(/^-+|-+$/g, "");
    return s;
  }

  // Blog view entry point. Recovers a 401-stashed draft if present, else lists.
  function renderBlogView() {
    onDirtyChange = null;
    dirty = false;
    if (pendingUnsavedPost) {
      const stash = pendingUnsavedPost;
      pendingUnsavedPost = null;
      postModel = stash.model;
      postCreate = stash.create;
      renderPostEditor(true);
      return;
    }
    renderBlogList();
  }

  // --- post list ----------------------------------------------------------

  function renderBlogList() {
    const myScreen = screenGen;
    onDirtyChange = null;
    dirty = false;
    viewHost.replaceChildren();

    const main = el("main", "admin-main");

    const bar = el("div", "admin-blogbar");
    bar.appendChild(el("h2", "admin-blogbar__title", "Blog posts"));
    bar.appendChild(el("span", "admin-card__spacer"));
    const newBtn = el("button", "admin-btn admin-btn--primary", "New post");
    newBtn.type = "button";
    newBtn.addEventListener("click", () => openPostEditor(null));
    bar.appendChild(newBtn);
    main.appendChild(bar);

    const listHost = el("div", "admin-postlist");
    listHost.appendChild(el("p", "admin-note", "Loading posts…"));
    main.appendChild(listHost);
    viewHost.appendChild(main);

    fetch("/api/posts", { credentials: "same-origin" })
      .then((res) => {
        if (myScreen !== screenGen) return; // navigated away
        if (!res.ok) {
          renderPostListError(listHost);
          return;
        }
        return res.json().then((data) => {
          if (myScreen !== screenGen) return;
          const posts = data && Array.isArray(data.posts) ? data.posts : null;
          if (!posts) {
            renderPostListError(listHost);
            return;
          }
          renderPostRows(listHost, posts);
        });
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        renderPostListError(listHost);
      });
  }

  // Load-error state for the list (don't fabricate an empty list on failure —
  // mirrors the page editor's renderLoadError discipline).
  function renderPostListError(listHost) {
    listHost.replaceChildren();
    const box = el("div", "admin-error");
    box.appendChild(
      el(
        "p",
        "admin-error__msg",
        "Couldn't load your posts — the server returned an error. Reload to try again."
      )
    );
    const retry = el("button", "admin-btn", "Reload");
    retry.type = "button";
    retry.addEventListener("click", () => renderBlogList());
    box.appendChild(retry);
    listHost.appendChild(box);
  }

  function renderPostRows(listHost, posts) {
    listHost.replaceChildren();
    if (posts.length === 0) {
      listHost.appendChild(
        el(
          "p",
          "admin-note",
          "No posts yet. Click “New post” to write your first one."
        )
      );
      return;
    }
    posts.forEach((post) => {
      const row = el("div", "admin-postrow");

      const info = el("div", "admin-postrow__info");
      const titleLine = el("div", "admin-postrow__titleline");
      titleLine.appendChild(
        el("span", "admin-postrow__title", post.title || post.slug || "(untitled)")
      );
      if (post.draft) {
        titleLine.appendChild(el("span", "admin-postrow__badge", "Draft"));
      }
      info.appendChild(titleLine);
      if (post.date) {
        info.appendChild(el("span", "admin-postrow__date", String(post.date)));
      }
      row.appendChild(info);

      const actions = el("div", "admin-postrow__actions");
      const edit = el("button", "admin-btn admin-btn--sm", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => openPostEditor(post.slug));
      actions.appendChild(edit);
      const del = el("button", "admin-btn admin-btn--danger admin-btn--sm", "Delete");
      del.type = "button";
      del.addEventListener("click", () => deleteBlogPost(post.slug, post.title));
      actions.appendChild(del);
      row.appendChild(actions);

      listHost.appendChild(row);
    });
  }

  function deleteBlogPost(slug, title) {
    if (!slug) return;
    const ok =
      typeof window.confirm === "function"
        ? window.confirm('Delete the post "' + (title || slug) + '"?')
        : true;
    if (!ok) return;
    const myScreen = screenGen;
    fetch("/api/posts/" + encodeURIComponent(slug), {
      method: "DELETE",
      credentials: "same-origin",
    })
      .then((res) => {
        if (myScreen !== screenGen) return;
        if (res.ok) {
          toast("Post deleted", "success");
          renderBlogList();
          return;
        }
        if (res.status === 401) {
          toast("Not deleted — your session expired.", "error");
          renderSignIn("Your session expired. Sign in again to manage posts.");
          return;
        }
        toast("Delete failed (" + res.status + ")", "error");
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        toast("Delete failed — network error", "error");
      });
  }

  // --- open the editor (create / edit) ------------------------------------

  function openPostEditor(slug) {
    if (!slug) {
      // Create mode: a blank working model with today's date.
      postModel = {
        slug: "",
        title: "",
        html: "",
        excerpt: "",
        tags: [],
        date: isoToday(),
        draft: false,
      };
      postCreate = true;
      renderPostEditor(false);
      return;
    }

    // Edit mode: load the full post first.
    const myScreen = screenGen;
    viewHost.replaceChildren();
    const main = el("main", "admin-main");
    main.appendChild(el("p", "admin-note", "Loading post…"));
    viewHost.appendChild(main);

    fetch("/api/posts/" + encodeURIComponent(slug), { credentials: "same-origin" })
      .then((res) => {
        if (myScreen !== screenGen) return;
        if (!res.ok) {
          if (res.status === 401) {
            toast("Your session expired.", "error");
            renderSignIn("Your session expired. Sign in again to edit posts.");
            return;
          }
          main.replaceChildren();
          const box = el("div", "admin-error");
          box.appendChild(
            el("p", "admin-error__msg", "Couldn't load that post (" + res.status + ").")
          );
          const back = el("button", "admin-btn", "Back to list");
          back.type = "button";
          back.addEventListener("click", () => renderBlogList());
          box.appendChild(back);
          main.appendChild(box);
          return;
        }
        return res.json().then((post) => {
          if (myScreen !== screenGen) return;
          if (!Array.isArray(post.tags)) post.tags = [];
          postModel = post;
          postCreate = false;
          renderPostEditor(false);
        });
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        toast("Couldn't load that post — network error", "error");
        renderBlogList();
      });
  }

  // --- post editor form ---------------------------------------------------

  function renderPostEditor(isRecovery) {
    const myScreen = screenGen;
    const myRender = ++renderGen;
    onDirtyChange = updateBlogSaveBar;
    if (!Array.isArray(postModel.tags)) postModel.tags = [];
    // Tracks whether the user has hand-edited the slug; until they do, the slug
    // field auto-follows the title (create mode only).
    let slugEdited = !!postModel.slug;
    viewHost.replaceChildren();

    const main = el("main", "admin-main");

    const bar = el("div", "admin-blogbar");
    const back = el("button", "admin-btn admin-btn--ghost", "← Back to list");
    back.type = "button";
    back.addEventListener("click", () => {
      if (dirty) {
        const ok =
          typeof window.confirm === "function"
            ? window.confirm("You have unsaved changes. Discard them and go back?")
            : true;
        if (!ok) return;
      }
      dirty = false;
      postModel = null;
      renderBlogList();
    });
    bar.appendChild(back);
    bar.appendChild(el("span", "admin-card__spacer"));
    bar.appendChild(
      el("span", "admin-blogbar__mode", postCreate ? "New post" : "Editing post")
    );
    main.appendChild(bar);

    const form = el("div", "admin-postform");

    // Title
    const titleField = el("label", "admin-subfield");
    titleField.appendChild(el("span", "admin-subfield__label", "Title"));
    const titleInput = el("input", "admin-input");
    titleInput.type = "text";
    titleInput.placeholder = "Post title";
    titleInput.value = postModel.title || "";
    titleInput.addEventListener("input", () => {
      postModel.title = titleInput.value;
      // Auto-fill the slug from the title until the user edits the slug (create).
      if (postCreate && !slugEdited) {
        postModel.slug = clientSlugify(titleInput.value);
        if (slugInput) slugInput.value = postModel.slug;
      }
      markDirty();
    });
    titleField.appendChild(titleInput);
    form.appendChild(titleField);

    // Slug — editable text in create mode, read-only display in edit mode
    // (the server keeps the slug immutable on PUT).
    let slugInput = null;
    const slugField = el("label", "admin-subfield");
    slugField.appendChild(el("span", "admin-subfield__label", "Slug"));
    if (postCreate) {
      slugInput = el("input", "admin-input admin-input--mono");
      slugInput.type = "text";
      slugInput.placeholder = "auto-generated-from-title";
      slugInput.value = postModel.slug || "";
      slugInput.addEventListener("input", () => {
        slugEdited = true;
        postModel.slug = slugInput.value;
        markDirty();
      });
      slugField.appendChild(slugInput);
      slugField.appendChild(
        el(
          "span",
          "admin-subfield__hint",
          "Leave as-is to let the server generate it from the title."
        )
      );
    } else {
      const ro = el("div", "admin-readonly", postModel.slug || "");
      slugField.appendChild(ro);
      slugField.appendChild(
        el("span", "admin-subfield__hint", "The slug is fixed once a post is created.")
      );
    }
    form.appendChild(slugField);

    // Date
    const dateField = el("label", "admin-subfield");
    dateField.appendChild(el("span", "admin-subfield__label", "Date"));
    const dateInput = el("input", "admin-input admin-input--date");
    dateInput.type = "date";
    dateInput.value = postModel.date || isoToday();
    dateInput.addEventListener("input", () => {
      postModel.date = dateInput.value;
      markDirty();
    });
    dateField.appendChild(dateInput);
    form.appendChild(dateField);

    // Tags (reuse the page editor's chip editor over postModel.tags)
    const tagsField = el("div", "admin-subfield");
    tagsField.appendChild(el("span", "admin-subfield__label", "Tags"));
    const tagsHost = el("div", "admin-tagshost");
    function renderPostTags(focusNew) {
      tagsHost.replaceChildren(buildTags(postModel, renderPostTags));
      if (focusNew) {
        const inputs = tagsHost.querySelectorAll(".admin-tag__input");
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
      }
    }
    renderPostTags();
    tagsField.appendChild(tagsHost);
    form.appendChild(tagsField);

    // Draft
    const draftField = el("label", "admin-checkfield");
    const draftCb = el("input", "admin-checkbox");
    draftCb.type = "checkbox";
    draftCb.checked = !!postModel.draft;
    draftCb.addEventListener("change", () => {
      postModel.draft = draftCb.checked;
      markDirty();
    });
    draftField.appendChild(draftCb);
    draftField.appendChild(
      el("span", "admin-checkfield__label", "Draft (hidden from the public blog)")
    );
    form.appendChild(draftField);

    // Excerpt (optional)
    const exField = el("label", "admin-subfield");
    exField.appendChild(el("span", "admin-subfield__label", "Excerpt (optional)"));
    const exTa = el("textarea", "admin-input admin-textarea--plain");
    exTa.placeholder = "Leave blank to derive one from the body.";
    exTa.value = postModel.excerpt || "";
    exTa.addEventListener("input", () => {
      postModel.excerpt = exTa.value;
      markDirty();
    });
    exField.appendChild(exTa);
    form.appendChild(exField);

    // Body (Quill)
    const bodyField = el("div", "admin-subfield admin-field");
    bodyField.appendChild(el("span", "admin-subfield__label", "Body"));
    const quillHost = el("div", "admin-quill");
    bodyField.appendChild(quillHost);
    form.appendChild(bodyField);

    main.appendChild(form);
    viewHost.appendChild(main);
    viewHost.appendChild(buildBlogSaveBar());

    initPostQuill(quillHost, myRender, myScreen);

    if (isRecovery) {
      dirty = true;
      toast("Signed back in — your unsaved post is here. Click Save.", "success");
    }
    updateBlogSaveBar();
  }

  // Quill body editor with an overridden image handler (upload -> insert <img>).
  function initPostQuill(host, myRender, myScreen) {
    // Graceful fallback if Quill failed to load: a plain textarea over the HTML.
    if (typeof Quill === "undefined") {
      const ta = el("textarea", "admin-input admin-textarea");
      ta.value = postModel.html || "";
      ta.addEventListener("input", () => {
        postModel.html = ta.value;
        markDirty();
      });
      host.replaceWith(ta);
      return;
    }

    // Defer one tick so the host is attached; the generation guards cancel this
    // if a re-render or view/screen switch lands first.
    setTimeout(() => {
      if (myRender !== renderGen || myScreen !== screenGen) return;
      const q = new Quill(host, {
        theme: "snow",
        modules: {
          toolbar: {
            container: QUILL_TOOLBAR_BLOG,
            handlers: {
              image: function () {
                pickBodyImage(this.quill, myRender, myScreen);
              },
            },
          },
        },
        placeholder: "Write your post…",
      });
      // Seed from stored HTML FIRST, then bind text-change so the initial fill
      // doesn't mark dirty.
      if (postModel.html) q.clipboard.dangerouslyPasteHTML(postModel.html);
      q.on("text-change", () => {
        if (myRender !== renderGen || myScreen !== screenGen) return;
        postModel.html = q.root.innerHTML;
        markDirty();
      });
    }, 0);
  }

  // Open a file picker, then upload + insert the returned URL at the cursor.
  function pickBodyImage(quill, myRender, myScreen) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) uploadBodyImage(file, quill, myRender, myScreen);
    });
    input.click();
  }

  // Upload raw image bytes to /api/uploads (same pattern as the image block's
  // uploadImage) and insert an <img src="/uploads/…"> via the Quill API — never
  // a base64 data URI.
  function uploadBodyImage(file, quill, myRender, myScreen) {
    fetch("/api/uploads", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    })
      .then((res) => {
        if (myScreen !== screenGen) return; // view/screen switched
        if (res.ok) {
          return res.json().then((data) => {
            if (myRender !== renderGen) return; // editor re-rendered mid-upload
            const url = (data && data.url) || "";
            if (!url) {
              toast("Upload failed — no URL returned.", "error");
              return;
            }
            // The upload endpoint is expected to return a same-origin
            // /uploads/… path; refuse anything else so a stray/absolute URL
            // can't be embedded (keeps the "same-origin" guarantee real).
            if (!/^\/uploads\//.test(url)) {
              toast("Upload rejected — unexpected image URL.", "error");
              return;
            }
            const range = quill.getSelection(true);
            const index = range ? range.index : quill.getLength();
            quill.insertEmbed(index, "image", url, "user");
            quill.setSelection(index + 1, 0, "user");
            // text-change fires from the "user" edit -> model.html + markDirty.
            toast("Image uploaded", "success");
          });
        }
        if (res.status === 401) {
          // Session expired mid-upload. Mirror Save's recovery: stash the draft,
          // bounce to sign-in, keep dirty so beforeunload still guards.
          pendingUnsavedPost = { model: postModel, create: postCreate };
          toast("Not uploaded — your session expired.", "error");
          renderSignIn(
            "Your session expired and your post was NOT saved. " +
              "Sign in again, then re-insert the image and click Save."
          );
          dirty = true;
          return;
        }
        if (res.status === 413) {
          toast("Image too large (max 8 MB).", "error");
          return;
        }
        if (res.status === 415) {
          toast("Unsupported image type (use PNG, JPEG, WebP or GIF).", "error");
          return;
        }
        toast("Upload failed (" + res.status + ")", "error");
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        toast("Upload failed — network error", "error");
      });
  }

  // --- blog save bar ------------------------------------------------------

  function buildBlogSaveBar() {
    const bar = el("div", "admin-savebar");
    blogSaveStatusEl = el("span", "admin-savebar__status", "");
    blogSaveBtn = el("button", "admin-btn admin-btn--primary", "Save post");
    blogSaveBtn.type = "button";
    blogSaveBtn.addEventListener("click", saveBlogPost);
    bar.appendChild(blogSaveStatusEl);
    bar.appendChild(blogSaveBtn);
    return bar;
  }

  function updateBlogSaveBar() {
    if (!blogSaveBtn || !blogSaveStatusEl) return;
    if (blogSaving) {
      blogSaveStatusEl.textContent = "Saving…";
      blogSaveStatusEl.className = "admin-savebar__status";
      blogSaveBtn.disabled = true;
      return;
    }
    if (dirty) {
      blogSaveStatusEl.textContent = "Unsaved changes";
      blogSaveStatusEl.className = "admin-savebar__status admin-savebar__status--dirty";
      blogSaveBtn.disabled = false;
    } else {
      blogSaveStatusEl.textContent = "All changes saved";
      blogSaveStatusEl.className = "admin-savebar__status";
      blogSaveBtn.disabled = true;
    }
  }

  function saveBlogPost() {
    if (blogSaving || !postModel) return;
    const title = (postModel.title || "").trim();
    if (!title) {
      toast("A title is required.", "error");
      return;
    }
    blogSaving = true;
    updateBlogSaveBar();
    const myScreen = screenGen;
    const create = postCreate;

    const body = {
      title: title,
      html: postModel.html || "",
      excerpt: (postModel.excerpt || "").trim(),
      tags: Array.isArray(postModel.tags) ? postModel.tags : [],
      date: postModel.date || "",
      draft: !!postModel.draft,
    };
    // Only send a slug on create when the user actually supplied one; otherwise
    // let the server derive it. On update the slug is immutable, so never sent.
    if (create && (postModel.slug || "").trim()) {
      body.slug = postModel.slug.trim();
    }
    const url = create
      ? "/api/posts"
      : "/api/posts/" + encodeURIComponent(postModel.slug);
    const method = create ? "POST" : "PUT";

    fetch(url, {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (myScreen !== screenGen) return; // signed out / view switched mid-save
        blogSaving = false;
        if (res.ok) {
          return res.json().then((saved) => {
            if (myScreen !== screenGen) return;
            if (!Array.isArray(saved.tags)) saved.tags = [];
            postModel = saved;
            postCreate = false; // create -> edit mode for the returned slug
            dirty = false;
            toast("Saved", "success");
            renderPostEditor(false); // re-render: slug now read-only, body reseeded
          });
        }
        if (res.status === 401) {
          pendingUnsavedPost = { model: postModel, create: postCreate };
          toast("Not saved — your session expired.", "error");
          renderSignIn(
            "Your session expired and your post was NOT saved. " +
              "Sign in again, then click Save."
          );
          dirty = true;
          return;
        }
        if (res.status === 409) {
          toast("That slug already exists — choose another.", "error");
          updateBlogSaveBar();
          return;
        }
        if (res.status === 413) {
          toast("Post too large.", "error");
          updateBlogSaveBar();
          return;
        }
        toast("Save failed (" + res.status + ")", "error");
        updateBlogSaveBar();
      })
      .catch(() => {
        if (myScreen !== screenGen) return;
        blogSaving = false;
        toast("Save failed — network error", "error");
        updateBlogSaveBar();
      });
  }

  // --- sign-in screen (mirrors editor.js's GIS flow) ----------------------

  function renderSignIn(message) {
    ++screenGen; // any in-flight dashboard async is now stale
    dirty = false;
    onDirtyChange = null;
    saveBtn = null;
    saveStatusEl = null;
    blocksContainer = null;
    blogSaveBtn = null;
    blogSaveStatusEl = null;
    pageTab = null;
    blogTab = null;
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
    // A clean sign-out drops any stashed draft and returns to the default view.
    currentView = "page";
    pendingUnsavedDoc = null;
    pendingUnsavedPost = null;
    postModel = null;
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
    getView: function () {
      return currentView;
    },
    switchView: switchView,
    getPostModel: function () {
      return postModel;
    },
  };

  start();
})();
