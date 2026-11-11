#!/usr/bin/env node

/**
 * Herdr Neovim Live Watcher Plugin
 * Automatically opens and updates Neovim in a Herdr split pane
 * when files are modified by coding agents in Herdr TUI.
 *
 * Supported platforms: Windows, macOS, Linux (Ubuntu, Debian, Fedora, Arch / Omarchy)
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const STATE_FILE = path.join(__dirname, 'watcher-state.json');
const INIT_LUA = path.join(__dirname, 'neovim-init.lua');
const LOG_FILE = path.join(__dirname, 'watcher.log');
const MAX_LOG_SIZE = 1024 * 1024; // 1 MB limit for DoS prevention

// Directory exclusions
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'vendor',
  '.gemini',
  'temp_logs',
  'logs',
  '.herdr',
  '.vscode',
  '.idea',
  '__pycache__',
  'bin',
  'obj',
  'target',
  '.cache'
]);

// Extension exclusions
const EXCLUDED_EXTENSIONS = [
  '.log',
  '.tmp',
  '.swp',
  '.swo',
  '.swn',
  '.bak',
  '.lock',
  '~'
];

// Sensitive files and credentials patterns (prevent accidental disclosure in TUI split)
const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^id_dsa/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pkcs12$/i,
  /\.pfx$/i,
  /\.cert$/i,
  /\.crt$/i,
  /\.kdbx$/i,
  /^credentials\.json$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /secrets?\.(ya?ml|json|toml|ini|env)$/i
];

/**
 * Derives a user- and workspace-isolated IPC pipe or socket address.
 * Prevents pipe squatting, cross-user hijacking, and multi-workspace collisions.
 *
 * - Windows: \\\\.\\pipe\\herdr-nvim-${user}-${workspaceHash}
 * - Linux / macOS / Arch / Omarchy: $XDG_RUNTIME_DIR/herdr-nvim-${user}-${workspaceHash}.sock (fallback: os.tmpdir())
 */
function getPipeName(workspaceDir) {
  const user = (process.env.USERNAME || process.env.USER || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  const normalizedPath = path.resolve(workspaceDir).toLowerCase().replace(/\\/g, '/');
  const workspaceHash = crypto
    .createHash('sha256')
    .update(normalizedPath)
    .digest('hex')
    .slice(0, 12);
  const identifier = `herdr-nvim-${user}-${workspaceHash}`;

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${identifier}`;
  }
  const baseDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(baseDir, `${identifier}.sock`);
}

/**
 * Appends to watcher.log with size capping and rotation to prevent DoS via disk exhaustion.
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        try {
          const old = fs.readFileSync(LOG_FILE, 'utf-8');
          const trimmed = old.slice(-64 * 1024); // retain last 64KB
          fs.writeFileSync(LOG_FILE, `[Log truncated due to size limit]\n` + trimmed, 'utf-8');
        } catch (_) {
          fs.writeFileSync(LOG_FILE, line, 'utf-8');
          return;
        }
      }
    }
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (_) {}
}

/**
 * Reads watcher state safely.
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return Object.assign({ enabled: true }, data);
    }
  } catch (err) {
    log(`Failed to read state file: ${err.message}`);
  }
  return { enabled: true };
}

/**
 * Writes state atomically to prevent corrupted JSON on crash or interruption.
 */
function saveState(state) {
  const tmpFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    const data = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmpFile, data, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.renameSync(tmpFile, STATE_FILE);
    } catch (renameErr) {
      fs.copyFileSync(tmpFile, STATE_FILE);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  } catch (err) {
    log(`Failed to save state file: ${err.message}`);
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
  }
}

/**
 * Validates file path to prevent path traversal, control character injection,
 * and command quote breakout.
 */
function isSafeFilePath(filePath, workspaceRoot) {
  if (!filePath || typeof filePath !== 'string') return false;

  // Disallow control characters, newlines, carriage returns, null bytes
  if (/[\x00-\x1f\x7f]/.test(filePath)) {
    return false;
  }

  // Disallow quotes or backticks which could escape command boundaries in the terminal
  if (/["`]/.test(filePath)) {
    return false;
  }

  // Ensure path resolves strictly within the workspace root
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(workspaceRoot, filePath);

  if (resolvedPath !== resolvedRoot) {
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return false; // Traversal attempt outside workspace
    }
  }

  return true;
}

/**
 * Checks if path belongs to excluded directories, extensions, or sensitive files.
 */
function isExcluded(relPath) {
  if (!relPath || typeof relPath !== 'string') return true;
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/');

  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) {
      return true;
    }
  }

  const basename = path.basename(normalized);
  const lowerBasename = basename.toLowerCase();

  // Exclude sensitive files / credentials
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(basename)) {
      return true;
    }
  }

  for (const ext of EXCLUDED_EXTENSIONS) {
    if (lowerBasename.endsWith(ext)) {
      return true;
    }
  }

  // Temporary editor files
  if (basename.startsWith('.') && !basename.endsWith('.json') && !basename.endsWith('.js') && !basename.endsWith('.ts')) {
    return true;
  }
  if (basename === '4913') {
    return true;
  }

  return false;
}

/**
 * Checks if Neovim server is actively listening on the target named pipe or Unix domain socket.
 */
function isNvimListening(pipePath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    try {
      const socket = net.connect(pipePath, () => {
        socket.destroy();
        finish(true);
      });

      socket.on('error', () => {
        socket.destroy();
        finish(false);
      });

      socket.setTimeout(250, () => {
        socket.destroy();
        finish(false);
      });
    } catch (_) {
      finish(false);
    }
  });
}

/**
 * Executes a binary directly without spawning a shell, eliminating command injection risks.
 * Platform-agnostic: does not invoke cmd.exe or /bin/sh.
 */
function runExecutableSync(executable, args, options = {}) {
  try {
    const result = spawnSync(executable, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      windowsHide: true,
      shell: false, // CRITICAL: Never invoke shell to prevent host command injection
      ...options
    });

    if (result.error) {
      log(`Executable error [${executable} ${args.join(' ')}]: ${result.error.message}`);
      return null;
    }

    if (result.status !== 0) {
      const errOut = (result.stderr || '').trim();
      log(`Executable non-zero exit [${executable}]: code=${result.status}, stderr=${errOut}`);
      return null;
    }

    return result.stdout;
  } catch (err) {
    log(`Executable exception [${executable}]: ${err.message}`);
    return null;
  }
}

// Concurrency mutex and queued target to prevent race conditions and duplicate pane spawning
let isProcessing = false;
let queuedTarget = null;

async function openOrUpdateNeovim(filePath) {
  if (isProcessing) {
    queuedTarget = filePath;
    return;
  }

  isProcessing = true;
  try {
    await _executeOpenOrUpdate(filePath);
  } finally {
    isProcessing = false;
    if (queuedTarget) {
      const nextTarget = queuedTarget;
      queuedTarget = null;
      setImmediate(() => openOrUpdateNeovim(nextTarget));
    }
  }
}

async function _executeOpenOrUpdate(filePath) {
  const cwd = process.cwd();
  const targetFile = filePath ? path.resolve(cwd, filePath) : cwd;

  if (!isSafeFilePath(targetFile, cwd)) {
    log(`Security warning: Rejected unsafe or traversal path: ${filePath}`);
    return;
  }

  // Confirm file exists if target is not cwd
  if (targetFile !== cwd) {
    try {
      if (!fs.existsSync(targetFile)) return;
      const stat = fs.statSync(targetFile);
      if (stat.isDirectory()) return;
    } catch (_) {
      return;
    }
  }

  const pipeName = getPipeName(cwd);
  const active = await isNvimListening(pipeName);
  log(`Checking Neovim server (${pipeName}): active=${active}, target=${targetFile}`);

  // Clean up stale Unix domain socket on POSIX if process died uncleanly
  if (!active && process.platform !== 'win32') {
    try {
      if (fs.existsSync(pipeName)) {
        fs.unlinkSync(pipeName);
        log(`Removed stale Unix domain socket: ${pipeName}`);
      }
    } catch (sockErr) {
      log(`Could not unlink stale socket (${pipeName}): ${sockErr.message}`);
    }
  }

  const sanitizedFile = targetFile.replace(/\\/g, '/');

  if (active) {
    // Neovim is already running; send file and execute checktime
    try {
      runExecutableSync('nvim', ['--server', pipeName, '--remote', sanitizedFile]);
      runExecutableSync('nvim', ['--server', pipeName, '--remote-send', '<Esc>:checktime<CR>']);
      log(`Updated Neovim buffer to: ${sanitizedFile}`);
    } catch (err) {
      log(`Error updating Neovim buffer: ${err.message}`);
    }
  } else {
    // Neovim is not running: split pane and launch Neovim
    try {
      log(`Splitting pane right in cwd: ${cwd}`);
      const splitOutput = runExecutableSync('herdr', [
        'pane',
        'split',
        '--direction',
        'right',
        '--no-focus',
        '--cwd',
        cwd
      ]);

      let paneId = null;
      if (splitOutput) {
        try {
          const parsed = JSON.parse(splitOutput);
          paneId = parsed?.result?.pane?.pane_id || parsed?.result?.pane_id;
        } catch (e) {
          log(`Failed to parse split output: ${e.message}`);
        }
      }

      if (!paneId) {
        log('Could not determine new pane ID from herdr split');
        return;
      }

      log(`New pane ID: ${paneId}`);
      const sanitizedInit = INIT_LUA.replace(/\\/g, '/');
      const nvimCmd = `nvim -u "${sanitizedInit}" --listen "${pipeName}" "${sanitizedFile}"`;

      runExecutableSync('herdr', ['pane', 'run', String(paneId), nvimCmd]);
      log(`Executed nvim command in pane ${paneId}`);
    } catch (err) {
      log(`Failed to split and launch Neovim: ${err.message}`);
    }
  }
}

function handleToggle() {
  const state = loadState();
  state.enabled = !state.enabled;
  saveState(state);
  const statusStr = state.enabled ? 'ENABLED' : 'DISABLED';
  console.log(`[herdr-nvim-watcher] Live watcher is now ${statusStr}`);
  log(`Toggled watcher state to: ${statusStr}`);
}

async function handleOpen() {
  console.log('[herdr-nvim-watcher] Opening Neovim split for current repo...');
  const cwd = process.cwd();
  // Try to find a reasonable initial file or pass cwd
  let initialTarget = cwd;
  const candidates = ['README.md', 'package.json', 'Cargo.toml', 'index.js', 'main.py'];
  for (const c of candidates) {
    const p = path.join(cwd, c);
    if (fs.existsSync(p) && isSafeFilePath(p, cwd) && !isExcluded(c)) {
      initialTarget = p;
      break;
    }
  }
  await openOrUpdateNeovim(initialTarget);
}

function handleDaemon() {
  const cwd = process.cwd();
  console.log(`[herdr-nvim-watcher] Daemon started. Watching workspace: ${cwd}`);
  log(`Daemon started watching: ${cwd}`);

  let debounceTimer = null;
  let maxWaitTimer = null;
  const pendingFiles = new Set();
  const MAX_PENDING_FILES = 200;
  const DEBOUNCE_MS = 400;
  const MAX_WAIT_MS = 1500;

  const triggerUpdate = async () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }

    const files = Array.from(pendingFiles);
    pendingFiles.clear();

    if (files.length > 0) {
      const target = files[files.length - 1];
      log(`File change detected: ${target}`);
      try {
        await openOrUpdateNeovim(target);
      } catch (err) {
        log(`Error handling file update: ${err.message}`);
      }
    }
  };

  try {
    const watcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      const state = loadState();
      if (!state.enabled) {
        return;
      }

      if (isExcluded(filename)) {
        return;
      }

      if (!isSafeFilePath(filename, cwd)) {
        log(`Security warning: Watcher detected unsafe filename: ${filename}`);
        return;
      }

      const fullPath = path.resolve(cwd, filename);
      try {
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return;
      } catch (_) {
        return;
      }

      if (pendingFiles.size < MAX_PENDING_FILES) {
        pendingFiles.add(fullPath);
      }

      if (!maxWaitTimer) {
        maxWaitTimer = setTimeout(triggerUpdate, MAX_WAIT_MS);
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(triggerUpdate, DEBOUNCE_MS);
    });

    watcher.on('error', (err) => {
      log(`Watcher runtime error: ${err.message}`);
    });
  } catch (err) {
    log(`Watcher fatal error: ${err.message}`);
    console.error(`[herdr-nvim-watcher] Watch error: ${err.message}`);
  }

  // Graceful shutdown
  const shutdown = () => {
    log('Daemon received shutdown signal, stopping.');
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--toggle')) {
    handleToggle();
  } else if (args.includes('--open')) {
    await handleOpen();
  } else if (args.includes('--daemon')) {
    handleDaemon();
  } else {
    console.log('Herdr Neovim Live Watcher');
    console.log('Usage: node index.js [--daemon | --toggle | --open]');
  }
}

main().catch((err) => {
  log(`Unhandled error: ${err.message}`);
  process.exit(1);
});
