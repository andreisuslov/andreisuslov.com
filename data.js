const DATA = {
  meta: {
    title: "Andrei Suslov",
    description: "Andrei Suslov — Software Development Engineer in Test. Test automation, CI/CD, and developer tooling.",
  },

  nav: {
    name: "Andrei Suslov",
    href: "/",
  },

  hero: {
    heading: "Hi, I'm Andrei",
    text: "A Software Development Engineer in Test in the Boston area. I build test automation, CI/CD pipelines, and developer tooling. Mostly I teach machines to do careful work at scale.",
    image: {
      alt: "Photo of Andrei Suslov",
    },
  },

  about: {
    summary: [
      { type: "text", value: "SDET at Avid Technology, previously QA automation at Liberty Mutual, and a Senior Airman in the U.S. Air Force Reserve. B.S. in Business Economics. Currently tinkering with:" },
    ],
    learning: [
      "Machine learning that turns scanned diaries into dynamic personal fonts",
      "Rust command-line tooling (connecto, qwen-tts, code-analyzer)",
      "Self-hosted services on a Mac mini home lab",
    ],
  },

  personalProjects: {
    heading: "Personal Projects",
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

  courseProjects: {
    heading: "Experience",
    items: [
      {
        name: "Avid Technology",
        course: "Software Development Engineer in Test · 2021 – present",
        description: "API, UI, and database test automation for media-production software used across the film and TV industry. Built a distributed Jenkins/Docker/Selenoid test infrastructure that cut runtimes by 25%, migrated 200+ freestyle Jenkins jobs to shared-library pipelines, and established the evaluation framework for a new AI transcription feature.",
        tags: ["Java", "Groovy", "TypeScript", "Jenkins", "Docker"],
      },
      {
        name: "Liberty Mutual",
        course: "QA Automation Engineer · 2018 – 2021",
        description: "Selenium, Cucumber, and Jasmine frameworks enabling 24/7 testing; cross-browser coverage via Sauce Labs; Rest Assured + MySQL data validation at 99.9% accuracy; standardized Jenkins pipelines across 15+ projects.",
        tags: ["Selenium", "Cucumber", "CI/CD"],
      },
      {
        name: "U.S. Air Force Reserve",
        course: "Senior Airman · 2025 – present",
        description: "Basic Military Training Honor Graduate and Best Wingman of the flight; Black Rope student leader at Keesler AFB; active DoD security clearance.",
        tags: ["Leadership", "Discipline"],
      },
    ],
  },

  contact: {
    heading: "Get in touch",
    text: "Up for interesting problems and good conversations about testing and tooling.",
    location: "Cambridge, MA",
    socials: [
      {
        name: "GitHub",
        url: "https://github.com/andreisuslov",
        icon: "github",
      },
      {
        name: "Email",
        url: "mailto:andrei.suslov.dev@gmail.com",
        icon: "mail",
      },
    ],
  },
};
