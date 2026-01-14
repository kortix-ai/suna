# Claude Code Rules

## Package Manager

This project uses **pnpm** as the package manager. Always use `pnpm` instead of `npm` or `yarn` for all package-related commands:

- `pnpm install` - Install dependencies
- `pnpm run build` - Build the project (slow, avoid unless specifically requested)
- `pnpm run dev` - Run development server
- `pnpm run lint` - Run linter (fast, use for quick validation)
- `pnpm test` - Run tests

## Build vs Lint

**Do NOT run `pnpm run build` frequently** - it takes too long and slows down development.

Instead, use the linter for quick validation:
```bash
cd apps/frontend && pnpm run lint
```

Only run `pnpm run build` when:
- User specifically requests a build
- Final verification before committing/deploying
- Debugging build-specific issues

## Development Servers

Use **tmux** to manage long-running dev sessions. This allows servers to persist and be restarted when needed.

### Frontend (apps/frontend)
```bash
tmux new-session -d -s frontend
tmux send-keys -t frontend 'cd /Users/markokraemer/Projects/agentpress/apps/frontend && pnpm run dev' Enter
```

### Mobile (apps/mobile)
```bash
tmux new-session -d -s mobile
tmux send-keys -t mobile 'cd /Users/markokraemer/Projects/agentpress/apps/mobile && pnpm run dev' Enter
```

### Backend (backend/)
```bash
tmux new-session -d -s backend
tmux send-keys -t backend 'cd /Users/markokraemer/Projects/agentpress/backend && uv run api.py' Enter
```

### Tmux Commands
- Kill and restart: `tmux send-keys -t <session> C-c` then resend the command
- Check session: `tmux has-session -t <session> 2>/dev/null`
- View output: `tmux capture-pane -t <session> -p | tail -20`
- Attach to session: `tmux attach -t <session>`

## Backend Python Development

The backend uses **uv** for Python dependency management and execution. Always use `uv` instead of direct `python` or `pip` commands.

### Running Python Scripts
```bash
cd backend && uv run api.py
```

### Python Dependency Management
```bash
# Install dependencies
cd backend && uv sync

# Add a new dependency
cd backend && uv add <package-name>

# Run Python scripts
cd backend && uv run <script.py>

# Run Python module
cd backend && uv run python -m <module>
```

### Syntax Validation
To check Python files for syntax errors:
```bash
cd backend && uv run python -m py_compile <file.py>
```

### Testing Backend Changes
After modifying backend code:
1. Check syntax: `uv run python -m py_compile <file.py>`
2. Restart backend server: `tmux send-keys -t backend C-c` then resend start command
3. Monitor logs: `tmux capture-pane -t backend -p | tail -50`

## Commit Messages

Keep commit messages short - 1 line, no fluff.
