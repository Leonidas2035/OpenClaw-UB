"""
state_manager.py — Layer 1: File-System as Memory.

Async class that reads and writes Markdown files (PLAN.md, STATE.md)
as the single source of truth. No database, no in-memory accumulation —
only text on disk.

The parser understands GitHub-flavored Markdown task lists:
    - [ ] Pending task
    - [x] Completed task

And organizes them under optional phase headers (## Phase Name).
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import aiofiles

from gsd.models import Task, TaskStatus, WorkerResult


# ── Regex patterns for Markdown task list parsing ────────────────────────────
_TASK_PATTERN = re.compile(
    r"^(?P<indent>\s*)-\s*\[(?P<status>[xX ])\]\s+(?P<description>.+)$"
)
_PHASE_PATTERN = re.compile(r"^##\s+(?P<phase>.+)$")


class MarkdownStateManager:
    """Async manager for reading/writing Markdown-based agent state.

    This class is the **sole interface** between the orchestrator and the
    filesystem. It provides methods to:

    1. Parse PLAN.md into a structured list of Task objects.
    2. Find the next uncompleted task.
    3. Mark a task as completed (mutating PLAN.md in-place).
    4. Append structured logs to STATE.md (success or failure).

    Attributes:
        workspace_dir: Path to the workspace directory.
        plan_path: Resolved path to PLAN.md.
        state_path: Resolved path to STATE.md.

    Example:
        >>> manager = MarkdownStateManager("/home/user/.openclaw/workspace")
        >>> task = await manager.get_next_task()
        >>> if task:
        ...     await manager.complete_task(task)
    """

    def __init__(
        self,
        workspace_dir: str | Path,
        plan_filename: str = "PLAN.md",
        state_filename: str = "STATE.md",
    ) -> None:
        """Initialize the MarkdownStateManager.

        Args:
            workspace_dir: Absolute path to the workspace root.
            plan_filename: Filename of the plan file. Defaults to "PLAN.md".
            state_filename: Filename of the state journal. Defaults to "STATE.md".

        Raises:
            FileNotFoundError: If workspace_dir does not exist.
        """
        self.workspace_dir = Path(workspace_dir).resolve()
        if not self.workspace_dir.is_dir():
            raise FileNotFoundError(
                f"Workspace directory not found: {self.workspace_dir}"
            )

        self.plan_path: Path = self.workspace_dir / plan_filename
        self.state_path: Path = self.workspace_dir / state_filename

    # ── Public API ───────────────────────────────────────────────────────────

    async def parse_plan(self) -> list[Task]:
        """Parse PLAN.md and return all tasks (pending and completed).

        Reads the entire PLAN.md file, extracts task items from GitHub-flavored
        Markdown checkboxes, and associates each task with its enclosing
        phase header (## ...) if one exists.

        Returns:
            A list of Task dataclass instances, ordered by their appearance
            in the file.

        Raises:
            FileNotFoundError: If PLAN.md does not exist at the expected path.
        """
        if not self.plan_path.exists():
            raise FileNotFoundError(
                f"Plan file not found: {self.plan_path}. "
                "Create a PLAN.md with task checkboxes to begin."
            )

        content = await self._read_file(self.plan_path)
        return self._extract_tasks(content)

    async def get_next_task(self) -> Task | None:
        """Return the first pending (uncompleted) task from PLAN.md.

        Scans PLAN.md top-to-bottom and returns the first task with
        status ``TaskStatus.PENDING``. Returns None if all tasks are
        completed or PLAN.md contains no tasks.

        Returns:
            The next pending Task, or None if the plan is fully completed.
        """
        tasks = await self.parse_plan()
        for task in tasks:
            if task.is_pending:
                return task
        return None

    async def get_all_pending_tasks(self) -> list[Task]:
        """Return all pending (uncompleted) tasks from PLAN.md.

        Returns:
            A list of all Task objects with PENDING status.
        """
        tasks = await self.parse_plan()
        return [t for t in tasks if t.is_pending]

    async def complete_task(self, task: Task) -> None:
        """Mark a specific task as completed in PLAN.md.

        Performs an in-place line replacement: changes ``- [ ]`` to ``- [x]``
        at the exact line_number of the given task.

        Args:
            task: The Task object to mark as completed. Must have a valid
                  line_number pointing to its position in PLAN.md.

        Raises:
            FileNotFoundError: If PLAN.md does not exist.
            ValueError: If the line at task.line_number does not contain
                        the expected checkbox pattern.
        """
        content = await self._read_file(self.plan_path)
        lines = content.splitlines()

        # Validate line_number bounds (1-indexed)
        idx = task.line_number - 1
        if idx < 0 or idx >= len(lines):
            raise ValueError(
                f"Task line_number {task.line_number} is out of bounds "
                f"(file has {len(lines)} lines)."
            )

        line = lines[idx]
        match = _TASK_PATTERN.match(line)
        if not match:
            raise ValueError(
                f"Line {task.line_number} does not contain a valid task checkbox: "
                f"{line!r}"
            )

        # Replace [ ] with [x], preserving original indentation and description
        lines[idx] = re.sub(r"\[\s\]", "[x]", line, count=1)

        await self._write_file(self.plan_path, "\n".join(lines) + "\n")

    async def log_success(
        self,
        task: Task,
        result: WorkerResult,
    ) -> None:
        """Append a success entry to STATE.md.

        Creates STATE.md if it doesn't exist. Each entry includes timestamp,
        worker ID, duration, commit message, and any artifacts produced.

        Args:
            task: The completed task.
            result: The WorkerResult with execution details.
        """
        now = datetime.now(timezone.utc).isoformat()
        entry_lines = [
            f"#### ✅ [{now}] {task.description}",
            f"- **Worker ID:** {result.worker_id}",
            f"- **Duration:** {result.duration_seconds:.1f}s",
            f"- **Commit:** `{result.message}`",
        ]
        if result.artifacts:
            artifacts_str = ", ".join(f"`{a}`" for a in result.artifacts)
            entry_lines.append(f"- **Artifacts:** {artifacts_str}")

        entry_lines.append("")  # Blank line separator
        await self._append_to_state("\n".join(entry_lines))

    async def log_failure(
        self,
        task: Task,
        result: WorkerResult,
    ) -> None:
        """Append a failure/blocker entry to STATE.md.

        Records the error details and marks the state as HALTED_FOR_REVIEW
        so a human operator knows intervention is needed.

        Args:
            task: The task that failed.
            result: The WorkerResult with error details.
        """
        now = datetime.now(timezone.utc).isoformat()
        entry_lines = [
            f"#### ❌ [{now}] {task.description}",
            f"- **Worker ID:** {result.worker_id}",
            f"- **Duration:** {result.duration_seconds:.1f}s",
            f"- **Blocker:** {result.message}",
            f"- **Status:** HALTED_FOR_REVIEW",
            "",
        ]
        await self._append_to_state("\n".join(entry_lines))
        await self._update_state_status("HALTED_FOR_REVIEW")

    async def get_progress_summary(self) -> dict[str, int]:
        """Return a summary of plan progress.

        Returns:
            A dict with keys 'total', 'completed', 'pending'.
        """
        tasks = await self.parse_plan()
        completed = sum(1 for t in tasks if not t.is_pending)
        pending = sum(1 for t in tasks if t.is_pending)
        return {
            "total": len(tasks),
            "completed": completed,
            "pending": pending,
        }

    # ── Internal helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _extract_tasks(content: str) -> list[Task]:
        """Parse raw Markdown content into a list of Task objects.

        Args:
            content: The full text content of a Markdown file.

        Returns:
            Ordered list of Task objects.
        """
        tasks: list[Task] = []
        current_phase = ""

        for line_num, line in enumerate(content.splitlines(), start=1):
            # Check for phase headers
            phase_match = _PHASE_PATTERN.match(line)
            if phase_match:
                current_phase = phase_match.group("phase").strip()
                continue

            # Check for task checkboxes
            task_match = _TASK_PATTERN.match(line)
            if task_match:
                status_char = task_match.group("status")
                status = (
                    TaskStatus.COMPLETED
                    if status_char.lower() == "x"
                    else TaskStatus.PENDING
                )
                description = task_match.group("description").strip()

                tasks.append(
                    Task(
                        description=description,
                        status=status,
                        line_number=line_num,
                        phase=current_phase,
                    )
                )

        return tasks

    async def _append_to_state(self, entry: str) -> None:
        """Append text to STATE.md, creating it with a header if needed.

        Args:
            entry: The Markdown text block to append.
        """
        if not self.state_path.exists():
            header = (
                "# 📊 Operational State\n\n"
                "## Current Status: IN_PROGRESS\n"
                f"## Last Updated: {datetime.now(timezone.utc).isoformat()}\n\n"
                "---\n\n"
                "### Task Log\n\n"
            )
            await self._write_file(self.state_path, header)

        existing = await self._read_file(self.state_path)
        updated = existing.rstrip() + "\n\n" + entry
        await self._write_file(self.state_path, updated + "\n")

    async def _update_state_status(self, new_status: str) -> None:
        """Update the 'Current Status' line in STATE.md.

        Args:
            new_status: The new status string (e.g. "HALTED_FOR_REVIEW").
        """
        if not self.state_path.exists():
            return

        content = await self._read_file(self.state_path)
        updated = re.sub(
            r"^(## Current Status:)\s*.*$",
            f"\\1 {new_status}",
            content,
            count=1,
            flags=re.MULTILINE,
        )
        now = datetime.now(timezone.utc).isoformat()
        updated = re.sub(
            r"^(## Last Updated:)\s*.*$",
            f"\\1 {now}",
            updated,
            count=1,
            flags=re.MULTILINE,
        )
        await self._write_file(self.state_path, updated)

    @staticmethod
    async def _read_file(path: Path) -> str:
        """Read a file asynchronously.

        Args:
            path: Path to the file.

        Returns:
            The file content as a string.
        """
        async with aiofiles.open(path, mode="r", encoding="utf-8") as f:
            return await f.read()

    @staticmethod
    async def _write_file(path: Path, content: str) -> None:
        """Write content to a file asynchronously (full overwrite).

        Args:
            path: Path to the file.
            content: The string content to write.
        """
        async with aiofiles.open(path, mode="w", encoding="utf-8") as f:
            await f.write(content)
