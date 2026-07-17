// In-site visual editor — shell (Task 2). Content editing is added in Task 3,
// Save wiring in Task 5. This file only builds the editor toolbar and toggles
// an `editing` state; it never touches the public render path.
//
// Everything lives inside this IIFE so the editor's identifiers stay off the
// shared global scope. Reading outer globals (`state`, `renderAll` from
// script.js) by bare name still works — an IIFE is a nested scope. All future
// editor logic (Tasks 3–5) goes inside this same boundary.
(function () {
  "use strict";

  // TEMPORARY dev gate — replaced by a Google-auth check in Task 6.
  function isEditor() {
    return location.hash === "#edit";
  }

  let toolbar = null;
  let editBtn = null;

  // --- Inline text editing (Task 3) ---

  // Write `value` into `obj` at a dot path (e.g. "personalProjects.items.0.name").
  // Walks/creates intermediate objects; numeric segments index/build arrays.
  function setByPath(obj, path, value) {
    const keys = path.split(".");
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (cur[key] == null || typeof cur[key] !== "object") {
        // Create the next container as an array if the *next* key is numeric.
        cur[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      }
      cur = cur[key];
    }
    cur[keys[keys.length - 1]] = value;
  }

  // Read the value at a dot path (read-only counterpart of setByPath).
  function getByPath(obj, path) {
    return path.split(".").reduce((cur, k) => (cur == null ? cur : cur[k]), obj);
  }

  // --- Structural block operations (Task 4): add / delete / reorder ---
  //
  // Each entry maps a rendered container to its backing state array. `kind`
  // drives control placement in CSS; `template` builds a fresh item; the primary
  // editable field (focused after an Add) is `<path>.<i>.<primaryField>`, or the
  // item element itself when `primaryField` is null.
  const COLLECTIONS = [
    {
      containerId: "personal-projects-grid",
      path: "personalProjects.items",
      kind: "card",
      primaryField: "name",
      template: () => ({ name: "New project", description: "What it does.", tags: [], github: "" }),
    },
    {
      containerId: "course-projects-grid",
      path: "courseProjects.items",
      kind: "card",
      primaryField: "name",
      template: () => ({ name: "New role", course: "Title · dates", description: "What you did.", tags: [] }),
    },
    {
      containerId: "about-list",
      path: "about.learning",
      kind: "list",
      primaryField: null,
      template: () => "New item",
    },
    {
      containerId: "contact-socials",
      path: "contact.socials",
      kind: "social",
      primaryField: null, // no editable text field yet (attribute editing is later)
      template: () => ({ name: "Link", url: "https://", icon: "github" }),
    },
  ];

  // Re-render from state, then re-inject controls and re-apply contenteditable
  // so the app stays fully in edit mode after any structural mutation.
  function refreshAfterMutation() {
    renderAll(state);
    decorateBlocks();
    enableEditing();
  }

  function moveItem(path, index, delta) {
    const arr = getByPath(state, path);
    const j = index + delta;
    if (!arr || j < 0 || j >= arr.length) return;
    const tmp = arr[index];
    arr[index] = arr[j];
    arr[j] = tmp;
    refreshAfterMutation();
  }

  function deleteItem(path, index) {
    const arr = getByPath(state, path);
    if (!arr) return;
    // Confirm for real users; window.confirm may be absent/stubbed in automation.
    if (window.confirm && !window.confirm("Delete this item?")) return;
    arr.splice(index, 1);
    refreshAfterMutation();
  }

  function addItem(coll) {
    const arr = getByPath(state, coll.path);
    if (!arr) return;
    arr.push(coll.template());
    const newIndex = arr.length - 1;
    refreshAfterMutation();
    focusPrimaryField(coll, newIndex);
  }

  // Focus (and place the caret in) a newly added item's primary text field.
  function focusPrimaryField(coll, index) {
    const suffix = coll.primaryField ? "." + coll.primaryField : "";
    const el = document.querySelector(
      '[data-edit="' + coll.path + "." + index + suffix + '"]'
    );
    if (el) {
      el.focus();
      placeCaretAtEnd(el);
    }
  }

  function makeCtrlBtn(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "editor-block-controls__btn";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => {
      // Stop the click from triggering card-anchor navigation or bubbling.
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function makeItemControls(coll, index, count) {
    const wrap = document.createElement("div");
    wrap.className = "editor-block-controls editor-block-controls--" + coll.kind;

    const up = makeCtrlBtn("↑", "Move up", () => moveItem(coll.path, index, -1));
    up.disabled = index === 0;
    const down = makeCtrlBtn("↓", "Move down", () => moveItem(coll.path, index, 1));
    down.disabled = index === count - 1;
    const del = makeCtrlBtn("✕", "Delete", () => deleteItem(coll.path, index));
    del.classList.add("editor-block-controls__del");

    wrap.append(up, down, del);
    return wrap;
  }

  function makeAddControl(coll) {
    const wrap = document.createElement("div");
    wrap.className = "editor-add";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "editor-add__btn";
    btn.textContent = "+ Add";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addItem(coll);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // Remove every injected control so decorate can run again cleanly.
  function undecorateBlocks() {
    document
      .querySelectorAll(".editor-block-controls, .editor-add")
      .forEach((n) => n.remove());
  }

  // Inject per-item controls (move up/down, delete) and a per-collection "+ Add".
  // Idempotent: always clears prior controls first, so repeated calls (and calls
  // after renderAll) never accumulate duplicates.
  function decorateBlocks() {
    undecorateBlocks();
    COLLECTIONS.forEach((coll) => {
      const container = document.getElementById(coll.containerId);
      if (!container) return;
      const arr = getByPath(state, coll.path) || [];
      // Snapshot item elements before appending controls to them.
      const items = Array.from(container.children);
      items.forEach((el, i) => {
        el.appendChild(makeItemControls(coll, i, arr.length));
      });
      container.insertAdjacentElement("afterend", makeAddControl(coll));
    });
  }

  // Move the caret to the end of an editable element's content.
  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Handle input on any editable element (delegated, attached once).
  function onEditInput(e) {
    const el = e.target.closest("[data-edit]");
    if (!el) return;
    const path = el.getAttribute("data-edit");
    let value = el.textContent;
    // Single-line fields must not acquire literal line breaks (e.g. pressing
    // Enter in a heading). Only descriptions, about.summary and hero.text are
    // multi-line; every other field collapses \n/\r to a single space, and we
    // reflect the normalized text back into the DOM.
    const multiline =
      /\.description$/.test(path) || path === "about.summary" || path === "hero.text";
    if (!multiline && /[\r\n]/.test(value)) {
      value = value.replace(/[\r\n]+/g, " ");
      el.textContent = value;
      placeCaretAtEnd(el);
    }
    if (path === "about.summary") {
      // #about-text maps to the whole rich summary array; collapse it to a
      // single text segment. Acceptable because the summary has no links.
      setByPath(state, path, [{ type: "text", value: value }]);
    } else {
      setByPath(state, path, value);
    }
    // Do NOT re-render — that would destroy the caret. The DOM already shows
    // the typed text; we only mirror it into `state`.
  }

  // While editing, a click inside an editable region — or anywhere inside an
  // anchor that wraps editable content (a whole project card, the nav logo) —
  // must place the caret, not navigate.
  function onEditClickCapture(e) {
    if (!document.body.classList.contains("editing")) return;
    const anchor = e.target.closest("a[href]");
    const editableAnchor =
      anchor && (anchor.matches("[data-edit]") || anchor.querySelector("[data-edit]"));
    if (e.target.closest("[data-edit]") || editableAnchor) {
      e.preventDefault();
    }
  }

  let editingListenersAttached = false;

  function enableEditing() {
    // Attach the delegated listeners once; enableEditing() is idempotent and
    // safe to call again after a future re-render (Task 4) to pick up fresh
    // [data-edit] nodes.
    if (!editingListenersAttached) {
      document.addEventListener("input", onEditInput);
      const main = document.querySelector("main");
      const nav = document.querySelector(".nav");
      if (main) main.addEventListener("click", onEditClickCapture, true);
      if (nav) nav.addEventListener("click", onEditClickCapture, true);
      editingListenersAttached = true;
    }
    document.querySelectorAll("[data-edit]").forEach((el) => {
      el.setAttribute("contenteditable", "plaintext-only");
      el.classList.add("is-editable");
    });
  }

  function disableEditing() {
    document.querySelectorAll("[data-edit]").forEach((el) => {
      el.removeAttribute("contenteditable");
      el.classList.remove("is-editable");
    });
    if (editingListenersAttached) {
      document.removeEventListener("input", onEditInput);
      const main = document.querySelector("main");
      const nav = document.querySelector(".nav");
      if (main) main.removeEventListener("click", onEditClickCapture, true);
      if (nav) nav.removeEventListener("click", onEditClickCapture, true);
      editingListenersAttached = false;
    }
  }

  function setEditing(on) {
    document.body.classList.toggle("editing", on);
    if (editBtn) {
      editBtn.setAttribute("aria-pressed", String(on));
      editBtn.textContent = on ? "Editing…" : "Edit";
    }
    if (on) {
      enableEditing();
      decorateBlocks();
    } else {
      undecorateBlocks();
      disableEditing();
    }
  }

  function buildToolbar() {
    const bar = document.createElement("div");
    bar.className = "editor-toolbar";

    editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "editor-toolbar__btn editor-toolbar__btn--edit";
    editBtn.textContent = "Edit";
    editBtn.setAttribute("aria-pressed", "false");
    editBtn.addEventListener("click", () => {
      setEditing(!document.body.classList.contains("editing"));
    });
    bar.appendChild(editBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "editor-toolbar__btn editor-toolbar__btn--save";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true; // wired up in Task 5
    bar.appendChild(saveBtn);

    return bar;
  }

  function showToolbar() {
    if (toolbar) return;
    toolbar = buildToolbar();
    document.body.appendChild(toolbar);
  }

  function hideToolbar() {
    setEditing(false);
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
      editBtn = null;
    }
  }

  function syncEditor() {
    if (isEditor()) {
      showToolbar();
    } else {
      hideToolbar();
    }
  }

  function initEditor() {
    window.addEventListener("hashchange", syncEditor);
    syncEditor();
  }

  initEditor();
})();
