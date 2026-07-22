// Public block renderer. The homepage is a read-only document of blocks
// (see content-default.js for the shape). This file renders the blocks into
// #content and wires the scroll reveal + face-swap hover. It never mutates the
// content — editing happens only through the admin console (built separately).

// SVG icon paths (safe static content)
const ICON_PATHS = {
  github:
    "M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z",
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  external:
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  mail:
    "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
};

function createSvgIcon(iconName) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[iconName] || "");
  svg.appendChild(path);
  return svg;
}

// Small DOM helper: element with an optional className.
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// --- Block renderers -------------------------------------------------------
// Each returns a single DOM node for one block. Every block carries `.block`
// (spacing rhythm), a `.block--<type>` modifier, and `.fade-in` (scroll reveal).

function renderPortrait(block) {
  const wrap = el("div", "block block--portrait fade-in");
  // width / offsetX drive the gutter placement via CSS custom properties, so
  // the responsive breakpoints in style.css can still override the width.
  wrap.style.setProperty("--portrait-width", (block.width ?? 180) + "px");
  wrap.style.setProperty("--portrait-offset", (block.offsetX ?? 212) + "px");

  const swap = el("div", "face-swap");
  swap.setAttribute("role", "img");
  swap.setAttribute("aria-label", "Photo of Andrei Suslov");
  swap.innerHTML =
    '<svg class="face-swap__face face-swap__face--default" viewBox="0 0 724 1086" xmlns="http://www.w3.org/2000/svg">' +
    '<image width="724" height="1086" href="face-serious.webp?v=20260717c"></image></svg>' +
    '<svg class="face-swap__face face-swap__face--hover" viewBox="0 0 724 1086" xmlns="http://www.w3.org/2000/svg">' +
    '<image width="724" height="1086" href="face-happy.webp?v=20260717c"></image></svg>';
  wrap.appendChild(swap);
  return wrap;
}

function renderHeading(block) {
  const level = block.level === 1 ? 1 : 2;
  const heading = el(
    "h" + level,
    (level === 1 ? "hero__heading" : "section-heading") +
      " block block--heading-" + level + " fade-in"
  );
  heading.textContent = block.text || "";
  return heading;
}

function renderRichtext(block) {
  const node = el("div", "richtext block block--richtext fade-in");
  // Owner-authored HTML (default doc or the server's content.json). This is
  // where the admin's WYSIWYG output lands later.
  node.innerHTML = block.html || "";
  return node;
}

function renderList(block) {
  const list = el("ul", "about__list block block--list fade-in");
  (block.items || []).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });
  return list;
}

// Build one project/experience card. `withSubtitle` adds the role/date line
// used by the experience grid. `index` is stamped on the card so the on-page
// editor can bind card fields back to `block.items[index]`.
function buildCard(item, withSubtitle, index) {
  let card;
  if (item.github) {
    card = el("a");
    card.href = item.github;
    card.target = "_blank";
    card.rel = "noopener";
  } else {
    card = el("div");
  }
  card.className = "project-card";
  if (typeof index === "number") card.dataset.itemIndex = String(index);

  const name = el("h3", "project-card__name");
  name.textContent = item.name;
  card.appendChild(name);

  if (withSubtitle && item.subtitle) {
    const subtitle = el("span", "project-card__course");
    subtitle.textContent = item.subtitle;
    card.appendChild(subtitle);
  }

  const desc = el("p", "project-card__desc");
  desc.textContent = item.description;
  card.appendChild(desc);

  const footer = el("div", "project-card__footer");
  const tags = el("div", "project-card__tags");
  (item.tags || []).forEach((t) => {
    const span = el("span", "tag");
    span.textContent = t;
    tags.appendChild(span);
  });
  footer.appendChild(tags);
  card.appendChild(footer);

  return card;
}

function renderProjects(block) {
  const grid = el("div", "projects__grid block block--grid fade-in");
  (block.items || []).forEach((item, i) => grid.appendChild(buildCard(item, false, i)));
  return grid;
}

function renderExperience(block) {
  const grid = el("div", "projects__grid block block--grid fade-in");
  (block.items || []).forEach((item, i) => grid.appendChild(buildCard(item, true, i)));
  return grid;
}

function renderImage(block) {
  // Empty src -> render nothing (the block exists in the doc but has no image
  // chosen yet). Never throw on a half-filled block.
  if (!block.src) return null;
  const wrap = el("div", "block block--image fade-in");
  const img = el("img", "image-block__img");
  img.src = block.src;
  img.alt = block.alt || "";
  img.loading = "lazy";
  wrap.appendChild(img);
  return wrap;
}

function renderSocials(block) {
  const wrap = el("div", "contact__socials block block--socials fade-in");
  (block.items || []).forEach((s) => {
    const a = el("a", "contact__social-link");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("aria-label", s.name);
    a.appendChild(createSvgIcon(s.icon));
    wrap.appendChild(a);
  });
  return wrap;
}

const RENDERERS = {
  portrait: renderPortrait,
  heading: renderHeading,
  richtext: renderRichtext,
  list: renderList,
  projects: renderProjects,
  experience: renderExperience,
  socials: renderSocials,
  image: renderImage,
};

// --- Canvas layout ---------------------------------------------------------
// A doc with `layout: {mode:"canvas", width}` positions each block absolutely
// by its `frame: {x, y, w}` (design-space px; height is always auto from
// content). Below the breakpoint frames are ignored and blocks stack in array
// order — the editor keeps the array sorted by y on save, so the mobile order
// matches the visual top-to-bottom order. Legacy docs (no `layout`) never
// enter this path.

const CANVAS_MQ = window.matchMedia("(min-width: 768px)");
const CANVAS_PAD_BOTTOM = 48;
const FRAMELESS_GAP = 24;

function isCanvasDoc(content) {
  return !!(content && content.layout && content.layout.mode === "canvas");
}

let canvasState = null; // { viewport, canvas, layout, observer }

function teardownCanvas() {
  if (canvasState) canvasState.observer.disconnect();
  canvasState = null;
}

// Size the canvas to its blocks, stack any frameless blocks (e.g. added via
// /admin) below the framed content, and scale the whole composition down when
// the viewport is narrower than the design width. Re-runs whenever a block
// resizes (images/fonts loading, text reflow after a width change).
function relayoutCanvas() {
  if (!canvasState) return;
  const { viewport, canvas, layout } = canvasState;
  const designWidth = layout.width || 960;

  let maxY = 0;
  const children = Array.from(canvas.children);
  children.forEach((node) => {
    if (node.dataset.frameless) return;
    maxY = Math.max(maxY, node.offsetTop + node.offsetHeight);
  });
  let cursor = maxY;
  children.forEach((node) => {
    if (!node.dataset.frameless) return;
    cursor += FRAMELESS_GAP;
    node.style.left = "0px";
    node.style.top = cursor + "px";
    node.style.width = designWidth + "px";
    cursor += node.offsetHeight;
  });
  const height = Math.max(maxY, cursor) + CANVAS_PAD_BOTTOM;
  canvas.style.width = designWidth + "px";
  canvas.style.height = height + "px";

  // Scale-to-fit. The editor pins scale to 1 (body.editing) so pointer math
  // stays in design-space px; a mid-size window scrolls horizontally instead.
  let f = 1;
  if (!document.body.classList.contains("editing")) {
    const avail = Math.max(320, window.innerWidth - 48);
    f = Math.min(1, avail / designWidth);
  }
  canvas.style.transform = f === 1 ? "" : "scale(" + f + ")";
  canvas.style.transformOrigin = "top left";
  viewport.style.width = Math.round(designWidth * f) + "px";
  viewport.style.height = Math.round(height * f) + "px";
}

// Render a whole block document into #content, replacing whatever was there.
function renderBlocks(content) {
  const root = document.getElementById("content");
  if (!root) return;
  teardownCanvas();
  root.replaceChildren();

  const useCanvas = isCanvasDoc(content) && CANVAS_MQ.matches;
  root.classList.toggle("canvas-mode", useCanvas);
  const main = root.closest("main");
  if (main) main.classList.toggle("canvas-page", useCanvas);

  let parent = root;
  if (useCanvas) {
    const viewport = el("div", "canvas-viewport");
    const canvas = el("div", "canvas");
    viewport.appendChild(canvas);
    root.appendChild(viewport);
    parent = canvas;
    canvasState = {
      viewport,
      canvas,
      layout: content.layout,
      observer: new ResizeObserver(() => requestAnimationFrame(relayoutCanvas)),
    };
  }

  const blocks = content && Array.isArray(content.blocks) ? content.blocks : [];
  blocks.forEach((block) => {
    const fn = RENDERERS[block && block.type];
    if (!fn) return; // unknown block types are skipped, never fatal
    const node = fn(block);
    if (!node) return;
    if (block.id) node.dataset.blockId = block.id;
    if (useCanvas) {
      const frame = block.frame;
      node.style.position = "absolute";
      if (frame && typeof frame.x === "number") {
        node.style.left = frame.x + "px";
        node.style.top = (frame.y || 0) + "px";
        node.style.width = (frame.w || 200) + "px";
      } else {
        node.dataset.frameless = "1"; // placed below framed content by relayoutCanvas
      }
      canvasState.observer.observe(node);
    }
    parent.appendChild(node);
  });
  if (useCanvas) relayoutCanvas();
}

// --- Scroll reveal ---------------------------------------------------------

// Reveal any not-yet-visible fade-in blocks currently in (or near) the viewport.
function revealVisible() {
  document.querySelectorAll(".fade-in:not(.visible)").forEach((elm) => {
    if (elm.getBoundingClientRect().top < window.innerHeight * 0.9) {
      elm.classList.add("visible");
    }
  });
}

// Attach the scroll/resize listeners once. They read the DOM at event time, so
// blocks added by a later re-render are picked up automatically.
function initScrollEffects() {
  const nav = document.querySelector(".nav");
  window.addEventListener("scroll", () => {
    nav.classList.toggle("scrolled", window.scrollY > 10);
  });
  window.addEventListener("scroll", revealVisible, { passive: true });
  window.addEventListener("resize", revealVisible, { passive: true });
  revealVisible();
}

// --- Face-swap hover (only react over the face's opaque pixels) ------------

function initFaceHover() {
  const swap = document.querySelector(".face-swap");
  const defaultFace = swap?.querySelector(".face-swap__face--default image");
  if (!swap || !defaultFace) return;

  const src = defaultFace.getAttribute("href");
  const probe = new Image();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  probe.onload = () => {
    canvas.width = probe.naturalWidth;
    canvas.height = probe.naturalHeight;
    ctx.drawImage(probe, 0, 0);
  };
  probe.src = src;

  const overFace = (e) => {
    if (!canvas.width) return false;
    const rect = swap.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    return ctx.getImageData(x, y, 1, 1).data[3] > 10;
  };

  swap.addEventListener("mousemove", (e) => {
    const on = overFace(e);
    swap.classList.toggle("is-face-hover", on);
    swap.style.cursor = on ? "pointer" : "default";
  });
  swap.addEventListener("mouseleave", () => {
    swap.classList.remove("is-face-hover");
  });
}

// --- Init ------------------------------------------------------------------
// Render the embedded default immediately (no blank flash), then ask the server
// for the authoritative document. If /api/content returns a {blocks:[...]}
// object we re-render from it; on 404 or any error the default stands, so the
// static file still works standalone.

let currentDoc = null;

function render(content) {
  currentDoc = content;
  renderBlocks(content);
  revealVisible();
  initFaceHover();
}

// Re-render when the viewport crosses the canvas breakpoint (frames on/off),
// and keep the scale-to-fit factor in sync with the window width.
CANVAS_MQ.addEventListener("change", () => {
  if (isCanvasDoc(currentDoc)) render(currentDoc);
});
window.addEventListener("resize", relayoutCanvas, { passive: true });

// --- Owner edit bootstrap --------------------------------------------------
// Visitors never see any of this: the Edit button only appears when /api/me
// says the session belongs to the site owner, and editor.js (the on-page
// visual builder) is imported on demand only then.

const EDITOR_V = "20260722a";

window.__site = {
  getDoc: () => currentDoc,
  render,
  relayout: relayoutCanvas,
};

function initEditButton() {
  fetch("/api/me", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : null))
    .then((me) => {
      if (!me || me.editor !== true) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "edit-fab";
      btn.textContent = "Edit";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        import("/editor.js?v=" + EDITOR_V)
          .then((mod) => mod.initEditor(window.__site))
          .finally(() => {
            btn.disabled = false;
          });
      });
      document.body.appendChild(btn);
    })
    .catch(() => {
      // Signed out or server down: no button, page is fully read-only.
    });
}

render(DEFAULT_CONTENT);
initScrollEffects();
initEditButton();

fetch("/api/content", { credentials: "same-origin" })
  .then((res) => (res.ok ? res.json() : null))
  .then((content) => {
    // Only upgrade from a non-empty document. An empty array (a truncated or
    // mis-saved content.json) would blank the page, so we keep the default.
    if (
      content &&
      typeof content === "object" &&
      Array.isArray(content.blocks) &&
      content.blocks.length > 0
    ) {
      render(content);
    }
  })
  .catch(() => {
    // Offline / server down / bad JSON: the default render already stands.
  });
