"""
GSD (Get Shit Done) — Episodic State-Machine Agent Framework.

A deterministic, episodic orchestration system that replaces the traditional
"global chat history" approach with file-based state management and
ephemeral workers.

Architecture:
    Layer 1: MarkdownStateManager  — File-system as memory (PLAN.md, STATE.md)
    Layer 2: Orchestrator          — Main event loop (never writes code)
    Layer 3: EphemeralWorker       — Isolated executor (spawned per task, then destroyed)
"""

__version__ = "0.1.0"
__author__ = "OpenClaw"
