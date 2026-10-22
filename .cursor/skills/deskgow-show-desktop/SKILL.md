---
name: deskgow-show-desktop
description: >-
  Keeps the DeskGlow Dock visible after Win+D / Show Desktop on Windows 11,
  and below normal app windows the rest of the time. Use when editing the Dock
  window, z-order, zorder.ps1, zorder.js, alwaysOnTop, transparent BrowserWindow,
  SetParent, setVisibleOnAllWorkspaces, occlusion, or when the user says Win+D,
  显示桌面, Dock 消失, or the dock vanishes after showing the desktop.
---

# DeskGlow：Win+D 之后 Dock 不许消失

这台机器是 Win11 24H2。Dock 是 `transparent: true` 的分层窗口。显示桌面会升起 `Progman`（图标层 `SHELLDLL_DefView` 在它里面）盖住普通窗口。改 Dock 层级之前先读完这一页。不要用「遮挡检测 / rAF 心跳」解释这个现象。

## 必须保持的行为

- Win+D，或任务栏最右侧「显示桌面」：Dock 留在桌面上，图标还在。
- 有普通窗口时：Dock 在那些窗口下面、在桌面上面。
- 层级只在 `src/main/ps/zorder.ps1` 的 `Sink` 里改。主进程只调用 `zorder.sink()`。

## Sink 只允许这样做

1. `PinToDesktop`：`SetWindowLongPtr(hwnd, -8, SHELLDLL_DefView)`。这是 owner，不是 parent。
2. 有普通窗口盖在桌面宿主上面：若 Dock 带 `WS_EX_TOPMOST`，先 `HWND_NOTOPMOST`，再贴到其中最底那个窗口的正下方。
3. 没有这种窗口（Win+D、点了桌面、或桌面是空的）：Dock 已经在宿主上面就停。否则 `SeatAboveDesktop`。已经在这个位置时不要每 200ms 再调一次。
4. `SeatAboveDesktop`：先 `HWND_TOPMOST`（flags `0x13`，不要带 `SWP_NOOWNERZORDER`），再从宿主往上找到第一个别的置顶窗，把 Dock 插到它正下方。Dock 停在置顶带最底部：高于升起的 `Progman`，低于任务栏和其它置顶窗。往上要走完整条 Z 序（现在的上限是 4000）。找不到置顶锚点就 `HWND_NOTOPMOST`，不能把 Dock 留在 `HWND_TOPMOST` 的最顶上。

判断普通窗口时跳过 `Progman`、`WorkerW`、`SHELLDLL_DefView`、任务栏、置顶窗、`CEF-OSC`、类名里带 Overlay 的窗口、最小化窗口、Wallpaper Engine。Win11 24H2 的桌面宿主是带 `SHELLDLL_DefView` 的 `Progman`；更早的系统才是带着 DefView 的 `WorkerW`。`IsAbove` 和 `LowestRealApp` 也要走完整条 Z 序。只看前 200 个窗口时，桌面在很下面，找不到置顶锚点，Dock 会停在置顶带最顶上盖住普通程序。

这台机器上核对过：显示桌面时 Dock 的枚举序号小于 `Progman`，屏幕底部能看见 Dock 图标；再按一次 Win+D，游戏回到前台，Dock 不再带 `WS_EX_TOPMOST`。`HWND_TOP` 做不到这件事，当时 Dock 仍在 `Progman` 下面。

## 禁止

这些都会让 Win+D 之后屏幕上只剩壁纸，但 `IsWindowVisible` / cloak 看起来仍正常：

- 不要对 Dock 调用 Electron 的 `setAlwaysOnTop(true)`。不要把 Dock 留在 `HWND_TOPMOST` 的最顶上。那一层会被显示桌面盖住。
- 显示桌面时允许的置顶只有 `SeatAboveDesktop`：贴在置顶带最底部。有普通窗口盖住桌面后必须 `HWND_NOTOPMOST`，回到那些窗口下面。
- 不要用 `HWND_TOP` 应付 Win+D。这台机器上它跨不过升起的 `Progman`，Dock 会留在桌面下面。
- 不要 `setVisibleOnAllWorkspaces`。
- 不要 `SetParent` 到 `Progman`、`WorkerW` 或 `SHELLDLL_DefView`。分层窗口跨进程当子窗口，在这台系统上挂不上。
- 不要加 `AtTopOfNormalBand`（「前一个窗口是置顶窗，就别抬」）。那次改动会把 Dock 留在桌面下面。
- 不要把 `IsAbove`、`LowestRealApp`、`SeatAboveDesktop` 的向上查找收成几百次。查找提前结束时，不要当成「已经在桌面上面」。
- 不要在 `dock.js` 里做 rAF 心跳、改 `opacity`、`invalidate()`，或写无用样式逼重绘。壁纸会闪，透明窗口也会被刷空。

`backgroundThrottling: false` 和 `CalculateNativeWinOcclusion` 可以留着。它们不解决 Win+D。

## 改完

`zorder.ps1` 必须保存成 **UTF-8 带 BOM**。Windows PowerShell 5 没有 BOM 时按系统 ANSI 读文件，里面的中文注释会把 C# 编译弄坏，辅助进程马上退出，Win+D 修复等于没加载。

C# 在 PowerShell 进程启动时编译。改完要结束正在跑的 `powershell.exe -File ...\zorder.ps1`，让 `zorder.js` 再拉起它。只存盘不会生效。

`zorder.js` 拉起这个进程时要带 `-ExecutionPolicy Bypass`。进程自己退出以后 `killed` 仍是 `false`；`ensure()` 如果只看 `killed`，会把已经死掉的进程当成还活着，层级再也不更新。要同时要求 `exitCode == null`。`exit` 回调只能清掉自己那个 `proc`，不能把刚拉起的下一个清掉。

核对两件事，然后把用户的窗口恢复：

- 显示桌面之后，Dock 的枚举序号小于 `Progman`，屏幕底部该矩形里能看见 Dock 图标。这台机器的壁纸是红色的，不要用红色像素多少来判断。
- 再按一次 Win+D。前台应回到用户刚才的程序，Dock 不带 `WS_EX_TOPMOST`，并且在那个程序下面。

全屏游戏可能吃掉 Win 键。那种情况用任务栏最右侧「显示桌面」，两条路径是同一次 Shell 操作。辅助进程如果几百毫秒就换一个 PID，先看 PowerShell 是不是编译失败（没有 BOM 就是这个），不要改 `SeatAboveDesktop`。
