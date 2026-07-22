// On-page visual builder. Lazy-loaded by script.js only for the signed-in
// owner (the Edit button). The block document stays the single source of
// truth: pointer gestures and inline text edits mutate `workingDoc`, the DOM
// is either patched in place (drag/resize/typing) or re-rendered through
// script.js's renderer (structural changes, undo, discard). Nothing persists
// until Save PUTs the doc to /api/content — Exit/Discard always recover the
// last saved state, which also makes the first-run canvas migration safe.

const EDITOR_CSS_V = "20260722a";
const SNAP_PX = 6;
const MIN_BLOCK_W = 80;
const DRAG_THRESHOLD = 3;
const SOCIAL_ICONS = ["github", "linkedin", "mail", "external"];

let site = null;
let active = false;
let workingDoc = null;
let savedDoc = null;
let lastCommitted = null;
let undoStack = [];
let redoStack = [];
let dirty = false;
let selectedId = null;

// Text editing state: the element being edited and how to commit it back.
let textEdit = null; // { el, block, commit() }

// Chrome / overlay nodes and teardown plumbing.
let bar = null;
let overlay = null;
let selBox = null;
let guideV = null;
let guideH = null;
let textToolbar = null;
let statusEl = null;
let listeners = null; // AbortController for all edit-mode listeners
let selObserver = null; // ResizeObserver keeping the selection box in sync

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// --- Non-blocking dialog replacements ---------------------------------------
// Native alert/confirm/prompt block the renderer (and freeze automation), so
// the editor never uses them: notices are transient toasts, confirmations are
// "activate twice", and prompts are a small floating input panel.

let noticeEl = null;
let noticeTimer = null;

function flashNotice(msg) {
  if (!noticeEl) {
    noticeEl = el("div", "editor-notice");
    document.body.appendChild(noticeEl);
  }
  noticeEl.textContent = msg;
  noticeEl.classList.add("editor-notice--show");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (noticeEl) noticeEl.classList.remove("editor-notice--show");
  }, 3500);
}

let armed = null; // { key, timer } — pending destructive action

// Two-step confirmation: returns true only when `key` was armed by a previous
// call within the timeout (i.e. the second activation).
function armTwice(key, warning) {
  if (armed && armed.key === key) {
    clearTimeout(armed.timer);
    armed = null;
    return true;
  }
  if (armed) clearTimeout(armed.timer);
  flashNotice(warning);
  armed = {
    key,
    timer: setTimeout(() => {
      armed = null;
    }, 3000),
  };
  return false;
}

let promptPanel = null;

function miniPrompt(label, initial, cb) {
  if (promptPanel) promptPanel.remove();
  const panel = el("div", "editor-prompt");
  const lab = el("label", "editor-prompt__label", label);
  const input = el("input", "editor-prompt__input");
  input.type = "text";
  input.value = initial || "";
  const ok = el("button", "editor-prompt__btn editor-prompt__btn--ok", "OK");
  const cancel = el("button", "editor-prompt__btn", "Cancel");
  ok.type = "button";
  cancel.type = "button";
  const done = (value) => {
    panel.remove();
    if (promptPanel === panel) promptPanel = null;
    cb(value);
  };
  ok.addEventListener("click", () => done(input.value));
  cancel.addEventListener("click", () => done(null));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep Delete/⌘Z etc. away from the canvas handlers
    if (e.key === "Enter") {
      e.preventDefault();
      done(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      done(null);
    }
  });
  panel.append(lab, input, ok, cancel);
  document.body.appendChild(panel);
  promptPanel = panel;
  input.focus();
  input.select();
}

const clone = (obj) => structuredClone(obj);

function getBlock(id) {
  return (workingDoc.blocks || []).find((b) => b && b.id === id) || null;
}

function blockNode(id) {
  if (!id) return null;
  return document.querySelector('#content [data-block-id="' + CSS.escape(id) + '"]');
}

function canvasEl() {
  return document.querySelector("#content .canvas");
}

// --- Undo / dirty ----------------------------------------------------------
// Every completed gesture (drag end, resize end, text commit, structural op)
// funnels through commitChange(): the pre-gesture state goes on the undo
// stack. In-progress gestures mutate workingDoc/DOM freely without snapshots.

function commitChange() {
  undoStack.push(lastCommitted);
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
  lastCommitted = clone(workingDoc);
  dirty = true;
  updateChrome();
}

function undo() {
  if (!undoStack.length) return;
  finishTextEdit();
  redoStack.push(clone(workingDoc));
  workingDoc = undoStack.pop();
  lastCommitted = clone(workingDoc);
  dirty = true;
  applyDoc();
  updateChrome();
}

function redo() {
  if (!redoStack.length) return;
  finishTextEdit();
  undoStack.push(clone(workingDoc));
  workingDoc = redoStack.pop();
  lastCommitted = clone(workingDoc);
  dirty = true;
  applyDoc();
  updateChrome();
}

// Re-render from the doc and re-attach editor affordances.
function applyDoc() {
  select(null);
  site.render(workingDoc);
  enhance();
}

// --- Enter / exit ----------------------------------------------------------

export function initEditor(s) {
  site = s;
  if (active) return;
  enterEditMode();
}

async function enterEditMode() {
  ensureEditorCss();
  if (window.innerWidth < 768) {
    flashNotice("The editor needs a window at least 768px wide.");
    return;
  }

  workingDoc = clone(site.getDoc());
  savedDoc = clone(workingDoc);

  const isLegacy = !(workingDoc.layout && workingDoc.layout.mode === "canvas");

  active = true;
  document.body.classList.add("editing");

  if (isLegacy) await migrateToCanvas(workingDoc);
  lastCommitted = clone(workingDoc);
  undoStack = [];
  redoStack = [];
  dirty = false;

  site.render(workingDoc); // body.editing pins scale to 1 (design-space px)
  attachChrome();
  attachOverlay();
  enhance();
  bindGlobal();
  updateChrome();
  if (isLegacy && window.innerWidth < 1180) {
    // Below 1180px the flow page renders the portrait inline, so migration
    // captured it in-column. Nothing is saved yet — Exit and retry wide keeps
    // the gutter layout.
    setStatus(
      "Heads up: window < 1180px, so the portrait was captured inline (not in the gutter). Exit without saving and retry with a wider window to keep the gutter.",
      true
    );
  }
}

function exitEditMode() {
  if (dirty && !armTwice("exit", "Unsaved changes — click Exit again to discard them")) return;
  finishTextEdit();
  active = false;
  if (listeners) listeners.abort();
  listeners = null;
  if (selObserver) selObserver.disconnect();
  selObserver = null;
  if (bar) bar.remove();
  if (overlay) overlay.remove();
  bar = overlay = selBox = guideV = guideH = textToolbar = statusEl = null;
  selectedId = null;
  document.body.classList.remove("editing");
  site.render(savedDoc);
}

function ensureEditorCss() {
  if (document.getElementById("editor-css")) return;
  const link = document.createElement("link");
  link.id = "editor-css";
  link.rel = "stylesheet";
  link.href = "/editor.css?v=" + EDITOR_CSS_V;
  document.head.appendChild(link);
}

// --- Migration: legacy flow doc -> canvas frames ---------------------------
// Measures the live flow rendering, so the canvas starting point is visually
// identical to today's page. Runs before any editor chrome exists and only
// against the in-memory doc — the server keeps the legacy doc until Save.

async function migrateToCanvas(doc) {
  document
    .querySelectorAll("#content .fade-in")
    .forEach((n) => n.classList.add("visible"));
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images)
      .filter((img) => !img.complete)
      .map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
      )
  );

  const root = document.getElementById("content");
  const rootRect = root.getBoundingClientRect();
  const rootStyle = getComputedStyle(root);
  const originX = rootRect.left + parseFloat(rootStyle.paddingLeft);
  const originY = rootRect.top + parseFloat(rootStyle.paddingTop);

  const measured = [];
  (doc.blocks || []).forEach((block) => {
    const node = blockNode(block.id);
    if (!node) return; // e.g. an image block with no src renders nothing
    const r = node.getBoundingClientRect();
    measured.push({ block, x: r.left - originX, y: r.top - originY, w: r.width });
  });

  // Shift everything right so the portrait's negative-gutter x lands at 0.
  const minX = Math.min(0, ...measured.map((m) => m.x));
  const shift = Math.ceil(-minX);
  let rightmost = 0;
  measured.forEach((m) => {
    rightmost = Math.max(rightmost, m.x + m.w);
    m.block.frame = {
      x: Math.round(m.x + shift),
      y: Math.max(0, Math.round(m.y)),
      w: Math.max(MIN_BLOCK_W, Math.round(m.w)),
    };
  });
  doc.layout = { mode: "canvas", width: Math.max(960, Math.ceil(shift + rightmost)) };
}

// --- Chrome (floating toolbar) ---------------------------------------------

function attachChrome() {
  bar = el("div", "editor-bar");

  const mkBtn = (label, title, onClick, cls) => {
    const b = el("button", "editor-bar__btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", onClick);
    bar.appendChild(b);
    return b;
  };

  mkBtn("↺", "Undo (⌘Z)", undo);
  mkBtn("↻", "Redo (⇧⌘Z)", redo);
  bar.appendChild(el("span", "editor-bar__sep"));
  mkBtn("Discard", "Revert to the last saved state", discardChanges);
  mkBtn("Save", "Save to the site", saveDoc, "editor-bar__btn--primary");
  mkBtn("Exit", "Leave the editor", exitEditMode);
  statusEl = el("span", "editor-bar__status");
  bar.appendChild(statusEl);

  const hint = el(
    "div",
    "editor-bar__hint",
    "Drag to move · edges resize · double-click edits text · ⌫ deletes the selected block · blocks don't push each other"
  );
  bar.appendChild(hint);

  document.body.appendChild(bar);
}

function updateChrome() {
  if (!bar) return;
  const [undoBtn, redoBtn, , saveBtn] = bar.querySelectorAll("button");
  undoBtn.disabled = !undoStack.length;
  redoBtn.disabled = !redoStack.length;
  saveBtn.disabled = !dirty;
  bar.classList.toggle("editor-bar--dirty", dirty);
}

function setStatus(msg, isError) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("editor-bar__status--error", !!isError);
}

function discardChanges() {
  if (dirty && !armTwice("discard", "Click Discard again to revert to the last saved state")) return;
  finishTextEdit();
  workingDoc = clone(savedDoc);
  lastCommitted = clone(workingDoc);
  undoStack = [];
  redoStack = [];
  dirty = false;
  // A legacy saved doc has no frames; keep editing it as a canvas by re-running
  // migration against the re-rendered flow layout would be overkill — instead
  // exit to the saved state. A canvas saved doc just re-renders in place.
  if (workingDoc.layout && workingDoc.layout.mode === "canvas") {
    applyDoc();
    updateChrome();
    setStatus("");
  } else {
    active = false;
    document.body.classList.remove("editing");
    if (listeners) listeners.abort();
    listeners = null;
    if (bar) bar.remove();
    if (overlay) overlay.remove();
    bar = overlay = selBox = guideV = guideH = textToolbar = statusEl = null;
    site.render(savedDoc);
  }
}

function saveDoc() {
  finishTextEdit();
  // Mobile stacking order follows array order, so keep it sorted by frame
  // position. Frameless blocks (added via /admin, not yet framed) stay last.
  workingDoc.blocks.sort((a, b) => {
    const fa = a && a.frame;
    const fb = b && b.frame;
    if (!fa && !fb) return 0;
    if (!fa) return 1;
    if (!fb) return -1;
    return fa.y - fb.y || fa.x - fb.x;
  });
  // Keep /admin's portrait form coherent with the canvas width.
  workingDoc.blocks.forEach((b) => {
    if (b && b.type === "portrait" && b.frame) b.width = b.frame.w;
  });

  setStatus("Saving…");
  fetch("/api/content", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workingDoc),
  })
    .then((res) => {
      if (res.ok) {
        savedDoc = clone(workingDoc);
        dirty = false;
        applyDoc();
        updateChrome();
        setStatus("Saved");
        setTimeout(() => {
          if (!dirty) setStatus("");
        }, 2000);
        return;
      }
      if (res.status === 401) {
        setStatus(
          "Session expired — sign in via /admin in another tab, then Save again. Your changes are still here.",
          true
        );
        return;
      }
      setStatus("Save failed (" + res.status + ") — changes kept, try again.", true);
    })
    .catch(() => {
      setStatus("Save failed (network) — changes kept, try again.", true);
    });
}

// --- Overlay: selection box, handles, guides, text toolbar ------------------

function attachOverlay() {
  const viewport = document.querySelector("#content .canvas-viewport");
  if (!viewport) return;
  overlay = el("div", "editor-overlay");
  overlay.id = "editor-overlay";

  selBox = el("div", "editor-sel");
  const handleW = el("div", "editor-handle editor-handle--w");
  const handleE = el("div", "editor-handle editor-handle--e");
  handleW.addEventListener("pointerdown", (e) => beginResize(e, "w"));
  handleE.addEventListener("pointerdown", (e) => beginResize(e, "e"));
  const delBtn = el("button", "editor-sel__delete", "×");
  delBtn.type = "button";
  delBtn.title = "Delete block";
  delBtn.addEventListener("click", deleteSelected);
  selBox.append(handleW, handleE, delBtn);

  guideV = el("div", "editor-guide editor-guide--v");
  guideH = el("div", "editor-guide editor-guide--h");

  textToolbar = el("div", "editor-text-toolbar");
  const mkFmt = (label, title, fn) => {
    const b = el("button", "editor-text-toolbar__btn", label);
    b.type = "button";
    b.title = title;
    // mousedown+preventDefault keeps focus and the selection in the field.
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      fn();
    });
    textToolbar.appendChild(b);
  };
  mkFmt("B", "Bold", () => document.execCommand("bold"));
  mkFmt("I", "Italic", () => document.execCommand("italic"));
  mkFmt("Link", "Add link", () => {
    // The prompt input steals focus, so preserve the text selection and put
    // it back before running createLink.
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    miniPrompt("Link URL", "https://", (url) => {
      if (!url || !range || !textEdit) return;
      textEdit.el.focus();
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.execCommand("createLink", false, url);
    });
  });
  mkFmt("Clear", "Remove formatting", () => {
    document.execCommand("removeFormat");
    document.execCommand("unlink");
  });

  overlay.append(selBox, guideV, guideH, textToolbar);
  viewport.appendChild(overlay);
  selObserver = new ResizeObserver(() => syncOverlay());
}

function select(id) {
  if (selectedId && selObserver) {
    const prev = blockNode(selectedId);
    if (prev) selObserver.unobserve(prev);
  }
  selectedId = id;
  if (id && selObserver) {
    const node = blockNode(id);
    if (node) selObserver.observe(node);
  }
  syncOverlay();
}

function syncOverlay() {
  if (!selBox) return;
  const node = blockNode(selectedId);
  if (!node) {
    selBox.style.display = "none";
    hideTextToolbar();
    return;
  }
  selBox.style.display = "block";
  selBox.style.left = node.offsetLeft + "px";
  selBox.style.top = node.offsetTop + "px";
  selBox.style.width = node.offsetWidth + "px";
  selBox.style.height = node.offsetHeight + "px";
  if (textEdit && textEdit.block.type === "richtext") {
    textToolbar.style.display = "flex";
    textToolbar.style.left = node.offsetLeft + "px";
    textToolbar.style.top = Math.max(0, node.offsetTop - 40) + "px";
  }
}

function hideGuides() {
  if (guideV) guideV.style.display = "none";
  if (guideH) guideH.style.display = "none";
}

function hideTextToolbar() {
  if (textToolbar) textToolbar.style.display = "none";
}

// --- Drag / resize / snap ---------------------------------------------------

function snapCandidates(excludeId) {
  const canvas = canvasEl();
  const width = workingDoc.layout.width || 960;
  const xs = [0, Math.round(width / 2), width];
  const ys = [0];
  if (canvas) {
    Array.from(canvas.children).forEach((node) => {
      const id = node.dataset.blockId;
      if (!id || id === excludeId) return;
      const x = node.offsetLeft;
      const y = node.offsetTop;
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      xs.push(x, Math.round(x + w / 2), x + w);
      ys.push(y, Math.round(y + h / 2), y + h);
    });
  }
  return { xs, ys };
}

// Snap edges (start / center / end) of a span to candidate lines. Returns the
// adjusted position and the line snapped to (for drawing the guide).
function snapSpan(pos, size, candidates) {
  let best = null;
  [pos, pos + size / 2, pos + size].forEach((edge) => {
    candidates.forEach((line) => {
      const d = line - edge;
      if (Math.abs(d) <= SNAP_PX && (!best || Math.abs(d) < Math.abs(best.d))) {
        best = { d, line };
      }
    });
  });
  return best ? { pos: pos + best.d, line: best.line } : { pos, line: null };
}

function beginDrag(e, node, block) {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const start = { x: block.frame.x, y: block.frame.y };
  const cands = snapCandidates(block.id);
  const width = workingDoc.layout.width || 960;
  let moved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    moved = true;
    let x = start.x + dx;
    let y = start.y + dy;
    let lineX = null;
    let lineY = null;
    if (!ev.altKey) {
      const sx = snapSpan(x, node.offsetWidth, cands.xs);
      const sy = snapSpan(y, node.offsetHeight, cands.ys);
      x = sx.pos;
      lineX = sx.line;
      y = sy.pos;
      lineY = sy.line;
    }
    x = Math.round(Math.min(Math.max(0, x), width - node.offsetWidth));
    y = Math.round(Math.max(0, y));
    block.frame.x = x;
    block.frame.y = y;
    node.style.left = x + "px";
    node.style.top = y + "px";
    drawGuides(lineX, lineY);
    site.relayout(); // grow the canvas if dragged past the bottom
    syncOverlay();
  };

  const onUp = () => {
    node.removeEventListener("pointermove", onMove);
    node.removeEventListener("pointerup", onUp);
    node.removeEventListener("pointercancel", onUp);
    hideGuides();
    if (moved) {
      commitChange();
      site.relayout();
      syncOverlay();
    }
  };

  node.setPointerCapture(e.pointerId);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);
}

function beginResize(e, side) {
  const block = getBlock(selectedId);
  const node = blockNode(selectedId);
  if (!block || !block.frame || !node) return;
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const start = { x: block.frame.x, w: block.frame.w };
  const cands = snapCandidates(block.id);
  const width = workingDoc.layout.width || 960;
  let moved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    moved = true;
    let x = start.x;
    let w;
    let guideLine = null;
    if (side === "e") {
      w = start.w + dx;
      if (!ev.altKey) {
        const s = snapSpan(x + w, 0, cands.xs); // snap the moving right edge
        w = s.pos - x;
        guideLine = s.line;
      }
      w = Math.min(Math.max(MIN_BLOCK_W, w), width - x);
    } else {
      const right = start.x + start.w;
      x = start.x + dx;
      if (!ev.altKey) {
        const s = snapSpan(x, 0, cands.xs); // snap the moving left edge
        x = s.pos;
        guideLine = s.line;
      }
      x = Math.min(Math.max(0, x), right - MIN_BLOCK_W);
      w = right - x;
    }
    block.frame.x = Math.round(x);
    block.frame.w = Math.round(w);
    node.style.left = block.frame.x + "px";
    node.style.width = block.frame.w + "px";
    drawGuides(guideLine, null);
    syncOverlay();
  };

  const onUp = (ev) => {
    ev.target.removeEventListener("pointermove", onMove);
    ev.target.removeEventListener("pointerup", onUp);
    ev.target.removeEventListener("pointercancel", onUp);
    hideGuides();
    if (moved) {
      if (block.type === "portrait") block.width = block.frame.w;
      commitChange();
      site.relayout();
      syncOverlay();
    }
  };

  e.target.setPointerCapture(e.pointerId);
  e.target.addEventListener("pointermove", onMove);
  e.target.addEventListener("pointerup", onUp);
  e.target.addEventListener("pointercancel", onUp);
}

function drawGuides(lineX, lineY) {
  if (lineX != null) {
    guideV.style.display = "block";
    guideV.style.left = lineX + "px";
  } else {
    guideV.style.display = "none";
  }
  if (lineY != null) {
    guideH.style.display = "block";
    guideH.style.top = lineY + "px";
  } else {
    guideH.style.display = "none";
  }
}

function deleteSelected() {
  const block = getBlock(selectedId);
  if (!block) return;
  const risky = ["projects", "experience", "portrait", "socials"];
  if (
    risky.includes(block.type) &&
    !armTwice("del:" + block.id, "Delete the whole “" + block.type + "” block? Activate again to confirm.")
  ) {
    return;
  }
  workingDoc.blocks = workingDoc.blocks.filter((b) => b !== block);
  commitChange();
  applyDoc();
}

// --- Inline text editing ----------------------------------------------------

// Map a double-clicked element to the doc field it edits. Returns null for
// non-editable targets.
function classifyEditable(target, node, block) {
  if (block.type === "heading") {
    return {
      el: node,
      plain: true,
      commit: (elx) => {
        block.text = elx.textContent;
      },
    };
  }
  if (block.type === "richtext") {
    return {
      el: node,
      plain: false,
      commit: (elx) => {
        block.html = elx.innerHTML;
      },
    };
  }
  if (block.type === "list") {
    const li = target.closest("li");
    if (!li) return null;
    return {
      el: li,
      plain: true,
      commit: () => {
        block.items = Array.from(node.querySelectorAll("li")).map((n) =>
          n.textContent.trim()
        );
      },
    };
  }
  if (block.type === "projects" || block.type === "experience") {
    const card = target.closest("[data-item-index]");
    if (!card) return null;
    const item = (block.items || [])[Number(card.dataset.itemIndex)];
    if (!item) return null;
    const tag = target.closest(".tag");
    if (tag && !tag.classList.contains("editor-tag-add")) {
      const tags = Array.from(card.querySelectorAll(".tag")).filter(
        (t) => !t.classList.contains("editor-tag-add")
      );
      const j = tags.indexOf(tag);
      return {
        el: tag,
        plain: true,
        commit: (elx) => {
          const text = elx.textContent.trim();
          if (text) item.tags[j] = text;
          else item.tags.splice(j, 1);
        },
        rerender: true,
      };
    }
    const fields = [
      [".project-card__name", "name"],
      [".project-card__course", "subtitle"],
      [".project-card__desc", "description"],
    ];
    for (const [sel, field] of fields) {
      const elx = target.closest(sel);
      if (elx) {
        return {
          el: elx,
          plain: true,
          commit: (n) => {
            item[field] = n.textContent;
          },
        };
      }
    }
  }
  return null;
}

function beginTextEdit(spec, block) {
  finishTextEdit();
  spec.el.setAttribute(
    "contenteditable",
    spec.plain ? "plaintext-only" : "true"
  );
  spec.el.classList.add("editor-editing-text");
  textEdit = { el: spec.el, block, spec, before: clone(workingDoc) };
  spec.el.focus();
  syncOverlay();
}

// Commit the active text edit (if any) back into the doc.
function finishTextEdit() {
  if (!textEdit) return;
  const { el: elx, spec } = textEdit;
  spec.commit(elx);
  elx.removeAttribute("contenteditable");
  elx.classList.remove("editor-editing-text");
  const changed = JSON.stringify(workingDoc) !== JSON.stringify(textEdit.before);
  const rerender = spec.rerender && changed;
  textEdit = null;
  hideTextToolbar();
  if (changed) commitChange();
  if (rerender) applyDoc(); // e.g. a removed tag chip must leave the DOM
  syncOverlay();
}

// List behaviors: Enter splits into a new item, Backspace on an empty item
// removes it. Both are structural, so they commit + re-render, then resume
// editing at the right li.
function handleListKeys(e) {
  if (!textEdit || textEdit.block.type !== "list") return false;
  const li = textEdit.el;
  const block = textEdit.block;
  const listNode = li.closest("[data-block-id]");
  const index = Array.from(listNode.querySelectorAll("li")).indexOf(li);

  if (e.key === "Enter") {
    e.preventDefault();
    finishTextEdit();
    block.items.splice(index + 1, 0, "");
    commitChange();
    applyDoc();
    resumeListEdit(block, index + 1);
    return true;
  }
  if (e.key === "Backspace" && li.textContent.trim() === "" && block.items.length > 1) {
    e.preventDefault();
    textEdit = null; // the li is going away; nothing to commit
    hideTextToolbar();
    block.items.splice(index, 1);
    commitChange();
    applyDoc();
    resumeListEdit(block, Math.max(0, index - 1));
    return true;
  }
  return false;
}

function resumeListEdit(block, index) {
  const node = blockNode(block.id);
  const li = node && node.querySelectorAll("li")[index];
  if (!li) return;
  select(block.id);
  beginTextEdit(
    {
      el: li,
      plain: true,
      commit: () => {
        block.items = Array.from(node.querySelectorAll("li")).map((n) =>
          n.textContent.trim()
        );
      },
    },
    block
  );
}

// --- Editor affordances re-attached after every render ----------------------

function enhance() {
  const canvas = canvasEl();
  if (!canvas) return;

  // Every re-render rebuilds #content, which detaches the overlay (it lives
  // inside .canvas-viewport). The overlay node and its listeners are reusable —
  // just re-append it.
  if (overlay && !overlay.isConnected) {
    const viewport = document.querySelector("#content .canvas-viewport");
    if (viewport) viewport.appendChild(overlay);
  }

  (workingDoc.blocks || []).forEach((block) => {
    const node = blockNode(block.id);
    if (!node) return;

    if (block.type === "projects" || block.type === "experience") {
      node.querySelectorAll("[data-item-index]").forEach((card) => {
        const i = Number(card.dataset.itemIndex);
        const x = el("button", "editor-ui editor-card-x", "×");
        x.type = "button";
        x.title = "Delete card";
        x.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          block.items.splice(i, 1);
          commitChange();
          applyDoc();
        });
        card.appendChild(x);

        const tagsWrap = card.querySelector(".project-card__tags");
        if (tagsWrap) {
          const add = el("span", "tag editor-ui editor-tag-add", "+");
          add.title = "Add tag";
          add.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            block.items[i].tags = block.items[i].tags || [];
            block.items[i].tags.push("tag");
            commitChange();
            applyDoc();
            const fresh = blockNode(block.id);
            const chips =
              fresh &&
              fresh
                .querySelectorAll("[data-item-index]")
                [i].querySelectorAll(".tag:not(.editor-tag-add)");
            const last = chips && chips[chips.length - 1];
            if (last) {
              select(block.id);
              beginTextEdit(classifyEditable(last, fresh, block), block);
              document.execCommand("selectAll");
            }
          });
          tagsWrap.appendChild(add);
        }
      });

      const add = el("div", "project-card editor-ui editor-card-add", "+ card");
      add.title = "Add card";
      add.addEventListener("click", () => {
        const item = { name: "New", description: "Description", tags: [] };
        if (block.type === "experience") item.subtitle = "Role · Year";
        block.items.push(item);
        commitChange();
        applyDoc();
      });
      node.appendChild(add);
    }

    if (block.type === "socials") {
      const add = el("button", "editor-ui editor-social-add", "+");
      add.type = "button";
      add.title = "Add social link";
      add.addEventListener("click", () => {
        miniPrompt("Icon (" + SOCIAL_ICONS.join(", ") + ")", "github", (icon) => {
          if (!icon || !SOCIAL_ICONS.includes(icon.trim())) return;
          miniPrompt("URL", "https://", (url) => {
            if (!url) return;
            block.items = block.items || [];
            block.items.push({ name: icon.trim(), url, icon: icon.trim() });
            commitChange();
            applyDoc();
          });
        });
      });
      node.appendChild(add);
      node.querySelectorAll("a").forEach((a, i) => {
        a.title = "Double-click to edit URL (empty removes it)";
        a.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const item = block.items[i];
          if (!item) return;
          miniPrompt("URL (leave empty to remove)", item.url, (url) => {
            if (url === null) return;
            if (url === "") block.items.splice(i, 1);
            else item.url = url;
            commitChange();
            applyDoc();
          });
        });
      });
    }

    if (block.type === "image" && block.src) {
      const btn = el("button", "editor-ui editor-img-replace", "Replace image");
      btn.type = "button";
      btn.addEventListener("click", () => pickImage(block, btn));
      node.appendChild(btn);
    }
  });

  syncOverlay();
}

function pickImage(block, btn) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    btn.disabled = true;
    btn.textContent = "Uploading…";
    fetch("/api/uploads", {
      method: "POST",
      credentials: "same-origin",
      // Raw image bytes — the server reads Content-Type, not multipart.
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        block.src = (data && data.url) || block.src;
        commitChange();
        applyDoc();
      })
      .catch((status) => {
        btn.disabled = false;
        btn.textContent = "Replace image";
        setStatus(
          status === 401
            ? "Session expired — sign in via /admin, then retry the upload."
            : "Upload failed — try again.",
          true
        );
      });
  });
  input.click();
}

// --- Global listeners (delegated; removed together on exit) -----------------

function bindGlobal() {
  listeners = new AbortController();
  const { signal } = listeners;
  const content = document.getElementById("content");

  // Block navigation while editing (cards and socials are links).
  content.addEventListener(
    "click",
    (e) => {
      if (e.target.closest("a")) e.preventDefault();
    },
    { capture: true, signal }
  );

  content.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".editor-ui")) return; // editor buttons handle themselves
      const node = e.target.closest("[data-block-id]");
      if (textEdit) {
        if (textEdit.el.contains(e.target)) return; // typing/selecting inside the field
        finishTextEdit();
      }
      if (!node) {
        select(null);
        return;
      }
      select(node.dataset.blockId);
      const block = getBlock(node.dataset.blockId);
      if (block && block.frame) beginDrag(e, node, block);
    },
    { signal }
  );

  content.addEventListener(
    "dblclick",
    (e) => {
      if (e.target.closest(".editor-ui")) return;
      const node = e.target.closest("[data-block-id]");
      if (!node) return;
      const block = getBlock(node.dataset.blockId);
      if (!block || block.type === "socials") return; // socials use their own dblclick
      const spec = classifyEditable(e.target, node, block);
      if (!spec) return;
      select(block.id);
      beginTextEdit(spec, block);
      // Put the caret where the user clicked instead of at the start.
      const range = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : null;
      if (range && spec.el.contains(range.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    },
    { signal }
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (!active) return;
      const meta = e.metaKey || e.ctrlKey;
      if (textEdit) {
        if (handleListKeys(e)) return;
        if (e.key === "Escape") {
          e.preventDefault();
          finishTextEdit();
        }
        return; // native editing (incl. the field's own ⌘Z) while typing
      }
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.key === "Escape") {
        select(null);
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    },
    { signal }
  );

  window.addEventListener(
    "beforeunload",
    (e) => {
      if (active && dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    },
    { signal }
  );
}
