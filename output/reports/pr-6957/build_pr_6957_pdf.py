from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "output" / "pdf" / "pr-6957-code-quality-and-frontend-qa.pdf"
REPORT_SHOTS = ROOT / "output" / "reports" / "pr-6957" / "screenshots"
PLAYWRIGHT_SHOTS = ROOT / "output" / "playwright"

INK = colors.HexColor("#171717")
MUTED = colors.HexColor("#62666D")
LINE = colors.HexColor("#D8DADD")
SOFT = colors.HexColor("#F4F5F6")
RED = colors.HexColor("#B42318")
RED_BG = colors.HexColor("#FEF3F2")
AMBER = colors.HexColor("#9A6700")
AMBER_BG = colors.HexColor("#FFF8E6")
GREEN = colors.HexColor("#067647")
GREEN_BG = colors.HexColor("#ECFDF3")
BLUE = colors.HexColor("#175CD3")
BLUE_BG = colors.HexColor("#EFF8FF")


styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        "KTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=24,
        leading=28,
        textColor=INK,
        spaceAfter=6 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "KSubtitle",
        parent=styles["Normal"],
        fontSize=10,
        leading=14,
        textColor=MUTED,
        spaceAfter=3 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "KH1",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=17,
        leading=21,
        textColor=INK,
        spaceBefore=4 * mm,
        spaceAfter=3 * mm,
        keepWithNext=True,
    )
)
styles.add(
    ParagraphStyle(
        "KH2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=15,
        textColor=INK,
        spaceBefore=3 * mm,
        spaceAfter=2 * mm,
        keepWithNext=True,
    )
)
styles.add(
    ParagraphStyle(
        "KBody",
        parent=styles["BodyText"],
        fontSize=9.2,
        leading=13.2,
        textColor=INK,
        spaceAfter=2.3 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "KBullet",
        parent=styles["BodyText"],
        fontSize=9.1,
        leading=13,
        textColor=INK,
        leftIndent=5 * mm,
        firstLineIndent=-3.5 * mm,
        spaceAfter=1.4 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "KSmall",
        parent=styles["BodyText"],
        fontSize=7.5,
        leading=10,
        textColor=MUTED,
        spaceAfter=1.5 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "KCaption",
        parent=styles["Normal"],
        fontName="Helvetica-Oblique",
        fontSize=7.2,
        leading=9.5,
        textColor=MUTED,
        alignment=TA_CENTER,
        spaceBefore=1.2 * mm,
        spaceAfter=3 * mm,
    )
)
styles.add(
    ParagraphStyle(
        "KTable",
        parent=styles["BodyText"],
        fontSize=7,
        leading=9.2,
        textColor=INK,
    )
)
styles.add(
    ParagraphStyle(
        "KTableHead",
        parent=styles["BodyText"],
        fontName="Helvetica-Bold",
        fontSize=7,
        leading=9.2,
        textColor=colors.white,
    )
)


def p(text, style="KBody"):
    return Paragraph(text, styles[style])


def h1(text):
    return p(text, "KH1")


def h2(text):
    return p(text, "KH2")


def bullet(text):
    return Paragraph("- " + text, styles["KBullet"])


def box(title, text, color, background):
    data = [
        [Paragraph(title, ParagraphStyle("BoxHead", parent=styles["KH2"], textColor=color, spaceBefore=0))],
        [p(text)],
    ]
    table = Table(data, colWidths=[170 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), background),
                ("BOX", (0, 0), (-1, -1), 0.8, color),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def table(headers, rows, widths):
    data = [[p(escape(str(cell)), "KTableHead") for cell in headers]]
    for row in rows:
        data.append([p(escape(str(cell)), "KTable") for cell in row])
    result = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    result.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), INK),
                ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
            ]
        )
    )
    return result


def screenshot(path, caption, max_height=105 * mm):
    image = Image(str(path))
    max_width = 170 * mm
    scale = min(max_width / image.imageWidth, max_height / image.imageHeight)
    image.drawWidth = image.imageWidth * scale
    image.drawHeight = image.imageHeight * scale
    return KeepTogether([image, p(caption, "KCaption")])


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(20 * mm, 16 * mm, 190 * mm, 16 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(20 * mm, 10 * mm, "Kortix PR #6957 - code-quality and frontend QA")
    canvas.drawRightString(190 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


OUT.parent.mkdir(parents=True, exist_ok=True)
doc = SimpleDocTemplate(
    str(OUT),
    pagesize=A4,
    rightMargin=20 * mm,
    leftMargin=20 * mm,
    topMargin=18 * mm,
    bottomMargin=22 * mm,
    title="PR #6957 code-quality and frontend QA report",
    author="Codex",
)

story = []

story += [
    Spacer(1, 13 * mm),
    p("PR #6957", "KSubtitle"),
    p("Code-quality and frontend QA report", "KTitle"),
    p("Repository: kortix-ai/suna", "KSubtitle"),
    p("Reviewed: 2026-08-28", "KSubtitle"),
    p("Original head: 5c609e689e03f2a93468e32257ac537e7e1f1517", "KSubtitle"),
    p("Fix commit: 7cc805c37578d66c50ef9ebed1c76c58ed45eb64", "KSubtitle"),
    p("Current head: 1f86186e6d0c9c526960e9b18834e65395e7d1fc", "KSubtitle"),
    Spacer(1, 5 * mm),
    box(
        "DECISION: DO NOT MERGE YET",
        "The confirmed code gaps are fixed. Queue persistence and refresh visibility pass in Chromium. "
        "The cloud runtime ended with runtime_gone before the second prompt completed. New-head CI is still running.",
        RED,
        RED_BG,
    ),
    Spacer(1, 7 * mm),
    h1("Executive result"),
    bullet("JAY-720 now retries history from the last successful cursor."),
    bullet("JAY-721 now bounds the first never-settling /start request."),
    bullet("The lifecycle queue now sends one prompt per session."),
    bullet("Empty zero-token assistant rows no longer paint blank turns."),
    bullet("Older empty queue snapshots cannot erase a newer queue row in the SDK observation path."),
    bullet("The branch is synchronized with main. GitHub reports mergeable: true."),
    Spacer(1, 4 * mm),
    box(
        "Confidence",
        "Code-level confidence is high for the fixed regressions. User-flow confidence is medium. "
        "Ship confidence remains blocked by one stable two-prompt completion and new-head CI.",
        AMBER,
        AMBER_BG,
    ),
    PageBreak(),
]

story += [
    h1("Original-head browser failure"),
    p(
        "P1 requested a 30-second wait. P2 was submitted while P1 was active. "
        "Both lifecycle rows were marked delivered, but the first answer appeared below P2. "
        "The requested P2 result never appeared."
    ),
    table(
        ["Prompt", "Started UTC", "Ended UTC", "Duration"],
        [
            ["P1", "17:43:26.534", "17:43:59.945", "33.411 s"],
            ["P2", "17:43:38.791", "17:44:01.254", "22.463 s"],
        ],
        [25 * mm, 45 * mm, 45 * mm, 35 * mm],
    ),
    Spacer(1, 4 * mm),
    box(
        "Confirmed integrity failure",
        "The turns overlapped for about 21.154 seconds. The UI attributed FINAL_P1_DONE to P2. "
        "No assistant message contained FINAL_P2_DONE.",
        RED,
        RED_BG,
    ),
    Spacer(1, 5 * mm),
    screenshot(
        REPORT_SHOTS / "09-final-head-result.png",
        "Original PR head: the P1 result appears below the P2 prompt.",
        120 * mm,
    ),
    PageBreak(),
]

story += [
    h1("Fixes implemented"),
    h2("JAY-720 - history cursor"),
    bullet("Each successful page hydrates messages and commits its cursor."),
    bullet("A failure after cursor 5 now retries with before=cursor-5."),
    h2("JAY-721 - first unresolved start"),
    bullet("useSessionStartGiveUp owns the deadline and verdict."),
    bullet("The first unresolved request arms the deadline."),
    bullet("Later data or errors clear the deadline and verdict."),
    h2("Durable queue serialization"),
    bullet("An active turn refuses admission with reason turn_active."),
    bullet("One drain sends only the head prompt for each session."),
    bullet("Sibling prompts return to the queue with bounded backoff."),
    bullet("The engine no longer starts same-session deliveries concurrently."),
    h2("Related correctness fixes"),
    bullet("Parentless zero-part, zero-token assistants are skipped only when they have no error."),
    bullet("Queue projection and query cache updates share applyInboxObservation."),
    bullet("splitTimingDurations removes wall-clock subtraction from timing assertions."),
    Spacer(1, 4 * mm),
    box(
        "Post-main-sync regression gates",
        "Full SDK suite: pass. SDK typecheck: exit 0. Focused API queue and timing tests: 38 pass, 0 fail.",
        GREEN,
        GREEN_BG,
    ),
    PageBreak(),
]

story += [
    h1("Post-fix browser evidence"),
    p(
        "P1 requested a 20-second wait and FIRST_OK_0828. P2 requested SECOND_OK_0828 while P1 was active. "
        "Both POST /prompts calls returned HTTP 202. GET /prompts retained P2 with reason turn_active and attempts 0."
    ),
    screenshot(
        PLAYWRIGHT_SHOTS / "pr-6957-p2-queued-during-p1.png",
        "P2 remains queued while P1 owns the active turn.",
        82 * mm,
    ),
    screenshot(
        PLAYWRIGHT_SHOTS / "pr-6957-queued-message-visible-after-refresh.png",
        "The queued P2 row remains visible after a browser refresh.",
        82 * mm,
    ),
    PageBreak(),
]

story += [
    h1("Browser verdict"),
    box(
        "Verified",
        "P2 stayed in the durable queue. The UI displayed its queued state. A refresh preserved the row. "
        "No same-session overlap occurred during the observed window.",
        GREEN,
        GREEN_BG,
    ),
    Spacer(1, 5 * mm),
    box(
        "Not verified",
        "The runtime ended with runtime_gone. P1 was requeued as redelivered after runtime_gone. "
        "P2 remained waiting. The run did not prove automatic P2 completion or final parent-to-answer attribution.",
        AMBER,
        AMBER_BG,
    ),
    h1("Automated verification"),
    table(
        ["Surface", "Result"],
        [
            ["Focused SDK regression files", "71 pass, 0 fail"],
            ["Mounted start give-up hook", "2 pass, 0 fail"],
            ["Full SDK suite after main sync", "Pass"],
            ["SDK typecheck after main sync", "Exit 0"],
            ["SDK packed install smoke", "Exit 0"],
            ["Focused API after main sync", "38 pass, 0 fail"],
            ["Full API before main sync", "8,748 pass, 79 skip, 0 fail"],
            ["Full web before main sync", "8,648 pass, 0 fail"],
            ["Standalone CLI before main sync", "1,243 pass, 0 fail"],
            ["Changed-file ESLint", "0 errors, 32 warnings"],
            ["git diff --check", "Clean"],
        ],
        [95 * mm, 70 * mm],
    ),
    Spacer(1, 4 * mm),
    p(
        "The root packages-only run failed in its concurrent CLI sub-lane without useful output. "
        "The same CLI suite passed standalone. Treat the root package lane as unresolved until CI completes.",
        "KSmall",
    ),
    PageBreak(),
]

story += [
    h1("Linear Phase 0 verification"),
    table(
        ["Issue", "Assessment"],
        [
            ["JAY-717", "Unit-covered; real provider retry not induced"],
            ["JAY-718", "Long-turn Stop verified; provider retry not induced"],
            ["JAY-719", "Keepalive excluded from process evidence"],
            ["JAY-720", "Fixed and verified"],
            ["JAY-721", "Fixed and verified"],
            ["JAY-722", "Active provisioning browser verified"],
            ["JAY-723", "Unit-covered; real poison sequence not induced"],
            ["JAY-724", "Boot-phase header browser verified"],
            ["JAY-725", "Cache-key covered; custom directory browser run absent"],
            ["JAY-726", "Empty assistant suppression fixed by tests"],
            ["JAY-291", "Legacy queue serialized; protocol v2 remains"],
        ],
        [30 * mm, 135 * mm],
    ),
    Spacer(1, 5 * mm),
    box(
        "Status discipline",
        "All PR-related issues remain In Progress. Repository policy permits Done only after merge, dev deployment, and dev verification.",
        BLUE,
        BLUE_BG,
    ),
    h1("New tracked gaps"),
    h2("JAY-728 - queue snapshot freshness clock"),
    p("POST, GET, bundle, and stream observations need one server-defined order or revision."),
    h2("JAY-729 - failed-session redirect escape"),
    p("A failed session needs a deterministic browser test, a visible escape action, and no redirect loop."),
    PageBreak(),
]

story += [
    h1("Marko critical-issue mapping"),
    table(
        ["Items", "Theme", "Tracking / assessment"],
        [
            ["1-3", "Mid-turn death and silent death", "JAY-430, JAY-566, JAY-723; not closed"],
            ["4", "140 MB history and OOM", "JAY-686, JAY-689, JAY-351; not closed"],
            ["5", "UI slower than terminal", "JAY-697; not closed"],
            ["6", "Agent and stream architecture", "Protocol phases 1-4; Phase 0 only"],
            ["7-10", "Queue and reconnection", "JAY-291, JAY-572, JAY-726; improved"],
            ["11", "Warm prior-session regression", "JAY-596; not closed"],
            ["12", "Slow resume", "JAY-697; not closed"],
            ["13", "Redirect softlock", "JAY-729; new urgent ticket"],
            ["14-15", "Stop/restart and bricked session", "JAY-430, JAY-566, JAY-723; not closed"],
            ["16", "Unexplained terminal incident", "Needs incident-specific evidence"],
        ],
        [18 * mm, 60 * mm, 87 * mm],
    ),
    Spacer(1, 6 * mm),
    box(
        "Scope conclusion",
        "PR #6957 is Phase 0 symptom relief. It does not complete the Session State Protocol architecture or close all 16 incidents.",
        AMBER,
        AMBER_BG,
    ),
    PageBreak(),
]

story += [
    h1("Thermo-nuclear code-quality review"),
    h2("Correct improvements"),
    bullet("The new start give-up hook removes timing state from the 1,500-line use-session hook."),
    bullet("Queue observations pass through one helper per observation path."),
    bullet("The false stream-attached polling mode is removed."),
    bullet("The terminal card gate uses the SDK SessionStartStage type."),
    bullet("Reconciler comments now match the actual four subsystem reads."),
    h2("Remaining structural debt"),
    table(
        ["Production file", "Lines"],
        [
            ["apps/web session-chat.tsx", "5,433"],
            ["daemon main.ts", "3,234"],
            ["SDK sync-store.ts", "2,723"],
            ["lifecycle engine.ts", "2,244"],
            ["SDK use-session.ts", "1,521"],
            ["session route page.tsx", "1,417"],
        ],
        [125 * mm, 40 * mm],
    ),
    Spacer(1, 4 * mm),
    box(
        "Review boundaries",
        "No PR file crossed from below 1,000 lines to above 1,000 lines. "
        "Source-text assertions remain weaker than mounted or black-box behavior tests. "
        "The unrelated globals.css text-blur removal should move to a separate PR.",
        BLUE,
        BLUE_BG,
    ),
    PageBreak(),
]

story += [
    h1("Final shipping gate"),
    p("Do not merge PR #6957 until every item below passes."),
    bullet("GitHub checks pass at head 1f86186e6d0c9c526960e9b18834e65395e7d1fc."),
    bullet("A stable real sandbox completes P1 and P2 automatically."),
    bullet("The DOM contains both exact assistant outputs under the correct prompts."),
    bullet("Lifecycle timestamps prove no same-session overlap."),
    bullet("Refresh during P1 preserves P2 and later drains it."),
    bullet("JAY-728 and JAY-729 remain tracked until their acceptance tests pass."),
    bullet("After merge, dev deploys the merged SHA and the same browser journey passes on dev."),
    Spacer(1, 7 * mm),
    box(
        "Current recommendation",
        "Keep the PR open and unmerged. The confirmed code defects are fixed. "
        "Wait for CI and rerun the two-prompt browser journey on a stable runtime.",
        RED,
        RED_BG,
    ),
    Spacer(1, 8 * mm),
    HRFlowable(width="100%", thickness=0.6, color=LINE),
    Spacer(1, 4 * mm),
    p("No credentials are stored in this PDF. No PR merge occurred.", "KSmall"),
]

doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(OUT)
