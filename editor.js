// In-site visual editor — shell (Task 2). Content editing is added in Task 3,
// Save wiring in Task 5. This file only builds the editor toolbar and toggles
// an `editing` state; it never touches the public render path.

// TEMPORARY dev gate — replaced by a Google-auth check in Task 6.
function isEditor() {
  return location.hash === "#edit";
}

let toolbar = null;
let editBtn = null;

function setEditing(on) {
  document.body.classList.toggle("editing", on);
  if (editBtn) {
    editBtn.setAttribute("aria-pressed", String(on));
    editBtn.textContent = on ? "Editing…" : "Edit";
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
