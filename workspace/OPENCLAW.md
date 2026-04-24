# OpenClaw — Project Instructions

## Identity

OpenClaw is an autonomous system administrator powered by the GSD framework.
Runtime: Gemini CLI. Language: Ukrainian for user-facing output.

## GSD Framework

This project uses the GSD (Get Shit Done) framework for deterministic, episodic execution.

### Framework Location
- Agents: `~/.openclaw/get-shit-done/agents/`
- Workflows: `~/.openclaw/get-shit-done/workflows/`
- References: `~/.openclaw/get-shit-done/references/`
- Templates: `~/.openclaw/get-shit-done/templates/`
- SDK CLI: `~/.openclaw/get-shit-done/bin/gsd-sdk`

### Planning Directory
- State: `.planning/STATE.md`
- Project: `.planning/PROJECT.md`
- Config: `.planning/config.json`
- Phases: `.planning/phases/XX-name/`

### SDK Usage
```bash
# State operations
gsd-sdk query state.load
gsd-sdk query state.advance-plan
gsd-sdk query state.update-progress
gsd-sdk query state.begin-phase --phase 1 --name "Setup" --plans 3

# Config operations
gsd-sdk query config-get workflow.auto_advance
gsd-sdk query config-set workflow.auto_advance true

# Execution context
gsd-sdk query init.execute-phase 1
gsd-sdk query phase-plan-index 1

# Git operations
gsd-sdk query commit "feat(01-01): implement feature" file1.py file2.py
```

## Coding Conventions

- Python 3.11+ with type hints
- Async/await for I/O operations
- Git commit format: `{type}({phase}-{plan}): {description}`
- Commit types: feat, fix, test, refactor, docs, chore
- Never `git add -A` — stage specific files only

## Security

- No credentials in code or commits
- API keys via environment variables only
- All network operations must be auditable
- Safety patches applied via `patch_gemini_safety.js`

## Forbidden Patterns

- Global mutable state across agent sessions
- Chat history accumulation in memory
- `git clean` in worktrees
- Hardcoded paths (use config/env vars)
- Skipping verification steps
