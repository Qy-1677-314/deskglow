# DeskGlow

先读仓库根目录的 `AGENTS.md`。Dock 在 Win+D / 显示桌面之后的层级已经冻结。用户没有明确要求改这个行为时，不要改 `src/main/ps/zorder.ps1`、`src/main/zorder.js` 的辅助进程，也不要对 Dock 调用 `setAlwaysOnTop(true)` 或 `setVisibleOnAllWorkspaces`。
