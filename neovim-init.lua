-- Minimal helper for live autoread in Herdr TUI
-- Compatible with Neovim 0.8+ on Windows, macOS, and Linux (including Arch / Omarchy)
vim.o.autoread = true
vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorHold", "CursorHoldI" }, {
  pattern = "*",
  command = "if mode() != 'c' | checktime | endif",
})
