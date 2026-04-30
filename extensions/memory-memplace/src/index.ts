/**
 * @openclaw/memory-memplace — MemPlace MCP Client Plugin
 *
 * Виступає клієнтом MCP-сервера MemPlace та транслює його інструменти
 * в екосистему агента OpenClaw.
 *
 * Node.js ≥ 24.3 | TypeScript ESM (NodeNext)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";

// ─── OpenClaw Plugin SDK types ─────────────────────────────────────────────
// До появи офіційного @openclaw/plugin-sdk оголошуємо мінімальні ambient-типи.
// Замінити на: import type { PluginContext, MemoryProvider } from "@openclaw/plugin-sdk";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
}

export interface EventEmitter {
  on(event: string, listener: (payload: unknown) => Promise<void> | void): void;
  off(event: string, listener: (payload: unknown) => Promise<void> | void): void;
}

export interface PreCompactEventPayload {
  transcript: string;
  tokenCount: number;
  sessionId: string;
}

export interface PluginConfig {
  mcpPath: string;
  autoRecall: boolean;
  autoCapture: boolean;
  topK?: number;
  connectionTimeoutMs?: number;
}

export interface PluginContext {
  config: PluginConfig;
  logger: Logger;
  tools: ToolRegistry;
  events: EventEmitter;
}

export interface MemoryProvider {
  activate(): Promise<void>;
  deactivate(): Promise<void>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Витягує текст з першого TextContent-блоку результату MCP-виклику.
 * Повертає порожній рядок, якщо відповідь не містить текстових блоків.
 */
function extractText(result: CallToolResult): string {
  if (!Array.isArray(result.content) || result.content.length === 0) {
    return "";
  }
  const first = result.content[0];
  if (first === undefined) return "";
  if ((first as TextContent).type === "text") {
    return (first as TextContent).text;
  }
  return "";
}

/**
 * Перевіряє, що аргумент є непустим рядком.
 */
function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Параметр "${fieldName}" має бути непустим рядком.`);
  }
  return value;
}

/**
 * Перетворює невідоме значення на масив рядків (теги).
 */
function coerceTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  }
  return [];
}

// ─── Main Plugin Class ─────────────────────────────────────────────────────

export class MemPlacePlugin implements MemoryProvider {
  readonly #ctx: PluginContext;
  readonly #mcpClient: Client;
  readonly #transport: StdioClientTransport;
  #connected = false;

  constructor(ctx: PluginContext) {
    this.#ctx = ctx;

    const mcpPath = ctx.config.mcpPath;
    if (!mcpPath || mcpPath.trim().length === 0) {
      throw new Error(
        "[memory-memplace] config.mcpPath є обов'язковим та не може бути порожнім."
      );
    }

    this.#mcpClient = new Client(
      { name: "openclaw-memory-memplace", version: "0.1.0" },
      // ClientCapabilities has no top-level 'tools'; capabilities defaults are fine empty
      { capabilities: {} }
    );

    this.#transport = new StdioClientTransport({
      command: mcpPath,
      args: ["mcp"],
      env: {
        ...process.env,
        // Гарантуємо UTF-8 на всіх платформах
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      } as Record<string, string>,
    });
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(): Promise<void> {
    const logger = this.#ctx.logger;
    const timeoutMs = this.#ctx.config.connectionTimeoutMs ?? 10_000;

    logger.info("[memory-memplace] Підключення до MCP-сервера MemPlace...", {
      mcpPath: this.#ctx.config.mcpPath,
      timeoutMs,
    });

    // Підключення з таймаутом
    await Promise.race([
      this.#mcpClient.connect(this.#transport),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[memory-memplace] Таймаут підключення MCP після ${timeoutMs}мс`
              )
            ),
          timeoutMs
        )
      ),
    ]);

    this.#connected = true;
    logger.info("[memory-memplace] MCP-сервер успішно підключено.");

    this.#registerTools();
    this.#registerHooks();

    logger.info(
      "[memory-memplace] Плагін активовано. " +
        `autoRecall=${this.#ctx.config.autoRecall}, ` +
        `autoCapture=${this.#ctx.config.autoCapture}`
    );
  }

  // ── deactivate ────────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    if (this.#connected) {
      try {
        await this.#mcpClient.close();
        this.#connected = false;
        this.#ctx.logger.info("[memory-memplace] MCP-з'єднання закрито.");
      } catch (err: unknown) {
        this.#ctx.logger.warn(
          "[memory-memplace] Помилка під час закриття MCP-з'єднання:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // ── Private: tool registration ────────────────────────────────────────────

  #registerTools(): void {
    const tools = this.#ctx.tools;

    // ── memory_search ──────────────────────────────────────────────────────
    tools.register({
      name: "memory_search",
      description:
        "Семантичний пошук у пам'яті MemPlace. Повертає найрелевантніші спогади за запитом.",
      parameters: [
        {
          name: "query",
          type: "string",
          description: "Пошуковий запит природною мовою",
          required: true,
        },
        {
          name: "topK",
          type: "number",
          description: "Кількість результатів для повернення (за замовч. 5)",
          required: false,
        },
      ],
      handler: async (args: Record<string, unknown>): Promise<unknown> => {
        const query = assertString(args["query"], "query");
        const topK =
          typeof args["topK"] === "number" && args["topK"] > 0
            ? Math.floor(args["topK"])
            : (this.#ctx.config.topK ?? 5);

        return this.#callTool("search", { query, top_k: topK });
      },
    });

    // ── memory_add ─────────────────────────────────────────────────────────
    tools.register({
      name: "memory_add",
      description:
        "Додає новий запис до семантичної пам'яті MemPlace (drawer).",
      parameters: [
        {
          name: "content",
          type: "string",
          description: "Текст для збереження у пам'яті",
          required: true,
        },
        {
          name: "tags",
          type: "array",
          description: "Масив тегів для категоризації запису",
          required: false,
        },
      ],
      handler: async (args: Record<string, unknown>): Promise<unknown> => {
        const content = assertString(args["content"], "content");
        const tags = coerceTags(args["tags"]);

        return this.#callTool("mempalace_add_drawer", {
          content,
          tags,
        });
      },
    });

    // ── memory_status ──────────────────────────────────────────────────────
    tools.register({
      name: "memory_status",
      description:
        "Перевіряє стан палацу пам'яті MemPlace: кількість записів, здоров'я індексу тощо.",
      parameters: [],
      handler: async (_args: Record<string, unknown>): Promise<unknown> => {
        return this.#callTool("status", {});
      },
    });
  }

  // ── Private: hook registration ────────────────────────────────────────────

  #registerHooks(): void {
    this.#ctx.events.on(
      "context:pre-compact",
      async (payload: unknown): Promise<void> => {
        if (!this.#ctx.config.autoCapture) return;

        const logger = this.#ctx.logger;

        // Безпечне звуження типу
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("transcript" in payload)
        ) {
          logger.warn(
            "[memory-memplace] context:pre-compact: невалідний payload, пропускаємо capture."
          );
          return;
        }

        const event = payload as PreCompactEventPayload;

        if (typeof event.transcript !== "string" || event.transcript.trim().length === 0) {
          logger.debug(
            "[memory-memplace] context:pre-compact: порожній транскрипт, пропускаємо."
          );
          return;
        }

        logger.info(
          `[memory-memplace] context:pre-compact: захоплення транскрипту (${event.transcript.length} символів) до MemPlace diary...`
        );

        await this.#flushToDiary(event.transcript, event.sessionId);
      }
    );
  }

  // ── Private: flush to diary ───────────────────────────────────────────────

  async #flushToDiary(transcript: string, sessionId?: string): Promise<void> {
    const logger = this.#ctx.logger;

    const entry = [
      `session_id: ${sessionId ?? "unknown"}`,
      `timestamp: ${new Date().toISOString()}`,
      `---`,
      transcript,
    ].join("\n");

    try {
      const result = await this.#callTool("diary_write", { entry });
      logger.info("[memory-memplace] diary_write: успішно збережено.", result);
    } catch (err: unknown) {
      // Не кидаємо далі — невдача diary не повинна переривати compact
      logger.error(
        "[memory-memplace] diary_write: помилка під час збереження:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── Private: MCP tool caller ──────────────────────────────────────────────

  async #callTool(
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<string> {
    if (!this.#connected) {
      throw new Error(
        `[memory-memplace] Спроба викликати MCP-інструмент "${toolName}" до підключення.`
      );
    }

    let result: CallToolResult;

    try {
      // Cast via unknown to bridge the CompatibilityCallToolResult union in SDK v1.9
      result = (await this.#mcpClient.callTool(
        { name: toolName, arguments: toolArgs }
      )) as unknown as CallToolResult;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#ctx.logger.error(
        `[memory-memplace] MCP callTool("${toolName}") завершився з помилкою: ${msg}`
      );
      throw new Error(
        `[memory-memplace] Виклик MCP-інструменту "${toolName}" невдалий: ${msg}`
      );
    }

    if (result.isError === true) {
      const errText = extractText(result);
      this.#ctx.logger.error(
        `[memory-memplace] MCP "${toolName}" повернув isError=true: ${errText}`
      );
      throw new Error(
        `[memory-memplace] MCP-інструмент "${toolName}" повернув помилку: ${errText}`
      );
    }

    return extractText(result);
  }
}

// ─── Default export: plugin factory ────────────────────────────────────────

export default async function initMemPlacePlugin(
  ctx: PluginContext
): Promise<MemoryProvider> {
  const plugin = new MemPlacePlugin(ctx);
  await plugin.activate();
  return plugin;
}
