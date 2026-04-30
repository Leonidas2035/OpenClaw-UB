/**
 * @openclaw/gsd-bridge — GSD Planning Bridge Plugin
 *
 * Синхронізує стан GSD-планувальника (.planning/STATE.md) з виконавчою
 * чергою OpenClaw (LOOP-QUEUE.md). Реєструє інструменти для планування
 * фаз та управління чергою завдань.
 *
 * Node.js ≥ 24.3 | TypeScript ESM (NodeNext)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ─── OpenClaw Plugin SDK ambient types ─────────────────────────────────────

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
  on(
    event: string,
    listener: (payload: unknown) => Promise<void> | void
  ): void;
  off(
    event: string,
    listener: (payload: unknown) => Promise<void> | void
  ): void;
}

export interface ChatMessagePayload {
  text: string;
  channelId: string;
  senderId: string;
}

export interface GsdBridgeConfig {
  projectRoot: string;
  syncIntervalMs: number;
  gsdBinary?: string;
  maxQueueSize?: number;
}

export interface PluginContext {
  config: GsdBridgeConfig;
  logger: Logger;
  tools: ToolRegistry;
  events: EventEmitter;
}

// ─── GSD task model ────────────────────────────────────────────────────────

interface GsdTask {
  id: string;
  description: string;
  rawLine: string;
}

interface QueueEntry {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  description: string;
  addedAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Pattern for GSD TODO items:
 *   - [ ] (GSD-TODO-abc123): Description of the task
 */
const GSD_TODO_PATTERN =
  /^- \[ \] \(GSD-TODO-([a-zA-Z0-9-]+)\): (.+)$/gm;

/**
 * Pattern to extract existing queue entry IDs from LOOP-QUEUE.md
 */
const QUEUE_ID_PATTERN = /\(GSD-TODO-([a-zA-Z0-9-]+)\)/g;

/**
 * Formats a queue entry as a Markdown checklist line
 */
function formatQueueLine(entry: QueueEntry): string {
  const checkbox =
    entry.status === "done"
      ? "[x]"
      : entry.status === "running"
        ? "[/]"
        : entry.status === "failed"
          ? "[!]"
          : "[ ]";
  return `- ${checkbox} (GSD-TODO-${entry.id}): ${entry.description} <!-- added:${entry.addedAt} -->`;
}

/**
 * Safely read a text file; returns empty string if missing.
 */
function safeReadFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Ensure a directory exists, creating parents as needed.
 */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Spawns a child process and captures stdout+stderr.
 * Returns a promise that resolves with combined output.
 */
function runProcess(
  command: string,
  args: string[],
  cwd: string
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reject(new Error(`Не вдалося запустити процес "${command}": ${msg}`));
      return;
    }

    if (child.stdout !== null) {
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk.toString("utf8"));
      });
    }

    if (child.stderr !== null) {
      child.stderr.on("data", (chunk: Buffer) => {
        chunks.push(chunk.toString("utf8"));
      });
    }

    child.on("error", (err: Error) => {
      reject(
        new Error(`Процес "${command}" завершився з помилкою: ${err.message}`)
      );
    });

    child.on("close", (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        output: chunks.join(""),
      });
    });
  });
}

// ─── Main Plugin Class ─────────────────────────────────────────────────────

export class GsdBridgePlugin {
  readonly #ctx: PluginContext;
  readonly #planningDir: string;
  readonly #statePath: string;
  readonly #loopQueuePath: string;
  readonly #loopInboxPath: string;
  readonly #openclawDir: string;
  readonly #gsdBinary: string;
  readonly #maxQueueSize: number;
  #syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: PluginContext) {
    this.#ctx = ctx;

    const projectRoot = ctx.config.projectRoot;
    if (!projectRoot || projectRoot.trim().length === 0) {
      throw new Error(
        "[gsd-bridge] config.projectRoot є обов'язковим та не може бути порожнім."
      );
    }

    this.#planningDir = join(projectRoot, ".planning");
    this.#statePath = join(this.#planningDir, "STATE.md");
    this.#openclawDir = join(projectRoot, ".openclaw");
    this.#loopQueuePath = join(this.#openclawDir, "LOOP-QUEUE.md");
    this.#loopInboxPath = join(this.#openclawDir, "LOOP-INBOX.md");
    this.#gsdBinary = ctx.config.gsdBinary ?? "get-shit-done-cc";
    this.#maxQueueSize = ctx.config.maxQueueSize ?? 50;
  }

  // ── activate ──────────────────────────────────────────────────────────────

  async activate(): Promise<void> {
    const logger = this.#ctx.logger;

    logger.info("[gsd-bridge] Активація плагіна...", {
      planningDir: this.#planningDir,
      loopQueuePath: this.#loopQueuePath,
    });

    // Ensure directory structure
    ensureDir(this.#planningDir);
    ensureDir(this.#openclawDir);

    // Bootstrap LOOP-QUEUE.md if absent
    if (!existsSync(this.#loopQueuePath)) {
      const header = [
        "# LOOP-QUEUE",
        "",
        "> Черга виконання для RalphClaw. Автоматично синхронізується з GSD STATE.md.",
        "> Формат: `- [ ] (GSD-TODO-<id>): <опис>`",
        "",
        "---",
        "",
      ].join("\n");
      writeFileSync(this.#loopQueuePath, header, "utf8");
      logger.info("[gsd-bridge] Створено LOOP-QUEUE.md");
    }

    // Bootstrap LOOP-INBOX.md if absent
    if (!existsSync(this.#loopInboxPath)) {
      const header = [
        "# LOOP-INBOX",
        "",
        "> Вхідні повідомлення та результати виконання завдань.",
        "",
        "---",
        "",
      ].join("\n");
      writeFileSync(this.#loopInboxPath, header, "utf8");
      logger.info("[gsd-bridge] Створено LOOP-INBOX.md");
    }

    // Register tools and hooks
    this.#registerTools();
    this.#registerChatHandler();

    // Initial sync
    try {
      const syncResult = this.syncGsdToQueue();
      logger.info(
        `[gsd-bridge] Початкова синхронізація: додано ${syncResult.added} завдань.`
      );
    } catch (err: unknown) {
      logger.warn(
        "[gsd-bridge] Початкова синхронізація не вдалася (STATE.md може не існувати):",
        err instanceof Error ? err.message : String(err)
      );
    }

    // Start periodic sync
    const intervalMs = this.#ctx.config.syncIntervalMs;
    if (intervalMs > 0) {
      this.#syncTimer = setInterval(() => {
        try {
          const result = this.syncGsdToQueue();
          if (result.added > 0) {
            logger.info(
              `[gsd-bridge] Періодична синхронізація: додано ${result.added} завдань.`
            );
          } else {
            logger.debug("[gsd-bridge] Періодична синхронізація: без змін.");
          }
        } catch (err: unknown) {
          logger.error(
            "[gsd-bridge] Помилка періодичної синхронізації:",
            err instanceof Error ? err.message : String(err)
          );
        }
      }, intervalMs);

      // Prevent timer from keeping Node.js process alive
      if (typeof this.#syncTimer === "object" && "unref" in this.#syncTimer) {
        this.#syncTimer.unref();
      }

      logger.info(
        `[gsd-bridge] Періодична синхронізація запущена: кожні ${intervalMs}мс.`
      );
    }

    logger.info("[gsd-bridge] Плагін активовано успішно.");
  }

  // ── deactivate ────────────────────────────────────────────────────────────

  async deactivate(): Promise<void> {
    if (this.#syncTimer !== null) {
      clearInterval(this.#syncTimer);
      this.#syncTimer = null;
      this.#ctx.logger.info("[gsd-bridge] Періодична синхронізація зупинена.");
    }
  }

  // ── syncGsdToQueue — deterministic bridge ─────────────────────────────────

  syncGsdToQueue(): { added: number; total: number } {
    // Step 1: Read STATE.md
    const stateContent = safeReadFile(this.#statePath);
    if (stateContent.length === 0) {
      this.#ctx.logger.debug(
        "[gsd-bridge] STATE.md порожній або відсутній. Пропускаємо синхронізацію."
      );
      return { added: 0, total: 0 };
    }

    // Step 2: Parse GSD tasks via regex
    const gsdTasks: GsdTask[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state (global regex is stateful)
    const pattern = new RegExp(GSD_TODO_PATTERN.source, "gm");

    while ((match = pattern.exec(stateContent)) !== null) {
      const id = match[1];
      const description = match[2];
      if (id !== undefined && description !== undefined) {
        gsdTasks.push({
          id,
          description: description.trim(),
          rawLine: match[0],
        });
      }
    }

    if (gsdTasks.length === 0) {
      this.#ctx.logger.debug(
        "[gsd-bridge] Жодних GSD-TODO завдань не знайдено в STATE.md."
      );
      return { added: 0, total: 0 };
    }

    // Step 3: Read current queue
    const queueContent = safeReadFile(this.#loopQueuePath);

    // Collect existing IDs for idempotency check
    const existingIds = new Set<string>();
    let queueIdMatch: RegExpExecArray | null;
    const queueIdRegex = new RegExp(QUEUE_ID_PATTERN.source, "g");
    while ((queueIdMatch = queueIdRegex.exec(queueContent)) !== null) {
      const existingId = queueIdMatch[1];
      if (existingId !== undefined) {
        existingIds.add(existingId);
      }
    }

    // Step 4: Determine new tasks, respecting maxQueueSize
    const currentCount = existingIds.size;
    const budgetRemaining = Math.max(0, this.#maxQueueSize - currentCount);
    const newTasks = gsdTasks.filter((t) => !existingIds.has(t.id));
    const tasksToAdd = newTasks.slice(0, budgetRemaining);

    if (tasksToAdd.length === 0) {
      return { added: 0, total: currentCount };
    }

    // Step 5: Append new lines to queue
    const timestamp = new Date().toISOString();
    const newLines = tasksToAdd.map((task) =>
      formatQueueLine({
        id: task.id,
        status: "pending",
        description: task.description,
        addedAt: timestamp,
      })
    );

    // Ensure file ends with newline before appending
    const normalizedQueue = queueContent.endsWith("\n")
      ? queueContent
      : queueContent + "\n";
    const updatedQueue = normalizedQueue + newLines.join("\n") + "\n";

    writeFileSync(this.#loopQueuePath, updatedQueue, "utf8");

    this.#ctx.logger.info(
      `[gsd-bridge] Синхронізація: додано ${tasksToAdd.length} завдань (всього: ${currentCount + tasksToAdd.length}).`
    );

    return {
      added: tasksToAdd.length,
      total: currentCount + tasksToAdd.length,
    };
  }

  // ── Private: tool registration ────────────────────────────────────────────

  #registerTools(): void {
    const tools = this.#ctx.tools;

    // ── gsd_plan_phase ─────────────────────────────────────────────────────
    tools.register({
      name: "gsd_plan_phase",
      description:
        "Запускає GSD-планування для вказаної фази. Генерує план, розбитий на атомарні кроки.",
      parameters: [
        {
          name: "phase_num",
          type: "number",
          description: "Номер фази для планування (наприклад, 1, 2, 3...)",
          required: true,
        },
      ],
      handler: async (args: Record<string, unknown>): Promise<unknown> => {
        const phaseNum = args["phase_num"];
        if (typeof phaseNum !== "number" || !Number.isInteger(phaseNum) || phaseNum < 1) {
          throw new TypeError(
            "[gsd-bridge] phase_num має бути цілим додатним числом."
          );
        }

        const phaseArg = `/gsd-plan-phase ${String(phaseNum)}`;
        this.#ctx.logger.info(
          `[gsd-bridge] Запуск планування фази ${phaseNum}...`
        );

        const { exitCode, output } = await runProcess(
          "npx",
          [this.#gsdBinary, phaseArg],
          this.#ctx.config.projectRoot
        );

        // After planning, trigger a sync to pick up new tasks
        try {
          this.syncGsdToQueue();
        } catch {
          // Non-critical — sync failure after planning is acceptable
        }

        return {
          success: exitCode === 0,
          exitCode,
          output: output.length > 0 ? output : "(порожній вивід)",
          message:
            exitCode === 0
              ? `Фаза ${phaseNum} спланована успішно.`
              : `Планування фази ${phaseNum} завершилося з кодом ${exitCode}.`,
        };
      },
    });

    // ── gsd_execute_queue ──────────────────────────────────────────────────
    tools.register({
      name: "gsd_execute_queue",
      description:
        "Знаходить наступне невиконане завдання з LOOP-QUEUE.md і повертає його для обробки агентом.",
      parameters: [],
      handler: async (_args: Record<string, unknown>): Promise<unknown> => {
        const queueContent = safeReadFile(this.#loopQueuePath);
        if (queueContent.length === 0) {
          return {
            hasTask: false,
            message: "LOOP-QUEUE.md порожній або не існує.",
          };
        }

        // Find the first pending (unchecked) task
        const lines = queueContent.split("\n");
        const pendingPattern = /^- \[ \] \(GSD-TODO-([a-zA-Z0-9-]+)\): (.+?)(?:\s*<!--.*-->)?$/;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          const match = pendingPattern.exec(line);
          if (match !== null) {
            const taskId = match[1];
            const taskDesc = match[2];

            if (taskId === undefined || taskDesc === undefined) continue;

            // Mark as running [/]
            const updatedLine = line.replace("- [ ]", "- [/]");
            lines[i] = updatedLine;
            writeFileSync(this.#loopQueuePath, lines.join("\n"), "utf8");

            this.#ctx.logger.info(
              `[gsd-bridge] Завдання GSD-TODO-${taskId} помічено як [/] (running).`
            );

            return {
              hasTask: true,
              taskId: `GSD-TODO-${taskId}`,
              description: taskDesc.trim(),
              instruction: `Виконай наступне завдання з черги: ${taskDesc.trim()}. Після завершення — запиши результат до LOOP-INBOX.md та поміти завдання як виконане [x].`,
              lineIndex: i,
            };
          }
        }

        return {
          hasTask: false,
          message: "Усі завдання в LOOP-QUEUE.md виконані або в процесі.",
        };
      },
    });

    // ── gsd_sync_now ──────────────────────────────────────────────────────
    tools.register({
      name: "gsd_sync_now",
      description:
        "Примусова синхронізація GSD STATE.md → LOOP-QUEUE.md (ідемпотентна).",
      parameters: [],
      handler: async (_args: Record<string, unknown>): Promise<unknown> => {
        try {
          const result = this.syncGsdToQueue();
          return {
            success: true,
            added: result.added,
            total: result.total,
            message:
              result.added > 0
                ? `Додано ${result.added} нових завдань. Всього в черзі: ${result.total}.`
                : "Нових завдань не знайдено. Черга актуальна.",
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: msg,
            message: `Синхронізація не вдалася: ${msg}`,
          };
        }
      },
    });
  }

  // ── Private: chat slash-command handler ───────────────────────────────────

  #registerChatHandler(): void {
    this.#ctx.events.on(
      "chat:message",
      async (payload: unknown): Promise<void> => {
        // Safely narrow the payload
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("text" in payload)
        ) {
          return;
        }

        const event = payload as ChatMessagePayload;
        const text = event.text.trim();

        // ── /gsd-new-project ─────────────────────────────────────────────
        if (text === "/gsd-new-project") {
          this.#ctx.logger.info(
            "[gsd-bridge] Slash-команда: /gsd-new-project отримана."
          );

          try {
            const { exitCode, output } = await runProcess(
              "npx",
              [this.#gsdBinary, "/gsd-new-project"],
              this.#ctx.config.projectRoot
            );

            if (exitCode === 0) {
              this.#ctx.logger.info(
                "[gsd-bridge] /gsd-new-project: артефакти згенеровано успішно."
              );

              // Sync new tasks from freshly created planning state
              try {
                this.syncGsdToQueue();
              } catch {
                // Non-critical
              }
            } else {
              this.#ctx.logger.error(
                `[gsd-bridge] /gsd-new-project: завершилось з кодом ${exitCode}`,
                output
              );
            }
          } catch (err: unknown) {
            this.#ctx.logger.error(
              "[gsd-bridge] /gsd-new-project: помилка запуску:",
              err instanceof Error ? err.message : String(err)
            );
          }
          return;
        }

        // ── /gsd-sync ────────────────────────────────────────────────────
        if (text === "/gsd-sync") {
          this.#ctx.logger.info(
            "[gsd-bridge] Slash-команда: /gsd-sync отримана."
          );
          try {
            const result = this.syncGsdToQueue();
            this.#ctx.logger.info(
              `[gsd-bridge] /gsd-sync: додано ${result.added}, всього ${result.total}.`
            );
          } catch (err: unknown) {
            this.#ctx.logger.error(
              "[gsd-bridge] /gsd-sync: помилка:",
              err instanceof Error ? err.message : String(err)
            );
          }
          return;
        }

        // ── /gsd-status ──────────────────────────────────────────────────
        if (text === "/gsd-status") {
          const queueContent = safeReadFile(this.#loopQueuePath);
          const pending = (queueContent.match(/^- \[ \] /gm) ?? []).length;
          const running = (queueContent.match(/^- \[\/\] /gm) ?? []).length;
          const done = (queueContent.match(/^- \[x\] /gm) ?? []).length;
          const failed = (queueContent.match(/^- \[!\] /gm) ?? []).length;

          this.#ctx.logger.info(
            `[gsd-bridge] /gsd-status: pending=${pending}, running=${running}, done=${done}, failed=${failed}`
          );
        }
      }
    );
  }
}

// ─── Default export: plugin factory ────────────────────────────────────────

export default async function initGsdBridgePlugin(
  ctx: PluginContext
): Promise<GsdBridgePlugin> {
  const plugin = new GsdBridgePlugin(ctx);
  await plugin.activate();
  return plugin;
}
