"""
models.py — Domain data models for the GSD agent framework.

Contains all dataclasses used across the three architectural layers.
These models are intentionally simple and serialization-free: the only
persistence mechanism is Markdown text on disk.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class TaskStatus(Enum):
    """Possible states for a task extracted from PLAN.md."""

    PENDING = "pending"       # - [ ] ...
    COMPLETED = "completed"   # - [x] ...


class WorkerOutcome(Enum):
    """Outcome of an EphemeralWorker execution."""

    SUCCESS = "success"
    FAILURE = "failure"


@dataclass(frozen=True)
class Task:
    """A single actionable item parsed from PLAN.md.

    Attributes:
        description: The raw task text (without the checkbox prefix).
        status: Whether the task is pending or completed.
        line_number: 1-indexed line number in PLAN.md where this task lives.
        phase: Optional phase/section header the task belongs to.
    """

    description: str
    status: TaskStatus
    line_number: int
    phase: str = ""

    @property
    def is_pending(self) -> bool:
        """Return True if this task has not been completed yet."""
        return self.status == TaskStatus.PENDING

    def __str__(self) -> str:
        checkbox = "[ ]" if self.is_pending else "[x]"
        prefix = f"[{self.phase}] " if self.phase else ""
        return f"- {checkbox} {prefix}{self.description}"


@dataclass
class WorkerResult:
    """Result returned by an EphemeralWorker after execution.

    Attributes:
        success: Whether the task was completed successfully.
        message: Commit message on success, or error details on failure.
        worker_id: Unique identifier for the worker instance.
        duration_seconds: Wall-clock time the worker spent executing.
        artifacts: Optional list of file paths created/modified by the worker.
    """

    success: bool
    message: str
    worker_id: str = field(default_factory=lambda: f"worker-{uuid.uuid4().hex[:8]}")
    duration_seconds: float = 0.0
    artifacts: list[str] = field(default_factory=list)

    @property
    def outcome(self) -> WorkerOutcome:
        """Return the outcome enum value."""
        return WorkerOutcome.SUCCESS if self.success else WorkerOutcome.FAILURE


@dataclass
class OrchestratorConfig:
    """Configuration for the orchestrator loop.

    Attributes:
        workspace_dir: Absolute path to the workspace directory
                       containing PLAN.md and STATE.md.
        plan_filename: Name of the plan file (default: PLAN.md).
        state_filename: Name of the state journal file (default: STATE.md).
        soul_filename: Name of the persona/soul file for worker system prompts.
        auto_commit: Whether to auto-commit to git after each successful task.
        max_consecutive_failures: Number of failures before hard-stopping.
    """

    workspace_dir: str
    plan_filename: str = "PLAN.md"
    state_filename: str = "STATE.md"
    soul_filename: str = "SOUL.md"
    auto_commit: bool = True
    max_consecutive_failures: int = 1
