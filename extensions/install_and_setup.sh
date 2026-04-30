#!/usr/bin/env bash
# =============================================================================
# OpenClaw × MemPlace × GSD — Environment Setup Script
# Ubuntu 26.04 LTS (Resolute Raccoon) | Node.js 24.x
# =============================================================================
set -euo pipefail

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()   { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()  { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

# ─── Constants ───────────────────────────────────────────────────────────────
REQUIRED_NODE_MAJOR=24
REQUIRED_NODE_MINOR=3
OPENCLAW_DIR="${HOME}/.openclaw"
EXT_DIR="${OPENCLAW_DIR}/extensions"
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"
CONFIG_BAK="${OPENCLAW_DIR}/openclaw.json.bak.setup-$(date +%s)"

# ─── Step 0: OS Check ────────────────────────────────────────────────────────
log "Перевірка операційної системи..."
if [[ -f /etc/os-release ]]; then
  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    warn "Очікується Ubuntu, знайдено: ${ID:-unknown}. Продовжуємо..."
  elif [[ "${VERSION_ID:-}" != "26"* ]]; then
    warn "Очікується Ubuntu 26.x, знайдено: ${VERSION_ID:-unknown}. Продовжуємо..."
  else
    ok "Ubuntu ${VERSION_ID} — сумісна система."
  fi
else
  warn "/etc/os-release не знайдено. Продовжуємо без перевірки ОС."
fi

# ─── Step 1: Node.js 24 via NodeSource ───────────────────────────────────────
log "Перевірка версії Node.js..."

_node_needs_install=false
if command -v node &>/dev/null; then
  _node_version="$(node --version)"           # e.g. v22.1.0
  _node_major="${_node_version#v}"             # strip leading 'v'
  _node_major="${_node_major%%.*}"             # major
  _node_minor="$(node --version | sed 's/v[0-9]*\.\([0-9]*\).*/\1/')"

  log "Знайдено Node.js ${_node_version}"

  if (( _node_major < REQUIRED_NODE_MAJOR )); then
    warn "Node.js ${_node_version} < ${REQUIRED_NODE_MAJOR}. Потрібне оновлення."
    _node_needs_install=true
  elif (( _node_major == REQUIRED_NODE_MAJOR && _node_minor < REQUIRED_NODE_MINOR )); then
    warn "Node.js ${_node_version} < ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}. Потрібне оновлення."
    _node_needs_install=true
  else
    ok "Node.js ${_node_version} відповідає вимогам."
  fi
else
  warn "Node.js не знайдено. Встановлення..."
  _node_needs_install=true
fi

if [[ "${_node_needs_install}" == "true" ]]; then
  log "Завантаження NodeSource setup скрипту для Node.js ${REQUIRED_NODE_MAJOR}.x..."
  if ! command -v curl &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y curl
  fi

  curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" \
    -o /tmp/nodesource_setup.sh || die "Не вдалося завантажити NodeSource setup."

  sudo bash /tmp/nodesource_setup.sh || die "NodeSource setup завершився з помилкою."
  rm -f /tmp/nodesource_setup.sh

  sudo apt-get install -y nodejs || die "Не вдалося встановити Node.js."

  _installed_version="$(node --version)"
  ok "Node.js ${_installed_version} встановлено успішно."
fi

# ─── Step 2: Global npm packages ─────────────────────────────────────────────
log "Встановлення глобальних npm-пакетів..."

for pkg in "openclaw@latest" "get-shit-done-cc@latest"; do
  log "npm install -g ${pkg}..."
  if npm install -g "${pkg}"; then
    ok "${pkg} встановлено."
  else
    warn "Не вдалося встановити ${pkg}. Перевірте npm-registry або мережу."
  fi
done

# ─── Step 3: Directory structure ─────────────────────────────────────────────
log "Створення ієрархії директорій плагінів у ${EXT_DIR}..."

_dirs=(
  "${EXT_DIR}/memory-memplace/src"
  "${EXT_DIR}/gsd-bridge/src"
  "${OPENCLAW_DIR}/logs"
  "${OPENCLAW_DIR}/tasks"
)

for _dir in "${_dirs[@]}"; do
  mkdir -p "${_dir}"
  ok "Директорія створена: ${_dir}"
done

# ─── Step 4: openclaw.json — merge extensions config ─────────────────────────
log "Підготовка конфігурації openclaw.json..."

# Backup existing config if present
if [[ -f "${CONFIG_FILE}" ]]; then
  cp "${CONFIG_FILE}" "${CONFIG_BAK}"
  warn "Існуючий конфіг збережено у: ${CONFIG_BAK}"
fi

# Read existing config or start from minimal base
if [[ -f "${CONFIG_FILE}" ]]; then
  _existing_config="$(cat "${CONFIG_FILE}")"
else
  _existing_config='{}'
fi

# Use node itself (guaranteed ≥24 at this point) to merge JSON safely
log "Злиття розширень у конфіг через Node.js..."
node --input-type=module <<'NODEJS_EOF'
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const CONFIG_PATH = `${homedir()}/.openclaw/openclaw.json`;

/** Deep-merge: source keys win over target */
function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Extension config to inject */
const extensionPatch = {
  plugins: {
    entries: {
      google: { enabled: true },
    },
  },
  memory: {
    slots: {
      "memory-memplace": {
        enabled: true,
        provider: "memplace",
        mcpPath: "/usr/local/bin/mempalace",
        autoRecall: true,
        autoCapture: true,
      },
    },
  },
  extensions: {
    entries: {
      "memory-memplace": {
        enabled: true,
        entryPoint: "extensions/memory-memplace/src/index.js",
        description: "Семантична пам'ять на базі MemPlace MCP",
      },
      "gsd-bridge": {
        enabled: true,
        entryPoint: "extensions/gsd-bridge/src/index.js",
        description: "Міст до GSD-планувальника (get-shit-done-cc)",
        config: {
          syncIntervalMs: 600000,
        },
      },
    },
  },
};

let existing = {};
if (existsSync(CONFIG_PATH)) {
  try {
    existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[WARN] Не вдалося розібрати існуючий конфіг: ${err.message}. Починаємо з нуля.`);
    existing = {};
  }
}

const merged = deepMerge(existing, extensionPatch);
writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
console.log(`[OK] openclaw.json оновлено: ${CONFIG_PATH}`);
NODEJS_EOF

ok "openclaw.json успішно оновлено."

# ─── Step 5: Create placeholder package.json files for extensions ─────────────
log "Ініціалізація package.json для плагінів..."

for _plugin in "memory-memplace" "gsd-bridge"; do
  _pkg_file="${EXT_DIR}/${_plugin}/package.json"
  if [[ ! -f "${_pkg_file}" ]]; then
    cat > "${_pkg_file}" <<EOF
{
  "name": "@openclaw/${_plugin}",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "description": "OpenClaw extension: ${_plugin}",
  "engines": {
    "node": ">=24.3"
  }
}
EOF
    ok "package.json створено: ${_pkg_file}"
  else
    warn "package.json вже існує: ${_pkg_file} — пропускаємо."
  fi
done

# ─── Final report ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  ✓  OpenClaw × MemPlace × GSD — Setup complete ${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  Node.js версія : $(node --version)"
echo -e "  npm версія     : $(npm --version)"
echo -e "  Конфіг         : ${CONFIG_FILE}"
echo -e "  Плагіни        : ${EXT_DIR}/"
echo ""
log "Наступний крок: реалізація TypeScript-модулів у extensions/*/src/index.ts"
