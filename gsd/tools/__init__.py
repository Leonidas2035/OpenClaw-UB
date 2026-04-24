"""
tools — Pluggable tool registry for EphemeralWorkers.

Each tool implements the BaseTool interface and is injected into a worker
only when the orchestrator decides that specific task needs it.
"""
