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

  // Handle input on any editable element (delegated, attached once).
  function onEditInput(e) {
    const el = e.target.closest("[data-edit]");
    if (!el) return;
    const path = el.getAttribute("data-edit");
    const value = el.textContent;
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
    } else {
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
