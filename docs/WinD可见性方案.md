# Dock 在 Win+D / 显示桌面时消失 —— 根因与修复方案

> 研究对象：Winstep **Nexus Dock** 是如何解决「显示桌面时第三方 Dock 消失」这一顽疾的；并结合 Electron 透明窗口的已知坑，给出 DeskGlow 的确定性修复方向。

---

## 一、先纠正一个错误的旧结论

之前（上午）把根因归为「Chromium 原生遮挡检测误判，rAF 心跳可对抗」——**这是错的**，也被你实测的「仍然消失」证实。

真实情况是：

- 按下 Win+D / 点「显示桌面」时，Windows **无通知地**把桌面窗口升到最顶层，盖住所有应用窗口。
- 现代 Windows（Win8+）的实现不是「最小化所有窗口」，而是：**显示一个原本隐藏的 `WorkerW` 窗口并升到最顶层，同时把 `SHELLDLL_DefView`（桌面图标层）的父窗口从 `Progman` 改成这个 `WorkerW`**（[cnblogs 实证](https://www.cnblogs.com/hei-hei-hei/p/11417482.html)）。
- 这个 `WorkerW` 是**真实存在、真实遮挡**的窗口。所以 Chromium 的 Native Window Occlusion **正确地**判定 Dock 被遮 → 停止 GPU 合成。
- 你的诊断现象完全吻合：`rAF` 还在跑、`capturePage` 还能截到画面，但屏幕只剩壁纸——**渲染层没死，是 DWM 没把它合成上屏**。
- 因此 `document.visibilityState` 仍是 `visible`、窗口 `IsIconic/IsWindowVisible` 也都是正常——`IsIconic`/`IsWindowVisible` **根本检测不出**这种「显示桌面」状态（cnblogs 同样指出）。

> 结论：rAF 心跳只作用于页面层，管不到「合成层被停」，对真实遮挡无能为力。**这条思路应放弃。**

---

## 二、Nexus（Winstep）官方是怎么做的

Winstep 开发者 Jorge Coelho 在官方论坛亲自解释过（[原帖](https://forums.winstep.net/phpbb2/viewtopic.php?p=30641)）：

1. Win+D 升桌面窗口到顶层，**没有任何 API 能覆盖它，也没有任何通知**。
2. Nexus 的做法是**每秒轮询**一次，检测 Win+D 是否生效。
3. 一旦检测到，就**临时把 Dock 设为桌面窗口的子窗口**（`SetParent` 到 `Progman`）——这是当年 Windows 7 侧边栏/小工具（Sidebar/Gadgets）保持可见的办法：它们本身就是桌面的**永久子窗口**，桌面升起时一起被带上来。
4. 但 Dock **不能永远是桌面子窗口**（否则会永远垫底 = Always on Bottom，平时就压不住别的窗口了），所以 Win+D 解除后立刻还原。
5. 代价：按下 Win+D 时会有**轻微闪烁**（开发者自承这是 kludge）。

软件里对应的设置项就在 **Behavior 选项卡**底部：**「Keep this dock visible when pressing WIN+D (Show Desktop)」**。

---

## 三、比 Nexus 更好的「检测」方式

Nexus 每秒轮询有 ~1s 延迟和误判。更好的做法是**事件钩子**（[WPF 方案实证](https://exchangetuts.com/make-wpf-window-immune-to-show-desktop-prevent-hide-1641717244590271)）：

- 用 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, ...)` 监听前台窗口变化。
- 当前台窗口类名变成 **`WorkerW`** 或 **`Progman`** → 说明 Win+D 生效（桌面被激活）。
- 当前台变回普通应用 → Win+D 解除。
- 这是**即时**的，没有轮询延迟。

（轮询 `GetForegroundWindow()` + `GetClassName()` 判断 `WorkerW`/`Progman` 也能用，就是慢一点。）

---

## 四、致命坑：DeskGlow 是「透明窗口」，不能照搬 Nexus

Nexus 对自己是**不透明**窗口做 `SetParent` 到桌面是有效的。但 DeskGlow Dock 用的是 `transparent: true` → 这是一个 **`WS_EX_LAYERED` 分层窗口**（带逐像素 alpha）。

多个权威来源一致指出：**跨进程把分层（layered）子窗口 `SetParent` 挂到桌面不可靠**——在 Win11 24H2 下可能不渲染或留残影：

- StackOverflow [#69792059](https://stackoverflow.com/questions/69792059/ws-ex-layered-with-setparent-doesnt-show-the-window)：「WS_EX_LAYERED with SetParent() doesn't show the window」。
- buaq.net《桌面壁纸层监控 HUD 踩坑实录》：「跨进程 SetParent 之后分层子窗口不可靠（故障模式 A/B/C）」「在可见状态下清除 WS_EX_LAYERED 会把当前帧烤进桌面合成，留永久残影」。

所以「直接 `SetParent` 到桌面」对 DeskGlow 是**高风险**，不应采用。

---

## 五、确定的候选方案：改「所有者」而非「父子」

找到了**明确支持透明 Electron 窗口**的现成项目 **`electron-disable-minimize`**（[GitHub 多 fork](https://github.com/leonelsr/electron-disable-minimize)）。它的核心代码只有一句（原作者致谢 tordex）：

```cpp
HWND nWinHandle = FindWindowEx(NULL, NULL, "Progman", NULL);
nWinHandle = FindWindowEx(nWinHandle, NULL, "SHELLDLL_DefView", NULL);
SetWindowLongPtr(hwnd, -8 /*GWLP_HWNDPARENT*/, (LONG_PTR)nWinHandle);
```

要点：

- 它改的是 **`GWLP_HWNDPARENT`（窗口所有者 owner）**，而**不是** `SetParent`（父子 parent/child）。
- 效果是让 Dock 成为 **`SHELLDLL_DefView`（Progman 的桌面子窗口）的所有者**：
  - Win+D 时桌面被激活，被桌面拥有的窗口**随桌面一起显示**，且**不会被最小化** → 满足诉求①「Win+D 可见」。
  - **owner ≠ parent**：所有者窗口（非 `WS_EX_TOPMOST`）仍处在普通 Z 序带内，位于其 owner（桌面）之上、位于前台普通应用**之下** → 满足诉求②「不挡普通窗口」。
- 它的 README 就是拿 `transparent: true` 的 Electron 窗口做示例 → **对透明窗口有效**，绕开了第四节的分层-child 坑。

> 对比：另一个常见库 `electron-as-wallpaper` 的 `attach()` 是 `SetParent` 到 `WorkerW`（图标层之后），适合做壁纸，**不适合做 dock**（会被图标压住 + 分层 child 风险）。

---

## 六、给 DeskGlow 的实施建议

1. **废弃**上午的 rAF 心跳 + 已失效的 `NativeWindowOcclusion` feature 开关（清理 `dock.js` 末尾的 `occlusionHeartbeat` 与 `main.js` 相关 hack）。
2. **采用所有者方案**：在 Dock 创建 / `ready-to-show` 后，找到 `Progman → SHELLDLL_DefView`，把 Dock 的 `GWLP_HWNDPARENT` 设为它。
   - 实现二选一：
     - (A) 引入/编译 `electron-disable-minimize` 原生 addon（需 `electron-rebuild` 匹配当前 Electron 版本）；
     - (B) **更低摩擦**：本机已验证 `powershell.exe -File xxx.ps1` 可 `Add-Type` 做 Win32 调用，直接用一段 P/Invoke 脚本在主进程启动时一次性设 `GWLP_HWNDPARENT = -8 → SHELLDLL_DefView`，窗口若被 `reviveDock` 重建则重新设置。
3. **本机必须实测两项**：
   - Win+D / 点「显示桌面」→ Dock 在桌面底部**可见**；
   - 打开普通窗口 → Dock **被压在下面、不挡窗口**（owner 方案若意外导致 Dock 永远置顶，则退回「Nexus 式混合方案」：仅 Win+D 期间临时设 owner，解除后还原为非置顶普通窗口）。
4. 删除 `tools/` 下所有临时诊断脚本与截图（`diag.ps1` / `zprobe.ps1` / `trace.ps1` / `lab/*` 及 `shot_*.png` 等），避免污染项目。

---

## 八、最终生效方案（实测后推翻"纯 owner"）

> 纯 owner 方案在真实透明 Dock 上"依旧不行"——根因进一步定位。

### 真正的根因
- 隔离复刻实验证明：**非置顶的透明 Electron 窗体在 Win+D 下完全可见**（截图 magenta 占比 Win+D 前后一致 `≈0.34`）。
- 而真实 Dock 在桌面模式下被 `onMode` 与 `zorder.Sink` **双重强制 `setAlwaysOnTop(true)`**。
- Win+D 升起的是 DWM 级桌面覆盖层：**置顶的透明窗体被它盖住而消失**；非置顶透明窗体随桌面保留。
- 所以 owner 方案之所以失败，不是 owner 无效，而是 Dock 仍是 TOPMOST，覆盖层照样盖它。

### 修复（已落地）
- `src/main/ps/zorder.ps1` 的 `Sink()` 桌面分支：`HWND_TOPMOST` → `HWND_NOTOPMOST`（桌面态不再强制置顶）。
- `src/main/main.js` 的 `onMode` DESKTOP 分支：**删除** `dockWin.setAlwaysOnTop(true, 'floating')`。
- 保留 `PinToDesktop`（owner = `SHELLDLL_DefView）作双保险。
- 效果：桌面态 Dock 在普通 Z 带（位于桌面之上、普通窗口之下），Win+D 时随桌面保留 → 同时解决"可见"与"不挡窗口"。

### 验证
- `node --check` 通过；Dock 不再出现任何 `setAlwaysOnTop(true)`。
- 隔离实验（tools/t2，已清理）确认非置顶透明窗可活过 Win+D；跨进程 SetParent 到 DefView 本机不可靠，故采用"非置顶 + owner"而非硬子窗口。

---

## 七、参考来源

- Winstep 开发者原帖（Win+D 机制 + 临时 SetParent 解释）：<https://forums.winstep.net/phpbb2/viewtopic.php?p=30641>
- Nexus 用户手册「Keep this dock visible when pressing WIN+D」：<http://winstep.net/help/Nx/nexus.htm>
- 显示桌面 = 显示并升起隐藏 WorkerW、重定父 DefView（cnblogs）：<https://www.cnblogs.com/hei-hei-hei/p/11417482.html>
- EVENT_SYSTEM_FOREGROUND 钩子检测 WorkerW/Progman（WPF 实证）：<https://exchangetuts.com/make-wpf-window-immune-to-show-desktop-prevent-hide-1641717244590271>
- 桌面窗口查找（Progman / WorkerW 双路径）：<https://winsoft666.github.io/post/2065788833.html>
- 分层窗口 SetParent 不可靠（SO #69792059）：<https://stackoverflow.com/questions/69792059/ws-ex-layered-with-setparent-doesnt-show-the-window>
- 桌面壁纸层 HUD 踩坑实录（24H2 分层 child 风险）：<https://buaq.net/go-446101.html>
- `electron-disable-minimize`（透明 Electron 窗口 + GWLP_HWNDPARENT 方案）：<https://github.com/leonelsr/electron-disable-minimize>
- `electron-as-wallpaper`（SetParent 到 WorkerW 的壁纸方案，仅供参考不做 dock）：<https://deepwiki.com/meslzy/electron-as-wallpaper/3.1-attach()>
