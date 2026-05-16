export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kortix V0</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --rail: #10181c;
      --rail-2: #172329;
      --surface: #ffffff;
      --surface-2: #f8fafb;
      --surface-3: #eef3f5;
      --ink: #0f1618;
      --muted: #66757a;
      --line: #d9e2e5;
      --line-dark: rgba(255,255,255,.12);
      --accent: #0e7c66;
      --accent-2: #2563eb;
      --danger: #b42318;
      --warning: #9a6700;
      --ok: #067647;
      --shadow: 0 18px 50px rgba(15, 23, 42, .10);
      --radius: 8px;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background: var(--bg);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, textarea, select { font: inherit; }
    button {
      min-height: 34px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      padding: 0 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.secondary {
      color: var(--ink);
      background: var(--surface);
      border-color: var(--line);
    }
    button.ghost {
      color: var(--muted);
      background: transparent;
      border-color: transparent;
      padding: 0 8px;
    }
    button.tab {
      color: var(--muted);
      background: transparent;
      border-color: transparent;
      border-radius: 0;
      min-height: 44px;
      padding: 0 4px;
      border-bottom: 2px solid transparent;
    }
    button.tab.active {
      color: var(--ink);
      border-bottom-color: var(--accent);
    }
    button:disabled { opacity: .45; cursor: default; }
    input, textarea, select {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
      padding: 8px 10px;
      outline: none;
    }
    textarea { min-height: 96px; resize: vertical; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; min-width: 0; }
    a { color: var(--accent-2); text-decoration: none; font-weight: 650; }
    a:hover { text-decoration: underline; }
    h1, h2, h3, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 18px; line-height: 1.15; font-weight: 780; }
    h2 { font-size: 15px; font-weight: 760; }
    h3 { font-size: 13px; font-weight: 730; }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      grid-template-columns: minmax(0, 1fr);
    }
    .globalbar {
      min-height: 64px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 0 20px;
      background: rgba(244,246,248,.94);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(14px);
    }
    .globalbrand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .globalmark {
      width: 34px;
      height: 34px;
      border-radius: 7px;
      background: var(--ink);
      color: #fff;
      display: grid;
      place-items: center;
      font-weight: 780;
      letter-spacing: 0;
      flex: 0 0 auto;
    }
    .globalbrand small { color: var(--muted); display: block; margin-top: 3px; }
    .projects-page, .project-page { min-width: 0; }
    .hidden { display: none !important; }
    .projects-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 16px;
      margin-bottom: 16px;
    }
    .projects-hero h1 { font-size: 24px; }
    .projects-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 420px;
      gap: 16px;
      align-items: start;
    }
    .project-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 10px;
    }
    .project-card {
      min-height: 136px;
      align-content: space-between;
    }
    .mode-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .mode-card {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface-2);
      color: var(--ink);
      padding: 10px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      cursor: pointer;
      min-width: 0;
    }
    .mode-card input {
      width: auto;
      min-height: 0;
      margin: 2px 0 0;
    }
    .mode-card strong { display: block; font-size: 13px; }
    .mode-card span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .repo-inspection-empty {
      min-height: 120px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
    }
    .rail {
      background: var(--rail);
      color: #eef6f7;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      min-height: 100vh;
      border-right: 1px solid #0b1114;
    }
    .brand {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 16px;
      border-bottom: 1px solid var(--line-dark);
    }
    .brand small { color: #9fb0b6; display: block; margin-top: 3px; }
    .rail-body {
      padding: 14px;
      display: grid;
      gap: 14px;
      align-content: start;
      overflow: auto;
    }
    .rail-card {
      border: 1px solid var(--line-dark);
      background: var(--rail-2);
      border-radius: var(--radius);
      padding: 12px;
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .rail-card h2 { color: #fff; }
    .rail input, .rail textarea, .rail select {
      background: #0f181d;
      color: #eef6f7;
      border-color: rgba(255,255,255,.16);
    }
    .rail label { color: #aab8bd; }
    .rail .secondary {
      background: transparent;
      border-color: rgba(255,255,255,.20);
      color: #eef6f7;
    }
    .rail-foot {
      padding: 14px;
      border-top: 1px solid var(--line-dark);
    }
    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      min-height: 0;
    }
    .topbar {
      min-height: 64px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 0 20px;
      background: rgba(244,246,248,.92);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 5;
      backdrop-filter: blur(14px);
    }
    .project-page > .topbar { top: 64px; }
    .page {
      padding: 16px 20px 28px;
      overflow: auto;
      min-width: 0;
    }
    .page-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 16px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--surface);
      border-radius: var(--radius);
      box-shadow: 0 1px 0 rgba(15, 23, 42, .02);
      min-width: 0;
    }
    .panel-head {
      min-height: 50px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
    }
    .panel-body {
      padding: 14px;
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
    .cluster { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .stack { display: grid; gap: 10px; min-width: 0; }
    .muted { color: var(--muted); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .truncate { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 8px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      max-width: 100%;
    }
    .badge.ok { color: var(--ok); border-color: rgba(6, 118, 71, .22); background: #ecfdf3; }
    .badge.bad { color: var(--danger); border-color: rgba(180, 35, 24, .24); background: #fef3f2; }
    .badge.warn { color: var(--warning); border-color: rgba(154, 103, 0, .26); background: #fffaeb; }
    .list { display: grid; gap: 8px; min-width: 0; }
    .item {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--surface);
      border-radius: 7px;
      padding: 10px;
      display: grid;
      gap: 5px;
      text-align: left;
      color: var(--ink);
      min-width: 0;
      cursor: pointer;
    }
    .rail .item {
      background: #111d22;
      border-color: rgba(255,255,255,.12);
      color: #eef6f7;
    }
    .item:hover { border-color: #9fb5ba; }
    .item.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .item-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; font-weight: 720; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      background: var(--surface-2);
      border-radius: 7px;
      padding: 10px;
      min-width: 0;
    }
    .metric span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
    .metric strong { display: block; font-size: 14px; overflow-wrap: anywhere; }
    .tabs {
      display: flex;
      align-items: end;
      gap: 18px;
      min-height: 44px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .view { display: none; }
    .view.active { display: grid; gap: 16px; }
    .split {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .file-list, .session-list, .resource-list {
      max-height: calc(100vh - 260px);
      overflow: auto;
      padding-right: 2px;
    }
    .code-view {
      margin: 0;
      border: 1px solid #202829;
      background: #101415;
      color: #f4f7f7;
      border-radius: 7px;
      overflow: auto;
      min-height: 280px;
      max-height: calc(100vh - 260px);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
    }
    .code-line { display: grid; grid-template-columns: 46px minmax(0, 1fr); min-width: 0; }
    .code-line span {
      color: #819094;
      text-align: right;
      padding: 0 12px 0 6px;
      user-select: none;
      border-right: 1px solid rgba(255,255,255,.08);
    }
    .code-line code { white-space: pre; padding: 0 10px; min-width: 0; }
    pre.plain {
      margin: 0;
      background: #101415;
      color: #f4f7f7;
      border-radius: 7px;
      padding: 12px;
      overflow: auto;
      max-height: 42vh;
      min-height: 140px;
    }
    .session-card { border-left: 4px solid var(--line); }
    .session-card.running { border-left-color: var(--ok); }
    .session-card.provisioning, .session-card.branching { border-left-color: var(--warning); }
    .session-card.failed { border-left-color: var(--danger); }
    .chat-shell {
      display: grid;
      grid-template-rows: auto minmax(280px, 1fr) auto;
      min-height: calc(100vh - 230px);
    }
    .messages {
      display: grid;
      gap: 10px;
      align-content: start;
      max-height: calc(100vh - 420px);
      overflow: auto;
      padding-right: 2px;
    }
    .message {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface-2);
      padding: 10px;
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .message.assistant { border-color: rgba(14, 124, 102, .24); }
    .message.error { border-color: rgba(180, 35, 24, .24); background: #fef3f2; }
    .message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .live-frame {
      width: 100%;
      height: 360px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #0b0f10;
    }
    .statusbar {
      position: fixed;
      left: 16px;
      bottom: 16px;
      max-width: min(720px, calc(100vw - 32px));
      background: #101415;
      color: #f4f7f7;
      border-radius: 7px;
      padding: 9px 11px;
      box-shadow: var(--shadow);
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity .16s ease, transform .16s ease;
      z-index: 20;
    }
    .statusbar.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 1120px) {
      .app { grid-template-columns: 1fr; }
      .rail { min-height: 0; }
      .main { min-height: 0; }
      .page-grid, .split, .projects-grid { grid-template-columns: 1fr; }
      .statusbar { left: 16px; max-width: calc(100vw - 32px); }
    }
    @media (max-width: 720px) {
      .globalbar, .projects-hero { grid-template-columns: 1fr; padding: 12px; }
      .topbar { grid-template-columns: 1fr; padding: 12px; }
      .page { padding: 12px; }
      .project-card-grid, .mode-grid { grid-template-columns: 1fr; }
      .metric-grid { grid-template-columns: 1fr 1fr; }
      .tabs { gap: 10px; overflow: auto; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="globalbar">
      <div class="globalbrand">
        <div class="globalmark">K</div>
        <div>
          <h1>Kortix</h1>
          <small>Repo-native command center</small>
        </div>
      </div>
      <div class="cluster">
        <div class="cluster" id="badges"></div>
        <button class="secondary" id="refreshProjects" type="button">Refresh</button>
      </div>
    </header>

    <main class="main">
      <section class="page projects-page" id="projectsPage">
        <div class="projects-hero">
          <div class="stack" style="gap:6px">
            <h1>Projects</h1>
            <p class="muted">Select a repo-backed Kortix project or register a new one.</p>
          </div>
          <span class="badge" id="projectCount">0</span>
        </div>

        <div class="projects-grid">
          <section class="panel">
            <div class="panel-head">
              <h2>All Projects</h2>
              <button class="secondary" id="refreshProjectsList" type="button">Refresh</button>
            </div>
            <div class="panel-body">
              <div class="project-card-grid" id="projects"></div>
            </div>
          </section>

          <div class="stack">
            <form class="panel" id="projectForm">
              <div class="panel-head"><h2>New Project</h2></div>
              <div class="panel-body">
                <div class="mode-grid" role="radiogroup" aria-label="Project source">
                  <label class="mode-card">
                    <input type="radio" name="mode" value="existing" checked />
                    <span><strong>Select existing</strong><span>Register a repo that already exists.</span></span>
                  </label>
                  <label class="mode-card">
                    <input type="radio" name="mode" value="create" />
                    <span><strong>Create new</strong><span>Create a private GitHub repo for now.</span></span>
                  </label>
                </div>
                <label>Git repo <input name="repoUrl" placeholder="Any Git URL/path, or blank for private GitHub create" /></label>
                <label>Name <input name="name" placeholder="Optional project name" /></label>
                <div class="row">
                  <button class="secondary" type="button" id="inspectRepo">Inspect</button>
                  <button type="submit" id="projectSubmit">Continue</button>
                </div>
              </div>
            </form>

            <section class="panel">
              <div class="panel-head"><h2>Repo Preview</h2></div>
              <div class="panel-body" id="repoInspection">
                <div class="repo-inspection-empty">Inspect any Git repo before registering it.</div>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section class="project-page hidden" id="projectPage">
        <header class="topbar">
          <div class="cluster" style="flex-wrap:nowrap">
            <button class="secondary" id="backToProjects" type="button">Projects</button>
            <div class="stack" style="gap:4px; min-width:0">
              <h1 id="projectTitle">Select a project</h1>
              <div class="muted mono truncate" id="projectRepo"></div>
            </div>
          </div>
          <div class="cluster">
            <button class="secondary" id="reloadProject" type="button" disabled>Reload</button>
            <button id="quickSession" type="button" disabled>New Session</button>
          </div>
        </header>

        <section class="page">
        <nav class="tabs" aria-label="Project sections">
          <button class="tab active" data-page="overview" type="button">Overview</button>
          <button class="tab" data-page="sessions" type="button">Sessions</button>
          <button class="tab" data-page="files" type="button">Files</button>
          <button class="tab" data-page="resources" type="button">Agents</button>
          <button class="tab" data-page="secrets" type="button">Secrets</button>
        </nav>

        <div class="view active" id="view-overview">
          <section class="panel">
            <div class="panel-head">
              <h2>Project State</h2>
              <span class="muted mono" id="fileCount"></span>
            </div>
            <div class="panel-body">
              <div class="cluster" id="projectFacts"></div>
              <div class="metric-grid" id="overviewMetrics"></div>
            </div>
          </section>
          <div class="page-grid">
            <section class="panel">
              <div class="panel-head"><h2>Recent Sessions</h2><button class="secondary" data-jump="sessions" type="button">Open Sessions</button></div>
              <div class="panel-body"><div class="list" id="recentSessions"></div></div>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Manifest</h2></div>
              <div class="panel-body"><pre class="plain mono" id="manifest">Select a project.</pre></div>
            </section>
          </div>
        </div>

        <div class="view" id="view-sessions">
          <div class="page-grid">
            <div class="stack">
              <form class="panel" id="newSession">
                <div class="panel-head">
                  <h2>Start Session</h2>
                  <span class="muted mono" id="launchTimer"></span>
                </div>
                <div class="panel-body">
                  <label>Agent <select name="agentName" id="agentSelect" disabled></select></label>
                  <label>Prompt <textarea name="prompt" placeholder="Leave empty to open a blank live session."></textarea></label>
                  <div class="row">
                    <span class="muted">Branch + sandbox per run.</span>
                    <button id="runSession" type="submit" disabled>Start</button>
                  </div>
                </div>
              </form>
              <section class="panel">
                <div class="panel-head">
                  <h2>Session Runs</h2>
                  <button class="secondary" id="reloadSessions" type="button" disabled>Refresh</button>
                </div>
                <div class="panel-body"><div class="list session-list" id="sessions"></div></div>
              </section>
            </div>
            <section class="panel">
              <div class="panel-head">
                <h2 id="sessionTitle">Live Session</h2>
                <div class="cluster">
                  <button class="secondary" id="abortLive" type="button" disabled>Stop</button>
                  <button class="secondary" id="reloadLive" type="button" disabled>Reload</button>
                </div>
              </div>
              <div class="panel-body chat-shell" id="sessionDetail">
                <div class="muted">Select a session.</div>
              </div>
            </section>
          </div>
        </div>

        <div class="view" id="view-files">
          <div class="split">
            <section class="panel">
              <div class="panel-head"><h2>Files</h2><span class="muted mono" id="fileListCount"></span></div>
              <div class="panel-body">
                <input id="fileFilter" placeholder="Filter repo files" />
                <div class="list file-list" id="files"></div>
              </div>
            </section>
            <section class="panel">
              <div class="panel-head">
                <div class="stack" style="gap:2px">
                  <h2 id="fileTitle">File Preview</h2>
                  <span class="muted mono" id="fileMeta"></span>
                </div>
              </div>
              <div class="panel-body"><div class="code-view" id="fileContent"><div class="code-line"><span>1</span><code>Select a repo file.</code></div></div></div>
            </section>
          </div>
        </div>

        <div class="view" id="view-resources">
          <div class="page-grid">
            <section class="panel">
              <div class="panel-head"><h2>Agents</h2></div>
              <div class="panel-body"><div class="list resource-list" id="agents"></div></div>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Skills</h2></div>
              <div class="panel-body"><div class="list resource-list" id="skills"></div></div>
            </section>
          </div>
        </div>

        <div class="view" id="view-secrets">
          <div class="page-grid">
            <form class="panel" id="secretForm">
              <div class="panel-head">
                <h2>Secrets Manager</h2>
                <button class="secondary" id="reloadSecrets" type="button" disabled>Refresh</button>
              </div>
              <div class="panel-body">
                <label>Env key <input name="key" list="secretKeys" placeholder="ANTHROPIC_API_KEY" autocomplete="off" /></label>
                <datalist id="secretKeys">
                  <option value="ANTHROPIC_API_KEY"></option>
                  <option value="OPENAI_API_KEY"></option>
                  <option value="OPENROUTER_API_KEY"></option>
                  <option value="KORTIX_YOLO_API_KEY"></option>
                  <option value="KORTIX_YOLO_URL"></option>
                  <option value="KORTIX_TOKEN"></option>
                  <option value="KORTIX_API_URL"></option>
                </datalist>
                <label>Value <input name="value" type="password" autocomplete="off" placeholder="Injected into new sandboxes only" /></label>
                <button id="saveSecret" type="submit" disabled>Save Secret</button>
              </div>
            </form>
            <section class="panel">
              <div class="panel-head"><h2>Project Env</h2><span class="badge">sandbox launch</span></div>
              <div class="panel-body"><div class="list" id="secrets"></div></div>
            </section>
          </div>
        </div>
        </section>
      </section>
    </main>
  </div>

  <div class="statusbar" id="status"></div>

  <script>
    const state = {
      projects: [],
      selectedProject: null,
      inspectedRepo: null,
      files: [],
      agents: [],
      skills: [],
      env: { required: [], optional: [] },
      sessions: [],
      secrets: [],
      secretStatus: { required: [], optional: [], undeclared: [], missingRequired: [] },
      selectedSessionId: null,
      selectedSessionLive: null,
      page: "overview",
      sessionPoll: null,
      launchPoll: null,
    };

    const $ = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const shortId = (value) => value ? String(value).slice(0, 8) : "";
    const isActiveStatus = (status) => status === "branching" || status === "provisioning";
    const canChat = (session) => Boolean(session && session.sandboxUrl && session.opencodeSessionId && session.status !== "failed");
    const isLocalRepoUrl = (repoUrl) => repoUrl?.startsWith("/") || repoUrl?.startsWith("./") || repoUrl?.startsWith("../") || repoUrl?.startsWith("file:");

    function setStatus(text) {
      const node = $("status");
      node.textContent = text || "";
      node.classList.toggle("show", Boolean(text));
      if (text) window.clearTimeout(setStatus.timer);
      if (text) setStatus.timer = window.setTimeout(() => node.classList.remove("show"), 4600);
    }

    async function api(path, options) {
      const res = await fetch(path, options);
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(body?.error || body?.message || res.statusText);
      return body;
    }

    function badge(label, stateName) {
      return '<span class="badge ' + (stateName || "") + '">' + escapeHtml(label) + '</span>';
    }

    function msBetween(start, end) {
      const a = start ? new Date(start).getTime() : 0;
      const b = end ? new Date(end).getTime() : Date.now();
      if (!a || !b || b < a) return null;
      return b - a;
    }

    function formatDuration(ms) {
      if (ms === null || ms === undefined) return "-";
      if (ms < 1000) return Math.round(ms) + "ms";
      return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
    }

    function sessionLaunchTime(session) {
      if (isActiveStatus(session.status)) {
        return formatDuration(msBetween(session.createdAt, null));
      }
      return formatDuration(msBetween(session.createdAt, session.updatedAt));
    }

    function switchPage(page) {
      state.page = page;
      document.querySelectorAll("[data-page]").forEach((node) => node.classList.toggle("active", node.dataset.page === page));
      document.querySelectorAll(".view").forEach((node) => node.classList.remove("active"));
      $("view-" + page).classList.add("active");
      if (page === "sessions" && state.selectedSessionId) selectSession(state.selectedSessionId);
    }

    function showProjectsPage() {
      window.clearInterval(state.sessionPoll);
      state.sessionPoll = null;
      $("projectsPage").classList.remove("hidden");
      $("projectPage").classList.add("hidden");
      renderProjects();
    }

    function showProjectPage() {
      $("projectsPage").classList.add("hidden");
      $("projectPage").classList.remove("hidden");
    }

    function renderBadges(config) {
      $("badges").innerHTML = [
        badge("Git " + (config.repoTokenConfigured ? "ready" : "local")),
        badge("Daytona " + (config.daytonaConfigured ? "ready" : "missing"), config.daytonaConfigured ? "ok" : "bad"),
        badge(config.openCodeModel || "default model", config.openCodeModel ? "ok" : "warn"),
      ].join("");
    }

    function renderProjects() {
      $("projectCount").textContent = String(state.projects.length);
      $("projects").innerHTML = state.projects.length
        ? state.projects.map((p) => (
          '<button class="item project-card ' + (state.selectedProject?.id === p.id ? "active" : "") + '" data-project="' + escapeHtml(p.id) + '">' +
            '<span class="item-title"><span class="truncate">' + escapeHtml(p.name) + '</span><span class="muted mono">' + escapeHtml(p.defaultBranch) + '</span></span>' +
            '<span class="muted mono">' + escapeHtml(p.repoUrl) + '</span>' +
            '<span class="cluster">' + badge("Git source", "ok") + badge("Open", "") + '</span>' +
          '</button>'
        )).join("")
        : '<div class="repo-inspection-empty">No projects yet. Register an existing repo or initialize a new Kortix starter.</div>';
      document.querySelectorAll("[data-project]").forEach((el) => el.onclick = () => selectProject(el.dataset.project));
    }

    function renderRepoInspection(detail) {
      state.inspectedRepo = detail;
      const envCount = (detail.config.env?.required?.length || 0) + (detail.config.env?.optional?.length || 0);
      $("repoInspection").innerHTML =
        '<div class="stack">' +
          '<div class="cluster">' +
            badge(detail.isKortixRepo ? "Kortix repo" : "generic repo", detail.isKortixRepo ? "ok" : "warn") +
            badge("branch " + detail.defaultBranch, "ok") +
            badge(detail.config.hasOpenCodeConfig ? "opencode ready" : "opencode missing", detail.config.hasOpenCodeConfig ? "ok" : "bad") +
          '</div>' +
          '<div class="metric-grid" style="grid-template-columns: repeat(2, minmax(100px, 1fr))">' +
            '<div class="metric"><span>Files</span><strong>' + escapeHtml(detail.fileCount || 0) + '</strong></div>' +
            '<div class="metric"><span>Agents</span><strong>' + escapeHtml(detail.config.agents?.length || 0) + '</strong></div>' +
            '<div class="metric"><span>Skills</span><strong>' + escapeHtml(detail.config.skills?.length || 0) + '</strong></div>' +
            '<div class="metric"><span>Env keys</span><strong>' + escapeHtml(envCount) + '</strong></div>' +
          '</div>' +
          '<div class="stack" style="gap:5px"><div class="muted">Repo</div><div class="mono">' + escapeHtml(detail.repoUrl) + '</div></div>' +
          '<div class="row"><span class="muted">Register this repo when it looks right.</span><button type="button" id="registerInspectedRepo">Register</button></div>' +
        '</div>';
      $("registerInspectedRepo").onclick = () => $("projectForm").requestSubmit();
    }

    function selectedProjectMode() {
      return String(new FormData($("projectForm")).get("mode") || "existing");
    }

    function updateProjectFormMode() {
      const mode = selectedProjectMode();
      const repo = $("projectForm").elements.namedItem("repoUrl");
      const name = $("projectForm").elements.namedItem("name");
      const submit = $("projectSubmit");
      repo.placeholder = mode === "create"
        ? "Blank for private GitHub repo, or paste an empty repo URL"
        : "https://github.com/org/repo.git, git@host:org/repo.git, or /path/repo.git";
      name.placeholder = mode === "create" ? "Project name" : "Optional project name";
      submit.textContent = mode === "create" ? "Create GitHub Project" : "Connect Repo";
    }

    function renderAgentSelect(defaultAgent) {
      const agents = state.agents || [];
      const selected = defaultAgent || agents[0]?.name || "default";
      $("agentSelect").disabled = !state.selectedProject;
      $("agentSelect").innerHTML = agents.length
        ? agents.map((agent) => '<option value="' + escapeHtml(agent.name) + '"' + (agent.name === selected ? " selected" : "") + '>' + escapeHtml(agent.name) + '</option>').join("")
        : '<option value="default">OpenCode default</option>';
    }

    function renderOverview() {
      const p = state.selectedProject;
      const active = state.sessions.filter((session) => session.status === "running" || isActiveStatus(session.status)).length;
      const missingSecrets = state.secretStatus?.missingRequired?.length || 0;
      $("overviewMetrics").innerHTML = [
        ['Files', state.files.length],
        ['Agents', state.agents.length],
        ['Skills', state.skills.length],
        ['Missing secrets', missingSecrets],
        ['Active sessions', active],
      ].map((metric) => '<div class="metric"><span>' + escapeHtml(metric[0]) + '</span><strong>' + escapeHtml(metric[1]) + '</strong></div>').join("");
      $("recentSessions").innerHTML = state.sessions.length
        ? state.sessions.slice(0, 5).map(sessionCardHtml).join("")
        : '<div class="muted">No sessions yet.</div>';
      document.querySelectorAll("#recentSessions [data-session]").forEach((el) => el.onclick = () => { switchPage("sessions"); selectSession(el.dataset.session); });
      if (!p) $("manifest").textContent = "Select a project.";
    }

    function renderResources() {
      $("agents").innerHTML = state.agents.length
        ? state.agents.map((agent) => (
          '<button class="item" data-file="' + escapeHtml(agent.path) + '">' +
            '<span class="item-title"><span class="truncate">' + escapeHtml(agent.name) + '</span><span class="muted mono">' + escapeHtml(agent.mode || "agent") + '</span></span>' +
            '<span class="muted">' + escapeHtml(agent.description || agent.path) + '</span>' +
          '</button>'
        )).join("")
        : '<div class="muted">No agents found.</div>';
      $("skills").innerHTML = state.skills.length
        ? state.skills.map((skill) => (
          '<button class="item" data-file="' + escapeHtml(skill.path) + '">' +
            '<span class="item-title"><span class="truncate">' + escapeHtml(skill.name) + '</span><span class="muted mono">skill</span></span>' +
            '<span class="muted mono">' + escapeHtml(skill.path) + '</span>' +
          '</button>'
        )).join("")
        : '<div class="muted">No skills found.</div>';
      document.querySelectorAll("#agents [data-file], #skills [data-file]").forEach((el) => el.onclick = () => { switchPage("files"); openFile(el.dataset.file); });
    }

    function renderProject(detail) {
      const p = detail.project;
      state.selectedProject = p;
      state.inspectedRepo = null;
      state.agents = detail.config.agents || [];
      state.skills = detail.config.skills || [];
      state.env = detail.config.env || { required: [], optional: [] };
      $("projectTitle").textContent = p.name;
      $("projectRepo").textContent = p.repoUrl;
      $("reloadProject").disabled = false;
      $("quickSession").disabled = isLocalRepoUrl(p.repoUrl);
      $("runSession").disabled = isLocalRepoUrl(p.repoUrl);
      $("reloadSessions").disabled = false;
      $("reloadSecrets").disabled = false;
      $("saveSecret").disabled = false;
      $("projectFacts").innerHTML = [
        badge(detail.config.isKortixRepo ? "Kortix repo" : "generic repo", detail.config.isKortixRepo ? "ok" : "warn"),
        badge("branch " + p.defaultBranch, "ok"),
        badge(detail.config.hasOpenCodeConfig ? "opencode ready" : "opencode missing", detail.config.hasOpenCodeConfig ? "ok" : "bad"),
        badge(detail.config.agents?.length ? "custom agents" : "opencode default", "ok"),
        badge(isLocalRepoUrl(p.repoUrl) ? "local git only" : "sandbox cloneable", isLocalRepoUrl(p.repoUrl) ? "warn" : "ok"),
        badge((state.env.required.length + state.env.optional.length) + " env keys", state.env.required.length ? "warn" : ""),
      ].join("");
      $("manifest").textContent = detail.config.manifestRaw || "kortix.toml not found.";
      $("fileCount").textContent = String(detail.fileCount || 0) + " files";
      $("newSession").querySelector(".row .muted").textContent = isLocalRepoUrl(p.repoUrl)
        ? "Push to a reachable Git remote before launching Daytona."
        : "Branch + sandbox per run.";
      renderAgentSelect(detail.config.openCodeDefaultAgent);
      renderResources();
    }

    function renderInspection(detail) {
      state.selectedProject = null;
      state.inspectedRepo = detail;
      state.files = detail.files || [];
      state.agents = detail.config.agents || [];
      state.skills = detail.config.skills || [];
      state.env = detail.config.env || { required: [], optional: [] };
      state.sessions = [];
      state.secrets = [];
      state.secretStatus = { required: [], optional: [], undeclared: [], missingRequired: [] };
      state.selectedSessionId = null;
      $("projectTitle").textContent = detail.isKortixRepo ? "Readable Kortix repo" : "Readable generic repo";
      $("projectRepo").textContent = detail.repoUrl;
      $("reloadProject").disabled = true;
      $("quickSession").disabled = true;
      $("runSession").disabled = true;
      $("reloadSessions").disabled = true;
      $("reloadSecrets").disabled = true;
      $("saveSecret").disabled = true;
      $("projectFacts").innerHTML = [
        badge(detail.isKortixRepo ? "Kortix repo" : "generic repo", detail.isKortixRepo ? "ok" : "warn"),
        badge("branch " + detail.defaultBranch, "ok"),
        badge(detail.config.hasOpenCodeConfig ? "opencode ready" : "opencode missing", detail.config.hasOpenCodeConfig ? "ok" : "bad"),
        badge(detail.config.agents?.length ? "custom agents" : "opencode default", "ok"),
        badge((state.env.required.length + state.env.optional.length) + " env keys", state.env.required.length ? "warn" : ""),
      ].join("");
      $("manifest").textContent = detail.config.manifestRaw || "kortix.toml not found.";
      $("fileCount").textContent = String(detail.fileCount || 0) + " files";
      renderAgentSelect(detail.config.openCodeDefaultAgent);
      renderFiles();
      renderResources();
      renderSessions();
      renderSecrets();
      renderOverview();
      renderSessionDetail(null);
    }

    function filteredFiles() {
      const query = $("fileFilter").value.trim().toLowerCase();
      if (!query) return state.files;
      return state.files.filter((file) => file.path.toLowerCase().includes(query));
    }

    function renderFiles() {
      const files = filteredFiles();
      $("fileListCount").textContent = String(files.length);
      $("files").innerHTML = files.length
        ? files.map((file) => (
          '<button class="item" data-file="' + escapeHtml(file.path) + '">' +
            '<span class="item-title"><span class="mono truncate">' + escapeHtml(file.path) + '</span></span>' +
          '</button>'
        )).join("")
        : '<div class="muted">No files.</div>';
      document.querySelectorAll("#files [data-file]").forEach((el) => el.onclick = () => openFile(el.dataset.file));
      $("fileListCount").textContent = String(files.length) + " files";
    }

    function renderCode(content) {
      const lines = String(content || "").split("\\n");
      $("fileContent").innerHTML = lines.map((line, index) => (
        '<div class="code-line"><span>' + (index + 1) + '</span><code>' + (escapeHtml(line) || " ") + '</code></div>'
      )).join("");
    }

    function sessionCardHtml(s) {
      return '<button class="item session-card ' + escapeHtml(s.status) + ' ' + (state.selectedSessionId === s.id ? "active" : "") + '" data-session="' + escapeHtml(s.id) + '">' +
        '<span class="item-title"><span>' + escapeHtml(s.status) + '</span><span class="muted mono">' + escapeHtml(sessionLaunchTime(s)) + '</span></span>' +
        '<span class="muted mono">agent ' + escapeHtml(s.agentName || "default") + '</span>' +
        '<span class="mono">' + escapeHtml(s.branchName) + '</span>' +
        '<span class="muted mono">' + escapeHtml(s.sandboxId ? ("sandbox " + shortId(s.sandboxId)) : "sandbox pending") + '</span>' +
        (s.error ? '<span class="muted mono">' + escapeHtml(s.error) + '</span>' : '') +
      '</button>';
    }

    function renderSessions() {
      $("sessions").innerHTML = state.sessions.length
        ? state.sessions.map(sessionCardHtml).join("")
        : '<div class="muted">No sessions yet.</div>';
      document.querySelectorAll("#sessions [data-session]").forEach((el) => el.onclick = () => selectSession(el.dataset.session));
      renderOverview();
    }

    function secretStatusRow(entry, label) {
      const setLabel = entry.set ? "set" : "missing";
      const stateName = entry.set ? "ok" : (entry.required ? "bad" : "warn");
      return '<div class="item">' +
        '<span class="item-title"><span class="mono">' + escapeHtml(entry.key) + '</span>' + badge(setLabel, stateName) + '</span>' +
        '<span class="muted">' + escapeHtml(label) + (entry.updatedAt ? " - updated " + escapeHtml(new Date(entry.updatedAt).toLocaleString()) : "") + '</span>' +
        '<div class="cluster">' +
          '<button class="secondary" type="button" data-secret-fill="' + escapeHtml(entry.key) + '">' + (entry.set ? "Update" : "Set") + '</button>' +
          (entry.set ? '<button class="ghost" type="button" data-secret-delete="' + escapeHtml(entry.key) + '">Delete</button>' : '') +
        '</div>' +
      '</div>';
    }

    function renderSecretDatalist() {
      const keys = new Set([
        ...state.env.required,
        ...state.env.optional,
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "KORTIX_YOLO_API_KEY",
        "KORTIX_YOLO_URL",
        "KORTIX_TOKEN",
        "KORTIX_API_URL",
      ]);
      $("secretKeys").innerHTML = Array.from(keys).sort().map((key) => '<option value="' + escapeHtml(key) + '"></option>').join("");
    }

    function renderSecrets() {
      renderSecretDatalist();
      if (!state.selectedProject) {
        $("secrets").innerHTML = '<div class="muted">Select a project.</div>';
        return;
      }
      const status = state.secretStatus || { required: [], optional: [], undeclared: [], missingRequired: [] };
      const sections = [];
      if (status.required.length) {
        sections.push('<div class="stack"><h3>Required</h3>' + status.required.map((entry) => secretStatusRow(entry, "declared in kortix.toml")).join("") + '</div>');
      }
      if (status.optional.length) {
        sections.push('<div class="stack"><h3>Optional</h3>' + status.optional.map((entry) => secretStatusRow(entry, "declared in kortix.toml")).join("") + '</div>');
      }
      if (status.undeclared.length) {
        sections.push('<div class="stack"><h3>Undeclared</h3>' + status.undeclared.map((entry) => secretStatusRow(entry, "stored in vault only")).join("") + '</div>');
      }
      $("secrets").innerHTML = sections.length
        ? sections.join("")
        : '<div class="muted">No declared env keys or stored project secrets yet.</div>';
      document.querySelectorAll("[data-secret-fill]").forEach((el) => {
        el.onclick = () => {
          $("secretForm").elements.namedItem("key").value = el.dataset.secretFill;
          $("secretForm").elements.namedItem("value").focus();
        };
      });
      document.querySelectorAll("[data-secret-delete]").forEach((el) => {
        el.onclick = async () => {
          if (!state.selectedProject) return;
          const key = el.dataset.secretDelete;
          await api("/api/projects/" + encodeURIComponent(state.selectedProject.id) + "/secrets/" + encodeURIComponent(key), { method: "DELETE" });
          await loadSecrets();
          setStatus("Deleted " + key + ".");
        };
      });
    }

    function messageHtml(message) {
      const cls = message.error ? "message error" : "message " + escapeHtml(message.role || "");
      const label = [message.role || "message", message.providerID && message.modelID ? (message.providerID + "/" + message.modelID) : null].filter(Boolean).join(" - ");
      const text = message.error || message.text || (message.completed ? "" : "Running...");
      return '<div class="' + cls + '">' +
        '<div class="row"><strong>' + escapeHtml(label) + '</strong>' + (message.completed ? badge("complete", "ok") : badge("live", "warn")) + '</div>' +
        '<div class="message-text mono">' + escapeHtml(text || "No text.") + '</div>' +
      '</div>';
    }

    function renderSessionDetail(detail) {
      if (!detail) {
        $("sessionTitle").textContent = "Live Session";
        $("sessionDetail").innerHTML = '<div class="muted">Select a session.</div>';
        $("reloadLive").disabled = true;
        $("abortLive").disabled = true;
        return;
      }

      const s = detail.session;
      const live = detail.live || {};
      const messages = live.messages || [];
      $("sessionTitle").textContent = "Session " + shortId(s.id);
      $("reloadLive").disabled = false;
      $("abortLive").disabled = !canChat(s);
      $("sessionDetail").innerHTML =
        '<div class="stack">' +
          '<div class="metric-grid" style="grid-template-columns: repeat(3, minmax(100px, 1fr))">' +
            '<div class="metric"><span>Status</span><strong>' + escapeHtml(s.status) + '</strong></div>' +
            '<div class="metric"><span>Launch</span><strong>' + escapeHtml(sessionLaunchTime(s)) + '</strong></div>' +
            '<div class="metric"><span>Agent</span><strong>' + escapeHtml(s.agentName || "default") + '</strong></div>' +
            '<div class="metric"><span>Sandbox</span><strong>' + escapeHtml(s.sandboxId ? shortId(s.sandboxId) : "pending") + '</strong></div>' +
            '<div class="metric"><span>OpenCode</span><strong>' + escapeHtml(s.opencodeSessionId ? shortId(s.opencodeSessionId) : "pending") + '</strong></div>' +
            '<div class="metric"><span>Base</span><strong>' + escapeHtml(s.baseRef) + '</strong></div>' +
          '</div>' +
          '<div class="stack" style="gap:5px"><div class="muted">Branch</div><div class="mono">' + escapeHtml(s.branchName) + '</div></div>' +
          (s.error ? '<div class="message error"><strong>Error</strong><div class="message-text mono">' + escapeHtml(s.error) + '</div></div>' : '') +
          '<div class="cluster">' +
            (s.sandboxUrl ? '<a href="' + escapeHtml(s.sandboxUrl) + '" target="_blank" rel="noreferrer">Open OpenCode</a>' : '<span class="muted">OpenCode link pending</span>') +
            (live.reachable ? badge("live reachable", "ok") : badge(live.error || "live pending", s.status === "failed" ? "bad" : "warn")) +
          '</div>' +
        '</div>' +
        '<div class="messages" id="messageList">' +
          (messages.length ? messages.map(messageHtml).join("") : '<div class="muted">No messages loaded yet.</div>') +
        '</div>' +
        '<form class="stack" id="chatForm">' +
          '<label>Message <textarea name="prompt" placeholder="' + (canChat(s) ? "Send the next prompt to this sandbox session." : "OpenCode is not ready yet.") + '"' + (canChat(s) ? "" : " disabled") + '></textarea></label>' +
          '<div class="row"><span class="muted mono">' + escapeHtml(s.sandboxUrl || "sandbox pending") + '</span><button type="submit"' + (canChat(s) ? "" : " disabled") + '>Send</button></div>' +
        '</form>' +
        '<details><summary class="muted">Diff</summary><pre class="plain mono">' + escapeHtml(detail.changes?.text || "No changes.") + '</pre></details>';
      const chatForm = $("chatForm");
      if (chatForm) chatForm.onsubmit = sendChatMessage;
      const list = $("messageList");
      if (list) list.scrollTop = list.scrollHeight;
    }

    async function loadConfig() {
      renderBadges(await api("/api/config"));
    }

    async function loadProjects() {
      state.projects = await api("/api/projects");
      renderProjects();
    }

    async function selectProject(id) {
      setStatus("Loading project from git...");
      window.clearInterval(state.sessionPoll);
      state.selectedSessionId = null;
      state.selectedSessionLive = null;
      try {
        const detail = await api("/api/projects/" + encodeURIComponent(id));
        renderProject(detail);
        showProjectPage();
        renderProjects();
        state.files = await api("/api/projects/" + encodeURIComponent(id) + "/files");
        renderFiles();
        await loadSecrets();
        await loadSessions(true);
        renderOverview();
        setStatus("");
      } catch (err) {
        setStatus(err.message);
      }
    }

    async function openFile(path) {
      if (!state.selectedProject && !state.inspectedRepo) return;
      setStatus("Reading " + path + " from git...");
      try {
        const file = state.selectedProject
          ? await api("/api/projects/" + encodeURIComponent(state.selectedProject.id) + "/files/content?path=" + encodeURIComponent(path))
          : await api("/api/repos/file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoUrl: state.inspectedRepo.repoUrl, ref: state.inspectedRepo.defaultBranch, path }),
          });
        $("fileTitle").textContent = path;
        $("fileMeta").textContent = file.ref;
        renderCode(file.content);
        setStatus("");
      } catch (err) {
        setStatus(err.message);
      }
    }

    async function loadSessions(selectLatest) {
      if (!state.selectedProject) return;
      state.sessions = await api("/api/projects/" + encodeURIComponent(state.selectedProject.id) + "/sessions");
      renderSessions();
      if (selectLatest && state.sessions.length) {
        await selectSession(state.sessions[0].id);
      } else if (state.selectedSessionId) {
        const stillExists = state.sessions.some((session) => session.id === state.selectedSessionId);
        if (stillExists) renderSessions();
      }
    }

    async function loadSecrets() {
      if (!state.selectedProject) {
        state.secrets = [];
        state.secretStatus = { required: [], optional: [], undeclared: [], missingRequired: [] };
        renderSecrets();
        return;
      }
      const projectId = encodeURIComponent(state.selectedProject.id);
      const [secrets, status] = await Promise.all([
        api("/api/projects/" + projectId + "/secrets"),
        api("/api/projects/" + projectId + "/secrets/status"),
      ]);
      state.secrets = secrets;
      state.secretStatus = status;
      renderSecrets();
      renderOverview();
    }

    async function loadSessionLive(id) {
      const detail = await api("/api/sessions/" + encodeURIComponent(id) + "/live");
      state.selectedSessionLive = detail;
      state.selectedSessionId = detail.session.id;
      state.sessions = state.sessions.map((session) => session.id === detail.session.id ? detail.session : session);
      renderSessions();
      renderSessionDetail(detail);
      return detail;
    }

    async function selectSession(id) {
      if (!id) return;
      state.selectedSessionId = id;
      renderSessions();
      window.clearInterval(state.sessionPoll);
      try {
        const detail = await loadSessionLive(id);
        if (isActiveStatus(detail.session.status) || detail.session.status === "running") {
          state.sessionPoll = window.setInterval(async () => {
            if (!state.selectedSessionId) return;
            try {
              const next = await loadSessionLive(state.selectedSessionId);
              if (next.session.status === "failed") window.clearInterval(state.sessionPoll);
            } catch {}
          }, 3000);
        }
      } catch (err) {
        setStatus(err.message);
      }
    }

    async function submitProject(payload) {
      const result = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await loadProjects();
      await selectProject(result.id || result.project?.id);
      switchPage("overview");
    }

    function watchLaunch(sessionId, startMs) {
      window.clearInterval(state.launchPoll);
      state.launchPoll = window.setInterval(() => {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) return;
        const elapsed = performance.now() - startMs;
        $("launchTimer").textContent = isActiveStatus(session.status)
          ? "starting " + formatDuration(elapsed)
          : session.status + " in " + formatDuration(elapsed);
        if (!isActiveStatus(session.status)) {
          window.clearInterval(state.launchPoll);
          window.setTimeout(() => { $("launchTimer").textContent = ""; }, 6000);
        }
      }, 500);
    }

    async function sendChatMessage(event) {
      event.preventDefault();
      if (!state.selectedSessionId) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      const prompt = String(data.get("prompt") || "").trim();
      if (!prompt) return;
      const button = form.querySelector("button");
      button.disabled = true;
      setStatus("Sending prompt to session...");
      try {
        const detail = await api("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, agentName: state.selectedSessionLive?.session?.agentName }),
        });
        form.reset();
        state.selectedSessionLive = detail;
        renderSessionDetail(detail);
        setStatus("Prompt sent.");
      } catch (err) {
        setStatus(err.message);
      } finally {
        button.disabled = false;
      }
    }

    document.querySelectorAll("[data-page]").forEach((el) => el.onclick = () => switchPage(el.dataset.page));
    document.querySelectorAll("[data-jump]").forEach((el) => el.onclick = () => switchPage(el.dataset.jump));
    $("refreshProjects").onclick = () => loadProjects();
    $("refreshProjectsList").onclick = () => loadProjects();
    $("backToProjects").onclick = () => showProjectsPage();
    $("reloadProject").onclick = () => state.selectedProject && selectProject(state.selectedProject.id);
    $("quickSession").onclick = () => { showProjectPage(); switchPage("sessions"); };
    $("reloadSessions").onclick = () => loadSessions(false);
    $("reloadLive").onclick = () => state.selectedSessionId && selectSession(state.selectedSessionId);
    $("abortLive").onclick = async () => {
      if (!state.selectedSessionId) return;
      $("abortLive").disabled = true;
      setStatus("Stopping live run...");
      try {
        const detail = await api("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/abort", { method: "POST" });
        state.selectedSessionLive = detail;
        renderSessionDetail(detail);
        setStatus("Stopped.");
      } catch (err) {
        setStatus(err.message);
      }
    };
    $("reloadSecrets").onclick = () => loadSecrets();
    $("fileFilter").oninput = () => renderFiles();
    document.querySelectorAll("input[name='mode']").forEach((el) => el.onchange = updateProjectFormMode);

    $("inspectRepo").onclick = async () => {
      const data = new FormData($("projectForm"));
      const repoUrl = String(data.get("repoUrl") || "").trim();
      if (!repoUrl) {
        setStatus("Paste a Git repo URL/path to inspect.");
        return;
      }
      setStatus("Inspecting repo from git...");
      try {
        const detail = await api("/api/repos/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl }),
        });
        renderRepoInspection(detail);
        setStatus(detail.isKortixRepo ? "Repo is Kortix-shaped." : "Repo is readable.");
      } catch (err) {
        setStatus(err.message);
      }
    };

    $("projectForm").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const mode = String(data.get("mode") || "existing");
      const repoUrl = String(data.get("repoUrl") || "").trim();
      const name = String(data.get("name") || "").trim();
      if (mode === "existing" && !repoUrl) {
        setStatus("Existing projects need a Git repo URL/path.");
        return;
      }
      setStatus(mode === "create" ? "Creating project..." : "Registering project...");
      try {
        await submitProject({
          name: name || undefined,
          repoUrl: repoUrl || undefined,
          initialize: mode === "create" && Boolean(repoUrl),
          managed: mode === "create" && !repoUrl,
        });
        form.reset();
        updateProjectFormMode();
        setStatus("");
      } catch (err) {
        setStatus(err.message);
      }
    };

    $("secretForm").onsubmit = async (event) => {
      event.preventDefault();
      if (!state.selectedProject) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      setStatus("Saving secret...");
      try {
        await api("/api/projects/" + encodeURIComponent(state.selectedProject.id) + "/secrets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: data.get("key"), value: data.get("value") }),
        });
        form.reset();
        await loadSecrets();
        setStatus("Secret saved.");
      } catch (err) {
        setStatus(err.message);
      }
    };

    $("newSession").onsubmit = async (event) => {
      event.preventDefault();
      if (!state.selectedProject) return;
      const data = new FormData(event.currentTarget);
      const started = performance.now();
      $("runSession").disabled = true;
      $("launchTimer").textContent = "starting 0ms";
      setStatus("Creating branch and Daytona sandbox...");
      try {
        const session = await api("/api/projects/" + encodeURIComponent(state.selectedProject.id) + "/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: data.get("agentName"), prompt: data.get("prompt") }),
        });
        const apiMs = performance.now() - started;
        state.sessions = [session, ...state.sessions.filter((item) => item.id !== session.id)];
        renderSessions();
        setStatus("Queued in " + formatDuration(apiMs) + ".");
        watchLaunch(session.id, started);
        await selectSession(session.id);
      } catch (err) {
        setStatus(err.message);
        $("launchTimer").textContent = "";
      } finally {
        $("runSession").disabled = false;
      }
    };

    updateProjectFormMode();
    Promise.all([loadConfig(), loadProjects()]).catch((err) => setStatus(err.message));
  </script>
</body>
</html>`;
}
