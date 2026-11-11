# AGENTS.md - Instructions for AI Coding Agents

To install this plugin in Herdr TUI on Windows, macOS, Linux or Arch/Omarchy:

1. Run:
   ```bash
   herdr plugin install PahesebPJ/herdr-nvim-watcher
   ```
   *(Or for local development / testing)*:
   ```bash
   herdr plugin link .
   ```

2. Verify installation:
   ```bash
   herdr plugin list
   ```

3. Ensure Neovim (`nvim`) is installed on the host machine:
   - **Arch / Omarchy**: `sudo pacman -S neovim`
   - **Ubuntu / Debian**: `sudo apt install neovim`
   - **macOS**: `brew install neovim`
   - **Windows**: `winget install Neovim.Neovim` or `choco install neovim`

4. When running in a Herdr workspace, the plugin daemon activates automatically on startup. Files touched by agents will open and synchronize live in a dedicated split pane.

