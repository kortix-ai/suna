# Technical Rules & Workflow

Project structure, local preview workflow, and quality checklist for website projects.

## Project Structure

Create in a project subfolder (paths relative to the working directory):

```
project-name/
├── index.html
├── base.css
├── style.css
├── app.js (if needed)
└── assets/
    └── (images, fonts)
```

## Technical Rules

- Static-first is preferred unless the task clearly needs a backend.
- Use relative paths for local assets.
- CDN libraries are fine for lightweight sites; use build tools only when they add real value.
- Avoid browser storage assumptions that break in restricted or embedded contexts.
- External links should open in a new tab.
- Keep all pages reachable from the main entry point.

## Workflow

### Step 1: Design Direction
Clarify purpose, audience, and art direction first.

### Step 2: Build
Build the site page by page and keep the files tidy.

### Step 3: Preview Locally
Use commands appropriate to the project:

```bash
# static site
python3 -m http.server 3000

# Vite / React / app server
npm install
npm run dev
```

Run long-lived commands with `pty_spawn`.

### Step 4: Verify
Use browser automation and screenshots to verify desktop, mobile, interaction states, and final polish.

### Step 5: Deliver
If the repo or product has a real deployment workflow, use that. Otherwise deliver the local files and a working local preview.

## Quality Checklist

- Real references gathered before designing
- SVG/logo treatment is intentional and consistent
- Desktop and mobile layouts verified
- Dark mode verified when implemented
- No overflow, truncation, placeholders, or broken states
- Accessibility basics covered
- Final output matches the intended art direction instead of defaulting to generic AI aesthetics
