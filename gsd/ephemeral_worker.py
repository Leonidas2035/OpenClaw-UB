"""
ephemeral_worker.py — Layer 3: Isolated Task Executor.

Each EphemeralWorker is a short-lived, stateless execution unit.
It receives ONLY the task + relevant files + tools, executes via
a clean LLM session, returns a result, and is garbage-collected.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Sequence

import aiofiles

from gsd.models import WorkerResult
from gsd.tools.base import BaseTool

logger = logging.getLogger(__name__)


class EphemeralWorker:
    """An isolated, single-use worker that executes exactly one task.

    After execute() returns, discard this instance.
    """

    def __init__(
        self,
        task_description: str,
        relevant_files: Sequence[str | Path] | None = None,
        tools: Sequence[BaseTool] | None = None,
        system_prompt: str = "",
    ) -> None:
        self.worker_id: str = f"worker-{uuid.uuid4().hex[:8]}"
        self.task_description = task_description
        self.relevant_files: list[Path] = [Path(f) for f in (relevant_files or [])]
        self.tools: list[BaseTool] = list(tools or [])
        self.system_prompt = system_prompt
        logger.info("Worker %s created for: %.60s", self.worker_id, task_description)

    async def execute(self) -> WorkerResult:
        """Execute the task in an isolated LLM session."""
        start = time.monotonic()
        try:
            ctx = await self._read_context_files()
            prompt = self._build_prompt(ctx)
            response = await self._call_llm(prompt)
            ok, msg = self._parse_response(response)
            dur = time.monotonic() - start
            return WorkerResult(success=ok, message=msg, worker_id=self.worker_id, duration_seconds=dur)
        except Exception as exc:
            dur = time.monotonic() - start
            return WorkerResult(success=False, message=f"{type(exc).__name__}: {exc}", worker_id=self.worker_id, duration_seconds=dur)

    async def _read_context_files(self) -> dict[str, str]:
        contexts: dict[str, str] = {}
        for fp in self.relevant_files:
            try:
                async with aiofiles.open(fp, "r", encoding="utf-8") as f:
                    contexts[str(fp)] = await f.read()
            except (FileNotFoundError, PermissionError, OSError) as e:
                logger.warning("Worker %s skip %s: %s", self.worker_id, fp, e)
        return contexts

    def _build_prompt(self, file_contexts: dict[str, str]) -> str:
        parts: list[str] = []
        if self.system_prompt:
            parts.append(f"[SYSTEM]\n{self.system_prompt}\n[/SYSTEM]")
        if self.tools:
            descs = "\n".join(f"  - {t.name}: {t.description}" for t in self.tools)
            parts.append(f"[TOOLS]\n{descs}\n[/TOOLS]")
        if file_contexts:
            blocks = [f"--- {fp} ---\n{c}\n---" for fp, c in file_contexts.items()]
            parts.append("[CONTEXT]\n" + "\n".join(blocks) + "\n[/CONTEXT]")
        parts.append(f"[TASK]\n{self.task_description}\n[/TASK]")
        return "\n\n".join(parts)

    async def _call_llm(self, prompt: str) -> str:
        """Call Gemini CLI via subprocess."""
        # Use cyberclaw instead of gemini directly to get memory/safety patch
        proc = await asyncio.create_subprocess_exec(
            "node", "/home/korben/.openclaw/cyberclaw.js", "-y", prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.error("LLM Call Failed: %s", stderr.decode())
            raise RuntimeError(f"cyberclaw/gemini failed: {stderr.decode()}")
        return stdout.decode()

    @staticmethod
    def _parse_response(response: str) -> tuple[bool, str]:
        lines = response.strip().splitlines()
        if not lines:
            return False, "Empty LLM response"
        if "TASK_COMPLETED" in lines[0].upper():
            msg = "task completed"
            for ln in lines[1:]:
                if ln.upper().startswith("COMMIT_MESSAGE:"):
                    msg = ln.split(":", 1)[1].strip()
            return True, msg
        if "TASK_FAILED" in lines[0].upper():
            err = "Unknown error"
            for ln in lines[1:]:
                if ln.upper().startswith("ERROR:"):
                    err = ln.split(":", 1)[1].strip()
            return False, err
        return False, f"Unparseable response: {lines[0]!r}"

    def __repr__(self) -> str:
        return f"<EphemeralWorker {self.worker_id} task={self.task_description[:40]!r}>"
