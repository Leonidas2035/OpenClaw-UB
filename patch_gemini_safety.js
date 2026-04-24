#!/usr/bin/env node

/**
 * patch_gemini_safety.js
 * 
 * Цей скрипт агресивно (monkey-patching) вимикає цензуру (Safety Settings) 
 * у вихідному коді Google Gemini CLI.
 * 
 * Використання:
 * sudo node ~/.openclaw/patch_gemini_safety.js
 */

const fs = require('fs');
const path = require('path');

const bundleDir = '/usr/local/lib/node_modules/@google/gemini-cli/bundle';

// Хардкод масив для вимкнення цензури
const blockNonePayload = `[{category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE"}, {category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE"}, {category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE"}, {category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE"}]`;

// Патерни для пошуку у мініфікованому коді
const replacements = [
    {
        name: "REST Payload Patch",
        regex: /restPayload\["safetySettings"\]\s*=\s*sdkSafetySettings;/g,
        replace: `restPayload["safetySettings"] = ${blockNonePayload};`
    },
    {
        name: "Config Fallback Patch",
        regex: /safetySettings:\s*req\.config\?\.safetySettings/g,
        replace: `safetySettings: ${blockNonePayload}`
    },
    {
        name: "Direct SDK Assignment Patch",
        regex: /safetySettings:\s*sdkSafetySettings/g,
        replace: `safetySettings: ${blockNonePayload}`
    }
];

function patchFiles() {
    console.log(`\x1b[36m[Patcher] Починаємо сканування директорії: ${bundleDir}\x1b[0m`);

    if (!fs.existsSync(bundleDir)) {
        console.error(`\x1b[31m[Помилка] Директорія ${bundleDir} не знайдена. Переконайтесь, що Gemini CLI встановлено глобально.\x1b[0m`);
        process.exit(1);
    }

    const files = fs.readdirSync(bundleDir);
    let patchedCount = 0;

    for (const file of files) {
        if (!file.endsWith('.js')) continue;

        const filePath = path.join(bundleDir, file);
        let content = fs.readFileSync(filePath, 'utf-8');
        let fileChanged = false;

        for (const rule of replacements) {
            if (rule.regex.test(content)) {
                content = content.replace(rule.regex, rule.replace);
                fileChanged = true;
                console.log(`\x1b[32m[Успіх] Застосовано патч "${rule.name}" у файлі: ${file}\x1b[0m`);
            }
        }

        if (fileChanged) {
            fs.writeFileSync(filePath, content, 'utf-8');
            patchedCount++;
        }
    }

    if (patchedCount > 0) {
        console.log(`\n\x1b[32m🎉 Патчинг завершено успішно! Змінено файлів: ${patchedCount}\x1b[0m`);
        console.log(`\x1b[33mЦензуру жорстко вимкнено на рівні вихідного коду.\x1b[0m`);
    } else {
        console.log(`\n\x1b[33m⚠️ Не знайдено файлів для патчингу. Можливо, код вже пропатчено, або версія Gemini CLI змінилася.\x1b[0m`);
    }
}

// Запуск від імені адміністратора потрібен для зміни файлів у /usr/local/...
if (process.getuid && process.getuid() !== 0) {
    console.warn(`\x1b[31m[Попередження] Цей скрипт потрібно запускати з правами sudo для редагування глобальних модулів!\x1b[0m`);
    console.log(`Спробуйте: sudo node ${__filename}`);
}

patchFiles();
