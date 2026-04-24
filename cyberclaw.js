#!/usr/bin/env node

/**
 * cyberclaw.js
 * 
 * An intelligent orchestration layer (the "Brain") that bridges a local AI memory system 
 * (OpenClaw's MemPlace) with Google's official @google/gemini-cli.
 * 
 * It dynamically compiles a mega-prompt (Memory Context + User Input) and routes it 
 * to the official CLI via child processes, acting as a 100% decoupled proxy.
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// PHASE 1: CLI Initialization & Argument Parsing
async function parseArgs() {
    const rawArgs = process.argv.slice(2);
    const flags = [];
    const textParts = [];

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg.startsWith('-')) {
            flags.push(arg);
            // Перехоплюємо значення для прапорців, які вимагають параметрів (наприклад, -m)
            if (arg === '-m' || arg === '--model') {
                if (i + 1 < rawArgs.length) {
                    flags.push(rawArgs[i + 1]);
                    i++;
                }
            }
        } else {
            textParts.push(arg);
        }
    }
    
    if (textParts.length === 0 && flags.length === 0) {
        console.log(`
\x1b[36mcyberclaw\x1b[0m - Intelligent orchestration layer for Gemini CLI

\x1b[33mUsage:\x1b[0m
  cyberclaw [flags] <your prompt or command here>

\x1b[33mFlags:\x1b[0m
  -m, --model <name>   Змінити мовну модель (наприклад, gemini-2.5-flash)

\x1b[33mExample:\x1b[0m
  cyberclaw -m gemini-2.5-flash "Write a Node.js script to scan ports"
        `);
        process.exit(0);
    }
    
    return {
        userTask: textParts.join(' '),
        flags: flags
    };
}

// PHASE 2: Context Aggregation (MemPlace Integration)
async function getMemPlaceContext() {
    const homeDir = os.homedir();
    const openclawWorkspace = path.join(homeDir, '.openclaw', 'workspace');
    const mainMemoryPath = path.join(openclawWorkspace, 'MEMORY.md');
    const memoryDirPath = path.join(openclawWorkspace, 'memory');
    
    let compiledMemory = '';

    // 1. Read all relevant context files from the OpenClaw workspace
    try {
        const workspaceFiles = await fs.readdir(openclawWorkspace);
        for (const file of workspaceFiles) {
            if (file.endsWith('.md') || file.endsWith('.txt')) {
                const filePath = path.join(openclawWorkspace, file);
                const stats = await fs.stat(filePath);
                if (stats.isFile()) {
                    const content = await fs.readFile(filePath, 'utf-8');
                    compiledMemory += `\n--- System Context (${file}) ---\n${content}\n`;
                }
            }
        }
    } catch (e) {
        console.warn('\x1b[2m[cyberclaw] Could not read OpenClaw workspace files. Proceeding with empty state.\x1b[0m');
    }

    // 2. Read all .md files in the memory/ directory if it exists
    try {
        const dirStats = await fs.stat(memoryDirPath);
        if (dirStats.isDirectory()) {
            const files = await fs.readdir(memoryDirPath);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    const filePath = path.join(memoryDirPath, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    compiledMemory += `\n--- Memory Fragment (${file}) ---\n${content}\n`;
                }
            }
        }
    } catch (e) {
        // It's totally fine if the memory directory doesn't exist
    }

    return compiledMemory.trim();
}

// PHASE 3: Prompt Compilation
function compilePayload(systemContext, userTask) {
    const additionalDirectives = `
[CRITICAL SYSTEM DIRECTIVES]
1. You MUST execute scripts and terminal commands directly using the 'run_shell_command' tool. DO NOT ask the user for permission or confirmation. DO NOT just write a plan and stop. You are an autonomous execution agent.
2. If you create a script, immediately execute it.
3. If you need to run commands with 'sudo', use the following syntax: 'echo 1111 | sudo -S <command>'. The system user is 'korben' and the test password is '1111'.
`;

    if (!systemContext) {
        return additionalDirectives + '\n[USER CURRENT TASK]\n' + userTask;
    }

    return `[SYSTEM: LONG-TERM MEMORY CONTEXT]
${systemContext}
[/SYSTEM]
${additionalDirectives}
[USER CURRENT TASK]
${userTask}`;
}

// PHASE 4: Subprocess Orchestration (The Bridge)
// Щоб зберегти історію між викликами і використовувати вже авторизований стан,
// cyberclaw намагається відновити останню сесію (--resume latest).
// Якщо сесій ще немає, він просто створить нову.
function executeGemini(compiledPayload, flags) {
    // Спочатку перевіряємо, чи є існуючі сесії
    const { execSync } = require('child_process');
    let hasSessions = false;
    try {
        const out = execSync('gemini --list-sessions 2>/dev/null', { encoding: 'utf-8' });
        if (out && !out.includes('No sessions found')) {
            hasSessions = true;
        }
    } catch(e) {
        // ігноруємо помилки
    }

    // Збираємо аргументи
    // -y (YOLO mode)
    // -p (Non-interactive prompt execution)
    const geminiArgs = ['-y'];
    
    // Передаємо кастомні прапорці (наприклад, -m)
    if (flags && flags.length > 0) {
        geminiArgs.push(...flags);
    }
    
    if (hasSessions) {
        // Відновлюємо останню сесію
        geminiArgs.push('--resume', 'latest');
    }
    
    geminiArgs.push('-p', compiledPayload);

    console.log('\x1b[36m[cyberclaw] Звернення до ядра Gemini (з урахуванням попередньої пам\'яті)...\x1b[0m');

    // Інжектуємо API-ключ AI Studio, щоб обійти зламаний oAuth
    process.env.GEMINI_API_KEY = "AIzaSyCJBvo_VB-ZrxV1qJDKxUf88owdZhY2zBE";

    const child = spawn('gemini', geminiArgs, { 
        stdio: 'inherit',
        shell: false
    });

    child.on('error', (err) => {
        console.error('\x1b[31m[cyberclaw] Помилка виконання команди gemini.\x1b[0m');
        console.error('\x1b[31mЧи встановлено @google/gemini-cli глобально і чи авторизовані ви?\x1b[0m', err.message);
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code !== null ? code : 1);
    });
}

// Main Execution Flow
async function main() {
    try {
        const { userTask, flags } = await parseArgs();
        
        // --- GSD Interception ---
        if (userTask.startsWith('gsd ')) {
            const parts = userTask.split(' ');
            let workflowFile = '';
            
            if (parts[1] === 'phase') {
                workflowFile = 'execute-phase.md';
            } else if (parts[1] === 'plan') {
                workflowFile = 'plan-phase.md';
            } else {
                workflowFile = parts[1] + '.md';
            }

            const workflowPath = path.join(os.homedir(), '.openclaw', 'get-shit-done', 'workflows', workflowFile);
            
            try {
                await fs.access(workflowPath);
                const workflowContent = await fs.readFile(workflowPath, 'utf-8');
                console.log(`\x1b[36m[cyberclaw] Intercepted GSD command. Dispatching workflow: ${workflowFile}...\x1b[0m`);
                
                const gsdPayload = `[GSD WORKFLOW: ${workflowFile}]
${workflowContent}
[/GSD WORKFLOW]

[CRITICAL SYSTEM DIRECTIVES]
1. You MUST execute scripts and terminal commands directly using the 'run_shell_command' tool. DO NOT ask the user for permission or confirmation. DO NOT just write a plan and stop. You are an autonomous execution agent.
2. If you create a script, immediately execute it.
3. If you need to run commands with 'sudo', use the following syntax: 'echo 1111 | sudo -S <command>'. The system user is 'korben' and the test password is '1111'.

[USER CURRENT TASK]
${userTask}`;

                executeGemini(gsdPayload, flags);
                return;
            } catch (e) {
                // If workflow file doesn't exist, proceed to normal execution
                if (e.code !== 'ENOENT') {
                    console.error(`\x1b[31m[cyberclaw] Error loading GSD workflow: ${e.message}\x1b[0m`);
                }
            }
        }

        const systemContext = await getMemPlaceContext();
        const compiledPayload = compilePayload(systemContext, userTask);
        
        executeGemini(compiledPayload, flags);
    } catch (err) {
        console.error('\x1b[31m[cyberclaw] Fatal Error:\x1b[0m', err);
        process.exit(1);
    }
}

main();
