# OpenClaw — Project Definition

## Core Value

Autonomous system administration agent powered by Gemini AI, operating through the GSD (Get Shit Done) deterministic framework for reliable, context-fresh execution.

## Project Description

OpenClaw is an AI-driven autonomous system administrator that uses the GSD state-machine architecture to execute complex infrastructure tasks. It replaces monolithic, context-degrading chat sessions with episodic, file-driven execution where each worker operates with a fresh context window.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI Runtime | Gemini CLI (gemini-3.1-pro / gemini-3-flash) |
| Orchestration | Python 3.11+ (asyncio) |
| State Management | Markdown files (GSD pattern) |
| SDK | Python gsd-sdk CLI |
| Version Control | Git (atomic per-task commits) |
| Framework | GSD (Get Shit Done) v2.x |

## Architecture

```
┌─────────────────────────────────────────────┐
│  GSD Framework (~/.openclaw/get-shit-done/)  │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐  │
│  │ Agents   │ │ Workflows │ │ References │  │
│  │ (33 .md) │ │ (83 .md)  │ │ (51 .md)   │  │
│  └──────────┘ └───────────┘ └────────────┘  │
├─────────────────────────────────────────────┤
│  Python SDK (gsd-sdk CLI)                   │
│  State queries, config, git, plan parsing   │
├─────────────────────────────────────────────┤
│  Workspace (.planning/)                      │
│  STATE.md │ ROADMAP.md │ phases/ │ research/ │
└─────────────────────────────────────────────┘
```

## Key Decisions

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | GSD framework over monolithic orchestration | Eliminates context rot via ephemeral workers | 2026-04-24 |
| 2 | Python gsd-sdk instead of TypeScript | Native to OpenClaw's Python ecosystem | 2026-04-24 |
| 3 | Path namespace ~/.openclaw/ | Avoids conflict with other AI tool directories | 2026-04-24 |
| 4 | Gemini CLI as LLM runtime | Primary AI backend for OpenClaw | 2026-04-22 |

## Constraints

- Must work offline (except LLM API calls)
- All state persisted to filesystem (no database)
- Each worker gets clean context (no history accumulation)
- Git commits per task (not per session)

## Evolution Rules

1. New features go through GSD lifecycle: discuss → plan → execute → verify
2. All deviations documented in SUMMARY.md
3. Architectural changes require human approval (Rule 4)
4. STATE.md stays under 100 lines
