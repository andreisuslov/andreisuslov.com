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

function buildRichContent(segments, parent) {
  segments.forEach((seg) => {
    if (seg.type === "text") {
      parent.appendChild(document.createTextNode(seg.value));
    } else if (seg.type === "link") {
      const a = document.createElement("a");
      a.href = seg.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = seg.text;
      parent.appendChild(a);
    }
  });
}

// --- Render functions ---

function renderMeta(meta) {
  document.title = meta.title;
  document
    .querySelector('meta[name="description"]')
    .setAttribute("content", meta.description);
}

function renderNav(nav) {
  const el = document.getElementById("nav-logo");
  el.textContent = nav.name;
  el.href = nav.href;
  el.setAttribute("data-edit", "nav.name");
}

function renderHero(hero) {
  const heading = document.getElementById("hero-heading");
  heading.textContent = hero.heading;
  heading.setAttribute("data-edit", "hero.heading");

  const text = document.getElementById("hero-text");
  text.textContent = hero.text;
  text.setAttribute("data-edit", "hero.text");
}

function renderAbout(about) {
  const textEl = document.getElementById("about-text");
  textEl.replaceChildren();
  buildRichContent(about.summary, textEl);
  // #about-text maps to the FULL about.summary. Editing collapses the rich
  // summary array to a single { type:"text" } segment (see editor.js). That is
  // acceptable here because the summary currently has no link segments.
  textEl.setAttribute("data-edit", "about.summary");

  const list = document.getElementById("about-list");
  list.replaceChildren();
  about.learning.forEach((item, i) => {
    const li = document.createElement("li");
    // The editable text lives on an inner span so the editor can append its
    // control cluster to the <li> (a sibling of the span) without those buttons
    // becoming part of the contenteditable element's textContent.
    const span = document.createElement("span");
    span.textContent = item;
    span.setAttribute("data-edit", "about.learning." + i);
    li.appendChild(span);
    list.appendChild(li);
  });
}

function renderProjectCards(items, gridId, basePath) {
  const grid = document.getElementById(gridId);
  grid.replaceChildren();

  items.forEach((p, i) => {
    let card;
    if (p.github) {
      card = document.createElement("a");
      card.href = p.github;
      card.target = "_blank";
      card.rel = "noopener";
    } else {
      card = document.createElement("div");
    }
    card.className = "project-card";

    const name = document.createElement("h3");
    name.className = "project-card__name";
    name.textContent = p.name;
    name.setAttribute("data-edit", basePath + "." + i + ".name");
    card.appendChild(name);

    if (p.course) {
      const course = document.createElement("span");
      course.className = "project-card__course";
      course.textContent = p.course;
      course.setAttribute("data-edit", basePath + "." + i + ".course");
      card.appendChild(course);
    }

    const desc = document.createElement("p");
    desc.className = "project-card__desc";
    desc.textContent = p.description;
    desc.setAttribute("data-edit", basePath + "." + i + ".description");
    card.appendChild(desc);

    const footer = document.createElement("div");
    footer.className = "project-card__footer";

    const tags = document.createElement("div");
    tags.className = "project-card__tags";
    p.tags.forEach((t) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = t;
      tags.appendChild(span);
    });
    footer.appendChild(tags);

    if (p.live) {
      const liveLink = document.createElement("a");
      liveLink.href = p.live;
      liveLink.target = "_blank";
      liveLink.rel = "noopener";
      liveLink.className = "project-card__live";
      liveLink.textContent = "Live";
      liveLink.addEventListener("click", (e) => e.stopPropagation());
      footer.appendChild(liveLink);
    }

    card.appendChild(footer);
    grid.appendChild(card);
  });
}

function renderPersonalProjects(data) {
  const heading = document.getElementById("personal-projects-heading");
  heading.textContent = data.heading;
  heading.setAttribute("data-edit", "personalProjects.heading");
  renderProjectCards(data.items, "personal-projects-grid", "personalProjects.items");
}

function renderCourseProjects(data) {
  const heading = document.getElementById("course-projects-heading");
  heading.textContent = data.heading;
  heading.setAttribute("data-edit", "courseProjects.heading");
  renderProjectCards(data.items, "course-projects-grid", "courseProjects.items");
}

function renderPublications(publications) {
  const pubHeading = document.getElementById("publications-heading");
  pubHeading.textContent = publications.heading;
  pubHeading.setAttribute("data-edit", "publications.heading");
  const list = document.getElementById("publications-list");
  list.replaceChildren();

  publications.items.forEach((pub) => {
    const card = document.createElement("a");
    card.href = pub.doi;
    card.target = "_blank";
    card.rel = "noopener";
    card.className = "publication-card";

    const title = document.createElement("h3");
    title.className = "publication-card__title";
    title.textContent = pub.title;
    card.appendChild(title);

    const authors = document.createElement("p");
    authors.className = "publication-card__authors";
    authors.textContent = pub.authors;
    card.appendChild(authors);

    const venue = document.createElement("p");
    venue.className = "publication-card__venue";
    venue.textContent = pub.venue;
    card.appendChild(venue);

    const meta = document.createElement("div");
    meta.className = "publication-card__meta";

    const year = document.createElement("span");
    year.className = "tag";
    year.textContent = pub.year;
    meta.appendChild(year);

    if (pub.location) {
      const loc = document.createElement("span");
      loc.className = "publication-card__location";
      loc.textContent = pub.location;
      meta.appendChild(loc);
    }

    if (pub.pages) {
      const pages = document.createElement("span");
      pages.className = "publication-card__location";
      pages.textContent = "pp. " + pub.pages;
      meta.appendChild(pages);
    }

    if (pub.volume) {
      const vol = document.createElement("span");
      vol.className = "publication-card__location";
      vol.textContent = "Vol. " + pub.volume;
      meta.appendChild(vol);
    }

    card.appendChild(meta);
    list.appendChild(card);
  });
}

function renderContact(contact) {
  const heading = document.getElementById("contact-heading");
  heading.textContent = contact.heading;
  heading.setAttribute("data-edit", "contact.heading");

  const text = document.getElementById("contact-text");
  text.textContent = contact.text;
  text.setAttribute("data-edit", "contact.text");

  if (contact.location) {
    const location = document.getElementById("contact-location");
    location.textContent = contact.location;
    location.setAttribute("data-edit", "contact.location");
  }

  const socials = document.getElementById("contact-socials");
  socials.replaceChildren();
  contact.socials.forEach((s) => {
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "contact__social-link";
    a.setAttribute("aria-label", s.name);
    a.appendChild(createSvgIcon(s.icon));
    socials.appendChild(a);
  });
}

// --- Scroll effects ---

function initScrollEffects() {
  const nav = document.querySelector(".nav");
  window.addEventListener("scroll", () => {
    nav.classList.toggle("scrolled", window.scrollY > 10);
  });

  const reveal = () => {
    document.querySelectorAll(".fade-in:not(.visible)").forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.9) {
        el.classList.add("visible");
      }
    });
  };
  window.addEventListener("scroll", reveal, { passive: true });
  window.addEventListener("resize", reveal, { passive: true });
  reveal();
}

// --- Face-swap hover (only react over the face's opaque pixels) ---

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

// --- Init (DATA is loaded from data.js) ---

// Mutable working copy of the content. Re-render at any time via renderAll(state).
const state = structuredClone(DATA);

function renderAll(state) {
  renderMeta(state.meta);
  renderNav(state.nav);
  renderHero(state.hero);
  renderAbout(state.about);
  renderPersonalProjects(state.personalProjects);
  renderCourseProjects(state.courseProjects);
  const publicationsSection = document.querySelector(".publications");
  if (state.publications) {
    publicationsSection?.removeAttribute("hidden");
    renderPublications(state.publications);
  } else {
    publicationsSection?.setAttribute("hidden", "");
  }
  renderContact(state.contact);
}

renderAll(state);
initScrollEffects();
initFaceHover();
