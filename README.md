# herdr-nvim-watcher

[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Arch%20%2F%20Omarchy-blue)](#compatibility)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-Zero%20NPM-success)](#features)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An official, cross-platform plugin for [Herdr](https://github.com/mishankov/herdr) TUI that automatically opens and synchronizes Neovim in a split pane whenever files are modified by coding agents (Antigravity, Claude Code, Codex, OpenCode, Aider, etc.) or local developer edits.

---

## Compatibility

`herdr-nvim-watcher` is designed from the ground up for seamless cross-platform performance:

- **Windows** (Windows 10/11, Windows Server) via Windows Named Pipes (`\\.\pipe\...`).
- **macOS** (Apple Silicon & Intel) via Unix Domain Sockets in `$XDG_RUNTIME_DIR` or `/tmp`.
- **Linux** Distributions:
  - **Arch Linux / Omarchy**
  - **Ubuntu / Debian**
  - **Fedora / RHEL**
  - Any POSIX-compliant Linux with Node.js >= 16 and Neovim >= 0.8.

---

## Features

- **Zero NPM Dependencies**: Built exclusively on standard Node.js runtime libraries (`fs`, `net`, `crypto`, `os`, `child_process`). Lightweight, instant startup, zero security vulnerabilities from dependency trees.
- **Cross-Platform Secure IPC**:
  - Windows: Isolated Named Pipe `\\.\pipe\herdr-nvim-${user}-${workspaceHash}`.
  - Linux / macOS / Omarchy: Unix Domain Socket in `$XDG_RUNTIME_DIR/herdr-nvim-${user}-${workspaceHash}.sock` (with safe fallback to `os.tmpdir()` and stale socket cleanup).
- **Anti-Path Traversal & Shell Injection Immunity**:
  - Validates paths strictly inside the active workspace boundary.
  - Rejects null bytes, carriage returns, control characters, and unescaped quote injections.
  - Platform-agnostic execution without invoking intermediary shells (`cmd.exe` or `/bin/sh`).
- **Sensitive File Protection**: Automatically ignores sensitive files (`.env*`, private SSH/TLS keys, credentials, tokens, secrets) to prevent accidental display in split panes.
- **Smart Debounce with Max-Wait Guarantee**: 400ms debounce buffer with a 1500ms max-wait ceiling to handle high-frequency agent tool calls and rapid multi-file refactoring without choking Neovim.
- **Live Autoread**: Injects a minimal Lua configuration ensuring Neovim reloads file buffers automatically when changed on disk (`:checktime`).
- **Disk DoS Prevention**: Bounded state files and auto-rotating log files capped at 1 MB.

---

## Installation

### Prerequisites

Ensure Neovim (`nvim` version 0.8 or higher) is installed and available in your system `$PATH`:

```bash
# Arch Linux / Omarchy
sudo pacman -S neovim

# Ubuntu / Debian
sudo apt update && sudo apt install neovim

# Fedora
sudo dnf install neovim

# macOS (Homebrew)
brew install neovim

# Windows (Winget or Chocolatey)
winget install Neovim.Neovim
# or
choco install neovim
```

### Direct Installation

Install directly via Herdr's plugin registry:

```bash
herdr plugin install PahesebPJ/herdr-nvim-watcher
```

Verify that the plugin is active:

```bash
herdr plugin list
```

### For AI Coding Agents (One-Liner)

Prompt your AI coding assistant (Antigravity, Claude Code, Cursor, Codex):

> *"Please install and link the `herdr-nvim-watcher` plugin in Herdr using `herdr plugin link .` or `herdr plugin install PahesebPJ/herdr-nvim-watcher` so our code edits are mirrored live in a Neovim split pane."*

### Local Development / Linking

Clone and link the repository locally into your Herdr environment:

```bash
git clone https://github.com/PahesebPJ/herdr-nvim-watcher.git
cd herdr-nvim-watcher
herdr plugin link .
```

---

## Actions & Keyboard Commands

The plugin defines actions registered directly with Herdr TUI:

| Action ID | Command Title | Context | Description |
|-----------|---------------|---------|-------------|
| `open-now` | Open Neovim Split for Current Repo | `workspace`, `pane` | Immediately opens a split pane and launches Neovim targeting the workspace entry file. |
| `toggle` | Toggle Neovim Live Watcher | `workspace`, `pane` | Toggles the active file watcher on/off without closing existing Neovim sessions. |

### CLI Usage

You can also trigger plugin actions directly via Node:

```bash
# Start watcher daemon
node index.js --daemon

# Immediately open or focus repo in Neovim
node index.js --open

# Toggle live watcher on or off
node index.js --toggle
```

---

## How It Works

1. **Workspace Startup**: Herdr executes `node index.js --daemon` upon opening your project.
2. **File Change Detection**: When an AI agent or process updates a file, the watcher filters the event (ignoring `.git`, `node_modules`, `.env`, build artifacts).
3. **IPC Check**:
   - If a Neovim instance is already running on the workspace pipe/socket, `index.js` sends an IPC command to switch buffer and run `:checktime`.
   - If not yet open, Herdr splits the pane (`herdr pane split --direction right`) and launches Neovim connected to the dedicated IPC socket.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

