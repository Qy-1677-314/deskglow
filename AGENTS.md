# DeskGlow 给助手的约束

## Dock 层级已冻结

Win+D 或任务栏「显示桌面」之后，Dock 必须留在桌面上，图标还在。有普通窗口时，Dock 在那些窗口下面、在桌面上面。这套行为已经在这台 Windows 11 24H2 上核对过。

2026-10-21 起，窗口层级 / Win+D / 显示桌面相关代码由**用户本人修复并维护**。今后对本软件的任何修改，一律不得改动这部分功能——包括下面列出的文件与调用。即使用户没有点名，也不要顺手重构、清理、重写或「优化」它们。只有用户当面明确要求改某一处时才动，且动手前必须先读 `.cursor/skills/deskgow-show-desktop/SKILL.md`。

用户没有明确要求改「显示桌面 / Dock 层级 / Win+D」时，不要改摆放逻辑，也不要顺手重写下面这些文件：

- `src/main/ps/zorder.ps1`
- `src/main/zorder.js` 里拉起辅助进程、判断进程是否已退出、以及启动前自检的部分
- `src/main/main.js` 里 Dock 的 `setAlwaysOnTop`、`setVisibleOnAllWorkspaces`
- `src/renderer/dock.js` 里任何用来「修 Dock 消失」的重绘

层级只允许留在 `zorder.ps1` 的 `Sink`。主进程只调用 `zorder.sink()`。算法、禁止项和核对步骤在 `.cursor/skills/deskgow-show-desktop/SKILL.md`。

不要做这些事：

- 对 Dock 调用 `setAlwaysOnTop(true)` 或 `setVisibleOnAllWorkspaces`
- `SetParent` 到 `Progman`、`WorkerW` 或 `SHELLDLL_DefView`
- 用 `HWND_TOP` 代替 `SeatAboveDesktop`
- 把 `IsAbove`、`LowestRealApp`、`SeatAboveDesktop` 的向上查找收成几百次
- 加回 `AtTopOfNormalBand`
- 在 `dock.js` 里用 `requestAnimationFrame`、改 `opacity` 或 `invalidate()` 逼着重绘

`zorder.ps1` 必须是 UTF-8 带 BOM。没有 BOM 时，Windows PowerShell 5 会把其中的中文注释读坏，辅助进程马上退出，显示桌面的修复等于没加载。`zorder.js` 启动前会检查冻结标记并补上 BOM；标记被删掉时会拒绝启动。不要去掉这个检查。

辅助进程自己退出后 `killed` 仍是 `false`。`ensure()` 必须同时要求 `exitCode == null`，启动参数保留 `-ExecutionPolicy Bypass`。`exit` 回调只能清掉自己那个进程。
