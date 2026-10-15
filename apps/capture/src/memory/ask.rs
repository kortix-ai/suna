//! "Ask your agent": hand a prompt to a coding agent in the user's terminal.
//!
//! Local agents (Claude Code, Codex, Cursor) read the library themselves
//! through the installed skill, so the prompt only needs to name
//! kortix-capture. Kortix cloud sessions cannot reach this machine, so that
//! route attaches the `now` context bundle to the prompt.

use super::paths::MemoryPaths;
use super::settings::Settings;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

pub const AGENTS: &[(&str, &str, &str)] = &[
    // (id, label, cli binary)
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
    ("cursor", "Cursor", "cursor-agent"),
    ("kortix", "Kortix", "kortix"),
];

/// Starter prompts for the command bar. `[topic]` marks a blank to fill in.
pub const SUGGESTIONS: &[(&str, &str)] = &[
    ("Summarize my day", "Summarize what I worked on today, grouped by project, with the time spent on each."),
    ("Find something I saw", "Help me find something I saw on my screen but can't find again. Ask me what I remember, then track it down."),
    ("Recover lost text", "I typed something that got lost when a tab or app closed. Ask me what it was about, then recover the text."),
    ("Find an unsaved link", "Find a link I saw but never saved. Ask me what I remember about the page, then recover the exact URL."),
    ("Recover a terminal command", "Find a terminal command I ran recently. Ask me what it was for, then give me the exact command."),
    ("Find that error", "Find the most recent error message on my screen, quote it exactly, and tell me what I was doing right before it."),
    ("Where did my time go", "Which apps and websites took most of my time this week, and how did that change from last week?"),
    ("Reading list on a topic", "List every article and page I read about [topic], with a one-line summary and link for each."),
    ("Recover a detail", "I saw a detail once (a confirmation number, address, or time) and never wrote it down. Ask me what it was, then find it."),
    ("Meeting notes", "Reconstruct notes from my last video call: who was on screen, what was shared, and any action items visible."),
    ("Standup update", "Write my standup update from what I did since yesterday morning: done, in progress, blocked."),
    ("Context switching", "How often did I switch between apps today, and which switches broke my longest focus blocks?"),
    ("Find a repo", "Find the GitHub repository I looked at recently about [topic]."),
    ("Resume where I left off", "What was I working on right before my last break? Give me the files, pages, and next step."),
];

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    // GUI-launched processes get a minimal PATH; add the usual install dirs.
    if let Some(h) = &home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".npm-global/bin"));
        dirs.push(h.join(".bun/bin"));
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    for dir in dirs {
        for name in [bin.to_string(), format!("{bin}.exe"), format!("{bin}.cmd")] {
            let p = dir.join(&name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn detected() -> Value {
    Value::Array(
        AGENTS
            .iter()
            .map(|(id, label, bin)| json!({"id": id, "label": label, "cli": bin, "installed": which(bin).is_some()}))
            .collect(),
    )
}

pub fn resolve_agent(
    requested: &str,
) -> Result<&'static (&'static str, &'static str, &'static str)> {
    if requested == "auto" {
        return AGENTS
            .iter()
            .find(|(_, _, bin)| which(bin).is_some())
            .context(
            "no supported agent found (install Claude Code, Codex, Cursor CLI, or the Kortix CLI)",
        );
    }
    AGENTS
        .iter()
        .find(|(id, _, _)| *id == requested)
        .with_context(|| {
            format!("unknown agent {requested:?} (claude, codex, cursor, kortix, auto)")
        })
}

/// POSIX single-quote escaping.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub fn with_hint(prompt: &str) -> String {
    let p = prompt.trim();
    if p.to_ascii_lowercase().contains("kortix-capture") {
        p.to_string()
    } else {
        format!("{p} Use kortix-capture.")
    }
}

/// Shell command line that runs the agent with the prompt.
pub fn command_line(agent: &str, prompt: &str, context: Option<&str>) -> String {
    match agent {
        "claude" => format!("claude {}", sh_quote(&with_hint(prompt))),
        "codex" => format!("codex {}", sh_quote(&with_hint(prompt))),
        "cursor" => format!("cursor-agent {}", sh_quote(&with_hint(prompt))),
        _ => {
            let mut text = prompt.trim().to_string();
            if let Some(ctx) = context.filter(|c| !c.trim().is_empty()) {
                text.push_str("\n\n<recorded_screen_context>\n");
                text.push_str(ctx.trim());
                text.push_str("\n</recorded_screen_context>");
            }
            format!("kortix sessions chat --new --prompt {}", sh_quote(&text))
        }
    }
}

/// Open `line` in a new terminal window that stays open afterwards.
pub fn launch_in_terminal(paths: &MemoryPaths, line: &str, terminal: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let dir = paths.root.join("tmp");
        std::fs::create_dir_all(&dir)?;
        let file = dir.join(format!("ask-{}.command", super::store::now_ms()));
        std::fs::write(
            &file,
            format!("#!/bin/zsh -l\ncd \"$HOME\"\n{line}\nexec \"${{SHELL:-/bin/zsh}}\" -l\n"),
        )?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))?;
        let mut cmd = Command::new("open");
        if terminal != "default" && !terminal.is_empty() {
            cmd.args(["-a", terminal]);
        }
        let status = cmd.arg(&file).status()?;
        if !status.success() && terminal != "default" {
            Command::new("open")
                .args(["-a", "Terminal"])
                .arg(&file)
                .status()?;
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let _ = paths;
        let line = line.replace('\'', "\"");
        let mut cmd = if terminal == "default" || terminal.is_empty() {
            let mut c = Command::new("cmd");
            c.args(["/c", "start", "", "cmd", "/k", &line]);
            c
        } else {
            let mut c = Command::new(terminal);
            c.args(["cmd", "/k", &line]);
            c
        };
        cmd.spawn()?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = paths;
        let term = if terminal == "default" || terminal.is_empty() {
            "x-terminal-emulator"
        } else {
            terminal
        };
        Command::new(term)
            .args(["-e", "bash", "-lc", &format!("{line}; exec bash")])
            .spawn()
            .with_context(|| format!("launch {term}"))?;
        Ok(())
    }
}

/// Route a prompt. Returns what was launched.
pub fn ask(
    paths: &MemoryPaths,
    prompt: &str,
    agent: Option<&str>,
    terminal: Option<&str>,
    dry_run: bool,
) -> Result<Value> {
    if prompt.trim().is_empty() {
        bail!("empty prompt");
    }
    let s = Settings::load(paths);
    let routing = s.extra.get("agent_routing").cloned().unwrap_or(Value::Null);
    let agent = agent
        .map(str::to_string)
        .or_else(|| {
            routing
                .get("agent")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "auto".into());
    let terminal = terminal
        .map(str::to_string)
        .or_else(|| {
            routing
                .get("terminal")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "default".into());
    let (id, label, _) = *resolve_agent(&agent)?;
    let context = if id == "kortix" {
        now_context(paths)
    } else {
        None
    };
    let line = command_line(id, prompt, context.as_deref());
    if !dry_run {
        launch_in_terminal(paths, &line, &terminal)?;
    }
    Ok(
        json!({"agent": id, "label": label, "terminal": terminal, "command": line, "launched": !dry_run}),
    )
}

/// Compact `kortix-capture now` output for cloud routes.
fn now_context(paths: &MemoryPaths) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let out = crate::os_proc::no_window(&mut Command::new(exe))
        .args([
            "now",
            "--minutes",
            "10",
            "--max-chars",
            "4000",
            "--timeout",
            "3",
        ])
        .env(super::paths::DATA_DIR_ENV, &paths.root)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_single_quotes() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn local_agents_get_the_skill_hint_once() {
        assert_eq!(
            command_line("claude", "Summarize my day.", None),
            "claude 'Summarize my day. Use kortix-capture.'"
        );
        assert_eq!(
            command_line("codex", "use kortix-capture to find x", None),
            "codex 'use kortix-capture to find x'"
        );
    }

    #[test]
    fn kortix_route_attaches_context_as_data() {
        let line = command_line("kortix", "what was I doing?", Some("screen text"));
        assert!(line.starts_with("kortix sessions chat --new --prompt '"));
        assert!(line.contains("<recorded_screen_context>\nscreen text\n</recorded_screen_context>"));
    }

    #[test]
    fn unknown_agent_is_rejected() {
        assert!(resolve_agent("gpt").is_err());
    }
}
