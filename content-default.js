// Default homepage content — the block document that reproduces today's site.
//
// The homepage is a `{ version, blocks: [...] }` document. Each block has a
// stable `id`, a `type`, and typed fields (see script.js for the renderers).
// This file mirrors how data.js defines a global: it exposes DEFAULT_CONTENT so
// the public page always has something to render before /api/content responds.
// The admin console (built separately) edits this same shape and persists it as
// the server's content.json.
const DEFAULT_CONTENT = {
  version: 1,
  blocks: [
    {
      id: "portrait",
      type: "portrait",
      // width = rendered face width; offsetX = px the face sits left of the
      // content column. offsetX ≈ width + 2rem keeps the gutter tight.
      width: 102,
      offsetX: 134,
    },
    {
      id: "hero-heading",
      type: "heading",
      level: 1,
      text: "Hi, I'm Andrei",
    },
    {
      id: "hero-intro",
      type: "richtext",
      html: "A Software Development Engineer in Test in the Boston area. I build test automation, CI/CD pipelines, and developer tooling. Mostly I teach machines to do careful work at scale.",
    },
    {
      id: "about-summary",
      type: "richtext",
      html: "SDET at Avid Technology, previously QA automation at Liberty Mutual, and a Senior Airman in the U.S. Air Force Reserve. B.S. in Business Economics. Currently tinkering with:",
    },
    {
      id: "about-learning",
      type: "list",
      items: [
        "Machine learning that turns scanned diaries into dynamic personal fonts",
        "Rust command-line tooling (connecto, qwen-tts, code-analyzer)",
        "Self-hosted services on a Mac mini home lab",
      ],
    },
    {
      id: "personal-projects-heading",
      type: "heading",
      level: 2,
      text: "Personal Projects",
    },
    {
      id: "personal-projects",
      type: "projects",
      items: [
        {
          name: "connecto",
          description: "AirDrop-like SSH key pairing for your terminal. Pair two machines with a short code instead of copying public keys around.",
          github: "https://github.com/andreisuslov/connecto",
          tags: ["Rust", "CLI", "SSH"],
        },
        {
          name: "morning-dashboard",
          description: "A terminal dashboard for your morning routine: tasks, calendar, email, weather, GitHub notifications, and focus time. Configurable, with no dependencies.",
          github: "https://github.com/andreisuslov/morning-dashboard",
          tags: ["TypeScript", "CLI", "Productivity"],
        },
        {
          name: "qwen-tts",
          description: "Cross-platform CLI for Qwen3-TTS text-to-speech with voice cloning.",
          github: "https://github.com/andreisuslov/qwen-tts",
          tags: ["Rust", "AI", "Audio"],
        },
        {
          name: "code-analyzer",
          description: "Static code analyzer for Java with 987 SonarSource-based rules, built in Rust.",
          github: "https://github.com/andreisuslov/code-analyzer",
          tags: ["Rust", "Static Analysis", "Java"],
        },
        {
          name: "api-testing-framework",
          description: "Java API automation framework built with Rest Assured, covering full CRUD tests of a booking-management API.",
          github: "https://github.com/andreisuslov/api-testing-framework",
          tags: ["Java", "Rest Assured", "API Testing"],
        },
        {
          name: "cpu-simulator",
          description: "Visual simulation of a simple CPU: programmable RAM, a fetch-decode-execute cycle, and step-by-step execution on clock ticks.",
          github: "https://github.com/andreisuslov/cpu-simulator",
          tags: ["JavaScript", "Education"],
        },
      ],
    },
    {
      id: "experience-heading",
      type: "heading",
      level: 2,
      text: "Experience",
    },
    {
      id: "experience",
      type: "experience",
      items: [
        {
          name: "Avid Technology",
          subtitle: "Software Development Engineer in Test · 2021 – present",
          description: "API, UI, and database test automation for media-production software used across the film and TV industry. Built a distributed Jenkins/Docker/Selenoid test infrastructure that cut runtimes by 25%, migrated 200+ freestyle Jenkins jobs to shared-library pipelines, and established the evaluation framework for a new AI transcription feature.",
          tags: ["Java", "Groovy", "TypeScript", "Jenkins", "Docker"],
        },
        {
          name: "Liberty Mutual",
          subtitle: "QA Automation Engineer · 2018 – 2021",
          description: "Selenium, Cucumber, and Jasmine frameworks enabling 24/7 testing; cross-browser coverage via Sauce Labs; Rest Assured + MySQL data validation at 99.9% accuracy; standardized Jenkins pipelines across 15+ projects.",
          tags: ["Selenium", "Cucumber", "CI/CD"],
        },
        {
          name: "U.S. Air Force Reserve",
          subtitle: "Senior Airman · 2025 – present",
          description: "Basic Military Training Honor Graduate and Best Wingman of the flight; Black Rope student leader at Keesler AFB; active DoD security clearance.",
          tags: ["Leadership", "Discipline"],
        },
      ],
    },
    {
      id: "contact-heading",
      type: "heading",
      level: 2,
      text: "Get in touch",
    },
    {
      id: "contact-text",
      type: "richtext",
      html: "Up for interesting problems and good conversations about testing and tooling.",
    },
    {
      id: "contact-location",
      type: "richtext",
      html: "Cambridge, MA • Feb, 2026",
    },
    {
      id: "contact-socials",
      type: "socials",
      items: [
        { name: "GitHub", url: "https://github.com/andreisuslov", icon: "github" },
        { name: "Email", url: "mailto:andrei.suslov.dev@gmail.com", icon: "mail" },
      ],
    },
  ],
};
