"""
orchestrator.py — Layer 2: Main Event Loop (Wave-Based).

The orchestrator NEVER writes code. Its sole responsibilities:
1. Query the GSD phase-plan-index (via gsd-sdk) to get the waves.
2. Group plans by dependency wave.
3. Spawn an EphemeralWorker for each plan (in sequence/parallel depending on config).
4. Run the Worker using GSD Original's execute-plan.md template.
5. Apply deviation rules & verification.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import subprocess
from pathlib import Path

from gsd.ephemeral_worker import EphemeralWorker
from gsd.models import OrchestratorConfig, WorkerResult
from gsd.tools.base import BaseTool

logger = logging.getLogger("gsd.orchestrator")


async def _git_commit(workspace: Path, message: str) -> bool:
    try:
        proc_add = await asyncio.create_subprocess_exec(
            "git", "add", "-A",
            cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc_add.communicate()

        proc_commit = await asyncio.create_subprocess_exec(
            "git", "commit", "-m", message, "--allow-empty",
            cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc_commit.communicate()

        if proc_commit.returncode == 0:
            logger.info("Git commit OK: %s", message)
            return True
        else:
            logger.warning("Git commit failed: %s", stderr.decode().strip())
            return False
    except FileNotFoundError:
        return False


def _run_sdk(cmd: list[str], cwd: str) -> dict:
    """Run gsd-sdk query and return parsed JSON."""
    full_cmd = ["/home/korben/.openclaw/get-shit-done/bin/gsd-sdk", "query"] + cmd
    try:
        res = subprocess.run(full_cmd, cwd=cwd, capture_output=True, text=True, check=True)
        return json.loads(res.stdout)
    except subprocess.CalledProcessError as e:
        logger.error(f"gsd-sdk failed: {e.stderr}")
        return {}
    except json.JSONDecodeError:
        return {}


async def _load_file(path: Path) -> str:
    if not path.exists():
        return ""
    import aiofiles
    async with aiofiles.open(path, "r", encoding="utf-8") as f:
        return await f.read()


async def run_agent_loop(
    workspace_dir: str,
    phase: str = "1",
    config: OrchestratorConfig | None = None,
) -> None:
    """Wave-based orchestration loop using GSD Original specs."""
    workspace = Path(workspace_dir).resolve()
    if config is None:
        config = OrchestratorConfig(workspace_dir=str(workspace))

    logger.info("🚀 GSD Orchestrator (Wave-Based) started | Phase: %s", phase)

    # 1. Start Phase
    _run_sdk(["state.begin-phase", "--phase", phase, "--name", "Execution", "--plans", "1"], cwd=str(workspace))

    # 2. Get Plan Index
    index = _run_sdk(["phase-plan-index", phase], cwd=str(workspace))
    if not index or "error" in index or not index.get("plans"):
        logger.info("✅ No incomplete plans found or phase not found.")
        return

    waves = index.get("waves", {})
    incomplete = set(index.get("incomplete", []))

    logger.info("📊 Found %d waves. Incomplete plans: %s", len(waves), incomplete)

    # Load the base GSD execution prompt
    gsd_framework = Path("/home/korben/.openclaw/get-shit-done")
    executor_prompt = await _load_file(gsd_framework / "workflows" / "execute-plan.md")
    soul = await _load_file(workspace / "OPENCLAW.md")

    # 3. Execute Waves
    for wave_id in sorted(waves.keys(), key=int):
        plans_in_wave = waves[wave_id]
        logger.info("🌊 Starting Wave %s with %d plans: %s", wave_id, len(plans_in_wave), plans_in_wave)

        for plan_id in plans_in_wave:
            if plan_id not in incomplete:
                logger.info("⏭️  Skipping plan %s (already has SUMMARY.md)", plan_id)
                continue

            logger.info("📋 Executing Plan: %s", plan_id)

            # Get the exact plan file path
            plan_file = next(workspace.glob(f".planning/phases/{phase.zfill(2)}-*/{plan_id}-PLAN.md"), None)
            if not plan_file:
                logger.error("Plan file not found for %s", plan_id)
                continue

            task_desc = f"Execute GSD Plan {plan_id} from {plan_file.name}. Output a SUMMARY.md."
            
            # Combine the GSD logic with the worker system prompt
            system_prompt = f"{soul}\n\n[GSD ORCHESTRATOR PROMPT]\n{executor_prompt}"

            worker = EphemeralWorker(
                task_description=task_desc,
                relevant_files=[plan_file],
                system_prompt=system_prompt,
            )

            result: WorkerResult = await worker.execute()

            if result.success:
                logger.info("✅ Plan %s completed in %.1fs", plan_id, result.duration_seconds)
                # Auto commit
                await _git_commit(workspace, f"feat({phase.zfill(2)}-{plan_id}): completed plan")
                # Advance state
                _run_sdk(["state.advance-plan"], cwd=str(workspace))
                _run_sdk(["state.update-progress"], cwd=str(workspace))
            else:
                logger.error("❌ Plan %s FAILED: %s", plan_id, result.message)
                _run_sdk(["state.add-blocker", f"Plan {plan_id} failed: {result.message}"], cwd=str(workspace))
                logger.critical("🛑 Halting execution for human review.")
                sys.exit(1)

    logger.info("🎉 All waves completed for Phase %s!", phase)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if len(sys.argv) < 2:
        print("Usage: python -m gsd.orchestrator <workspace_dir> [phase]")
        sys.exit(1)

    workspace = sys.argv[1]
    phase = sys.argv[2] if len(sys.argv) > 2 else "1"
    
    asyncio.run(run_agent_loop(workspace, phase))


if __name__ == "__main__":
    main()
