"""
base.py — Abstract base class for all injectable tools.

Tools are the capabilities that get dynamically injected into EphemeralWorkers.
Each tool must declare its name, description (for the LLM), and provide
an async execute method.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseTool(ABC):
    """Abstract interface for tools injectable into EphemeralWorkers.

    Subclasses must implement:
        - name (property): A short, unique identifier (e.g. "vertex_knowledge").
        - description (property): A human-readable description for the LLM.
        - execute(**kwargs): The async execution logic.

    Example:
        class MyTool(BaseTool):
            @property
            def name(self) -> str:
                return "my_tool"

            @property
            def description(self) -> str:
                return "Does something useful."

            async def execute(self, **kwargs) -> dict[str, Any]:
                return {"result": "done"}
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the unique tool identifier."""
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        """Return a human-readable description for the LLM system prompt."""
        ...

    @abstractmethod
    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        """Execute the tool with the given keyword arguments.

        Args:
            **kwargs: Tool-specific parameters.

        Returns:
            A dictionary containing the tool execution results.

        Raises:
            ToolExecutionError: If the tool fails to execute.
        """
        ...

    def to_prompt_schema(self) -> dict[str, str]:
        """Serialize this tool's metadata for injection into an LLM prompt.

        Returns:
            A dictionary with 'name' and 'description' keys.
        """
        return {
            "name": self.name,
            "description": self.description,
        }

    def __repr__(self) -> str:
        return f"<Tool:{self.name}>"
