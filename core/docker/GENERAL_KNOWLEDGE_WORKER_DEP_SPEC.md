# OpenCode skills dependency spec

Audit scope:
- every folder under `core/kortix-master/opencode/skills/GENERAL-KNOWLEDGE-WORKER/`
- every folder under `core/kortix-master/opencode/skills/KORTIX-system/`

Method used:
- walked the full skill tree (64 skills)
- scanned each `SKILL.md` plus shipped scripts/templates
- extracted explicit CLI/package references and code imports
- separated **bake into image** deps from **external API/env** deps and **project-local/app deps**

KORTIX-system note:
- some dependencies are intentionally **host-only** and cannot be meaningfully baked into this Linux container (for example Xcode, macOS accessibility tooling, or local-machine `agent-click` installs performed over Agent Tunnel)
- those are still captured below so they are not missed, but they are classified as host-only rather than image deps

## Aggregate runtime set implied by the full folder

### Base CLI/runtime tools to have in the image
- `bash`
- `bun`
- `node`, `npm`
- `python3`, `pip`, `uv`
- `git`
- `gh`
- `jq`
- `curl`
- `ripgrep`
- `docker` CLI
- `rsync`
- `unzip`, `zip`
- `whois`

### Document / office / PDF stack
- `pandoc`
- `libreoffice` / `soffice`
- `poppler-utils` (`pdftotext`, `pdftoppm`, `pdfimages`)
- `qpdf`
- `tesseract-ocr`
- `imagemagick` (`magick`, `convert`)
- `texlive` + `bibtex`/LaTeX toolchain

### Browser / media stack
- `chromium`
- `playwright` (Python + Node consumers exist)
- `ffmpeg`
- `ffprobe`

### Python packages directly referenced by skills/scripts
- `pypdf`
- `pdfplumber`
- `reportlab`
- `pypdfium2`
- `PyPDF2`
- `pdf2image`
- `pytesseract`
- `PyMuPDF`
- `openpyxl`
- `python-pptx`
- `python-docx`
- `lxml`
- `Pillow`
- `pdf2docx`
- `docx2pdf`
- `markitdown[pptx]`
- `numpy`
- `pandas`
- `matplotlib`
- `seaborn`
- `playwright`
- `youtube-transcript-api`
- `rembg`
- `onnxruntime`
- `fastapi[standard]` *(needed if this image should truly satisfy `fastapi-sdk` out of the box)*

### Node packages directly referenced by skills/tests or called out as preinstalled
- `pptxgenjs`
- `docx`
- `pdf-lib`
- `playwright`
- `react`
- `react-dom`
- `react-icons`
- `sharp`

### Strongly recommended font/runtime extras
- `fontconfig`
- broad Latin fonts (e.g. DejaVu / Liberation)
- Noto CJK fonts for PDF/report generation notes that explicitly mention CJK fallback
- Noto Emoji only if the image/browser stack needs consistent emoji rendering

### Host-only / non-container requirements discovered in KORTIX-system
- `agent-click` on the **user's macOS machine** via Agent Tunnel
- `Appium` for iOS automation flows
- `Xcode` / iOS simulator tooling for iOS browser automation

## Skill-by-skill walkthrough

Legend:
- **Bake** = package/CLI should exist in the image
- **Env** = API key / external credential only
- **Project-local** = dependency belongs in the generated app/project, not necessarily globally in the base image

| Skill | Bake into image | Env / external | Notes |
|---|---|---|---|
| account-research | none beyond core web/search tools | none | research workflow only |
| audit-support | none | none | knowledge-only |
| brand-voice | none | none | knowledge-only |
| call-prep | none | none | knowledge-only |
| campaign-planning | none | none | knowledge-only |
| canned-responses | none | none | knowledge-only |
| close-management | none | none | knowledge-only |
| coding-and-data | `git`, `gh`, `docker` CLI | connector-specific if used | PR/repo guidance explicitly mentions GitHub CLI |
| competitive-analysis | none | none | knowledge-only |
| competitive-intelligence | none at base-image level | maybe connector/web data | output artifact skill, but no shipped local runtime deps in folder |
| compliance | none | none | knowledge-only |
| content-creation | none | none | knowledge-only |
| contract-review | none | none | knowledge-only |
| create-an-asset | `node` | none | docs mention node-based asset generation; no extra global pkg declared here |
| customer-research | none beyond core web/search tools | none | research workflow only |
| daily-briefing | none | none | knowledge-only |
| deep-research | `curl` helpful | none | mostly research/process |
| design-foundations | fonts matter; no hard package requirement | none | recommends Fontshare/Google Fonts usage |
| document-review | `python3`, `PyMuPDF`, `openpyxl`, `python-pptx`, `python-docx`, `lxml` | web search sources | annotation scripts and DOCX XML workflow |
| docx | `pandoc`, `soffice`, `pdftoppm`, `pdf2docx`, Node `docx`, Python `lxml`, `docx2pdf` | none | explicitly says these tools are pre-installed |
| domain-research | `whois`, `python3` | none | RDAP + whois fallback |
| draft-outreach | none beyond core web/search tools | none | research + writing |
| elevenlabs | none beyond `python3` stdlib runner | `ELEVENLABS_API_KEY` | skill says stdlib only, no pip deps needed |
| escalation | none | none | knowledge-only |
| exploration | none | none | methodology only |
| fastapi-sdk | `fastapi` CLI / `fastapi[standard]` | none | skill explicitly says to use `fastapi dev` / `fastapi run` |
| feature-spec | none | none | knowledge-only |
| financial-statements | none | none | knowledge-only |
| hyper-fast-youtube-transcript | `youtube-transcript-api` | none | transcript workflow |
| journal-entry-prep | none | none | knowledge-only |
| knowledge-management | none | none | knowledge-only |
| legal-writer | `python-docx`, `docx2pdf`, `libreoffice` | optional `COURTLISTENER_API_TOKEN` | DOCX/PDF output and legal verification |
| logo-creator | `playwright`, `Pillow`, `numpy`, `rembg`, `onnxruntime` | `REPLICATE_API_TOKEN` optional path | local scripts for composition and background removal |
| media | media CLIs provided by runtime; `ffmpeg` useful baseline | model billing creds via media commands | skill itself is CLI-wrapper oriented |
| meeting-briefing | none | none | knowledge-only |
| metrics-tracking | none | none | knowledge-only |
| nda-triage | none | none | knowledge-only |
| openalex-paper-search | none at base-image level | none | OpenAlex is remote API usage |
| paper-creator | `pdflatex`, `bibtex`, TeX packages, `python3` | none | compile script is explicit |
| pdf | `qpdf`, `pdftotext`, `pdfimages`, `pdftoppm`, `pypdf`, `pdfplumber`, `pypdfium2`, `reportlab`, `pdf2image`, `pytesseract`, `PyMuPDF`, `imagemagick` | none | strongest document-processing dependency set |
| performance-analytics | none | none | knowledge-only |
| pptx | `markitdown[pptx]`, `Pillow`, `pptxgenjs`, `react`, `react-dom`, `react-icons`, `sharp`, `soffice`, `pdftoppm`, `python-pptx`, `lxml` | none | skill explicitly lists these as pre-installed |
| presentations | `bun`, Python `playwright`, `PyPDF2`, `python-pptx`, `Pillow` | none | shipped scripts/pyproject declare dependencies |
| reconciliation | none | none | knowledge-only |
| remotion | `ffmpeg`, `ffprobe` | project-local Remotion/npm packages | skill docs assume Remotion project deps, but image should at least supply ffmpeg tooling |
| replicate | `curl`, `jq` | `REPLICATE_API_TOKEN` | CLI examples explicitly use curl+jq |
| research-assistant | none beyond core web/search tools | none | process skill |
| research-report | `python3`/`bash` useful for generating charts/files | none | report-writing wrapper |
| response-drafting | none | none | knowledge-only |
| risk-assessment | none | none | knowledge-only |
| roadmap-management | none | none | knowledge-only |
| sql-queries | optional DB CLIs if desired, none explicitly required in folder | database credentials if used | no shipped local scripts |
| stakeholder-comms | none | none | knowledge-only |
| statistical-analysis | none | none | knowledge-only |
| theme-factory | none | none | knowledge-only |
| ticket-triage | none | none | knowledge-only |
| user-research-synthesis | none | none | knowledge-only |
| validation | none | none | knowledge-only |
| variance-analysis | none | none | knowledge-only |
| visualization | `numpy`, `pandas`, `matplotlib`, `seaborn` | none | data-viz helper stack |
| webapp | base image should have `node`, `npm`, browser QA path | project-local npm install | environment file says `npm install` is required in generated app |
| website-building | base image should have `node`, `npm`, browser QA path | project-local npm install | relies on website/webapp project deps, plus local browser verification |
| whisper | none beyond shipped runner + supported audio/video stack | `GROQ_API_KEY` or `OPENAI_API_KEY` | audio/video transcription wrapper |
| xlsx | `libreoffice`, `openpyxl`, `python3` | none | scripts use soffice + openpyxl |

## Concrete Dockerfile deltas from the full sweep

### Already important and should stay
- `git`
- `github-cli`
- `jq`
- `docker-cli`
- `docker-cli-compose`
- `whois`
- `imagemagick`
- `python-docx`
- global Node `playwright`
- global Node `pdf-lib`

### Still justified after walking all 64 skills
- `fastapi[standard]` in pip install block
- font packages for PDF/browser/document coverage

### Probably not worth globalizing in the base image
- full Remotion npm stack
- all webapp/template npm deps globally
- database CLIs (`psql`, `mysql`, etc.) unless you want them as a general convenience layer rather than because the skill folder requires them

## Bottom line

After a full-folder audit, the heavy guaranteed dependencies are concentrated in:
- `document-review`
- `docx`
- `domain-research`
- `fastapi-sdk`
- `legal-writer`
- `logo-creator`
- `paper-creator`
- `pdf`
- `pptx`
- `presentations`
- `remotion`
- `replicate`
- `visualization`
- `webapp` / `website-building`
- `whisper`
- `xlsx`

Most of the remaining skills are knowledge/process frameworks and do **not** introduce additional local runtime packages.

## KORTIX-system walkthrough

| Skill | Bake into image | Host-only / external | Notes |
|---|---|---|---|
| agent-browser | existing `agent-browser` npm global, `chromium`; optionally `appium` npm global for parity with docs | **Xcode**, iOS simulator stack, and meaningful Appium+iOS use are macOS-only | Linux container can satisfy browser automation; iOS path remains host/mac-specific |
| agent-tunnel | `bun` | active Agent Tunnel connection to user machine | skill states no extra external deps beyond the script/runtime |
| computer-use | none in container beyond `bun`/agent-tunnel runtime | **agent-click** must be installed on the user's macOS machine; skill explicitly installs it there with `npm install -g agent-click` | do not confuse host requirement with container requirement |

## Final image package stance after both trees

### Add to the image
- `fastapi[standard]`
- `fontconfig`
- DejaVu / Liberation / Noto fonts
- optional global `appium` to align with the `agent-browser` skill docs, while still documenting that Xcode/iOS support remains host-only

### Do not force into the image
- `agent-click` (skill explicitly installs it on the user's machine, not in the sandbox)
- `Xcode` / iOS simulator tooling (not possible in this Linux image)
