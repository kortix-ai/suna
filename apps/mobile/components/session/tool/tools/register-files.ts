/**
 * Tool renderers for files and shell: read, write, edit, apply_patch, list, glob, grep, bash, pty_*.
 * Import each `<name>-tool.tsx` here; the file registers itself with `ToolRegistry`.
 */
import './read-tool';
import './write-tool';
import './edit-tool';
import './apply-patch-tool';
import './list-tool';
import './glob-tool';
import './grep-tool';
import './bash-tool';
import './pty-spawn-tool';
import './pty-read-tool';
import './pty-write-tool';
import './pty-kill-tool';
