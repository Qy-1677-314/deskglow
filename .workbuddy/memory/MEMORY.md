# DeskGlow 项目长期备忘

## 弹窗网格与滚动条的耦合（2026-10-21 修复，勿回退）

- `src/renderer/popup.css` 的 `.body` 必须保留 `scrollbar-gutter: stable`。原因：弹窗网格 `repeat(auto-fill, minmax(100px,1fr))` 的列数会被 8px 经典滚动条的出现/消失改变（620px 是 5/6 列分界），与 `fit()` 的高度钳制（420+82）形成极限环，表现为 5/6 列抽搐；长名字文件（2 行名→行高非单调）会把系统推进振荡区。去掉该属性 = bug 复现。
- 同类风险排查过：面板、Dock（flex-wrap 非滚动网格）、小组件均无此模式；只有 popup 的 `.body` 需要这条属性。
- 改弹窗布局时的自保规则：任何「高度/宽度由内容测量再回写窗口」的逻辑（popup:fit、widget:fit）都要保证测量值与滚动条状态解耦，否则会重演此类振荡。

## 窗口层级 / Win+D 代码归用户维护（2026-10-21 起，最高优先级约束）
- 用户已亲自修复窗口层级与 Win+D / 显示桌面功能。今后对本软件的**任何**修改一律不得触碰这部分功能，不得顺手重构/清理/重写所列文件与调用。
- 只有用户当面明确要求改某一处时才动，且动手前必读 `.cursor/skills/deskgow-show-desktop/SKILL.md`。
- 完整契约见 `AGENTS.md` 与 `.cursor/rules/dock-zorder.mdc`。

### 冻结范围
- `src/main/ps/zorder.ps1`（`Sink`/`SeatAboveDesktop`/`PinToDesktop`/`IsAbove`/`LowestRealApp`；必须 UTF-8 带 BOM）
- `src/main/zorder.js`（拉起辅助进程、`exitCode == null` 退出判断、`-ExecutionPolicy Bypass`、启动前自检）
- `src/main/main.js`（Dock 的 `setAlwaysOnTop(false)`；只调用 `zorder.sink()`）
- `src/renderer/dock.js`（不得用 rAF 心跳 / opacity / invalidate 处理 Dock 消失）

### 硬性禁止
- 对 Dock 调 `setAlwaysOnTop(true)` 或 `setVisibleOnAllWorkspaces`
- `SetParent` 到 `Progman`/`WorkerW`/`SHELLDLL_DefView`；用 `HWND_TOP` 代替 `SeatAboveDesktop`
- 把 Z 序向上查找收成几百次；加回 `AtTopOfNormalBand`
