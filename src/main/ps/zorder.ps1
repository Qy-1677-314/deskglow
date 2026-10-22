# FROZEN. Do not rewrite Sink, SeatAboveDesktop, PinToDesktop, IsAbove, or LowestRealApp
# unless the user explicitly asked to change Win+D / Show Desktop behavior.
# Contract: AGENTS.md and .cursor/skills/deskgow-show-desktop/SKILL.md
# This file must stay UTF-8 with BOM. Without the BOM the helper exits immediately.
# Dock stays above the desktop and below normal app windows.
# Show Desktop raises Progman (Win11 24H2) or a WorkerW. Apps under that host
# must not count, or the Dock is left buried beneath the desktop.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeskGlowZ {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rc);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string name);

  public struct RECT { public int left, top, right, bottom; }

  const uint GW_HWNDNEXT = 2;
  const uint GW_HWNDPREV = 3;
  // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING
  const uint Flags = 0x613;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOPMOST = 0x8;
  const int WS_EX_TRANSPARENT = 0x20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const int WS_EX_APPWINDOW = 0x40000;
  static readonly IntPtr HWND_TOP = IntPtr.Zero;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  const int DWMWA_CLOAK = 13;
  const int DWMWA_CLOAKED = 14;
  const int GWL_HWNDPARENT = -8;

  static string ClassOf(IntPtr h) {
    var cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    return cls.ToString();
  }

  static string ImageOf(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return "";
    IntPtr proc = OpenProcess(0x1000, false, pid);
    if (proc == IntPtr.Zero) return "";
    var buf = new StringBuilder(520);
    int size = buf.Capacity;
    bool ok = QueryFullProcessImageName(proc, 0, buf, ref size);
    CloseHandle(proc);
    return ok ? buf.ToString().ToLowerInvariant() : "";
  }

  static bool IsCloaked(IntPtr h) {
    int v;
    if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, 4) != 0) return false;
    return v != 0;
  }

  static bool IsRealApp(IntPtr h, IntPtr self) {
    if (h == IntPtr.Zero || h == self) return false;
    if (!IsWindowVisible(h) || IsIconic(h) || IsCloaked(h)) return false;
    string c = ClassOf(h);
    if (c == "Progman" || c == "WorkerW" || c == "SHELLDLL_DefView") return false;
    if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return false;
    if (c == "NotifyIconOverflowWindow" || c == "TopLevelWindowForOverflowXamlIsland") return false;
    if (c == "Windows.UI.Core.CoreWindow" || c == "ForegroundStaging" || c == "DummyDWMListener") return false;
    if (c == "EdgeUiInputTopWndClass" || c == "EdgeUiInputWndClass") return false;
    if (c.StartsWith("CEF-OSC")) return false;
    if (c.IndexOf("Overlay", StringComparison.OrdinalIgnoreCase) >= 0) return false;
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    // 置顶窗口不能当插入点。SetWindowPos 的插入点如果是置顶窗，Dock 自己也会变成置顶。
    // Win+D 的桌面层会盖住置顶透明窗，Dock 就整片消失。
    if ((ex & WS_EX_TOPMOST) != 0) return false;
    if ((ex & WS_EX_TRANSPARENT) != 0) return false;
    if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0) return false;
    string image = ImageOf(h);
    if (image.Contains("wallpaper64.exe") || image.Contains("wallpaper32.exe") || image.Contains("wallpaperservice")) return false;
    if (image.EndsWith("\\explorer.exe") && c != "CabinetWClass" && c != "ExploreWClass") return false;
    RECT rc;
    if (!GetWindowRect(h, out rc)) return false;
    if (rc.right - rc.left < 80 || rc.bottom - rc.top < 60) return false;
    return true;
  }

  static IntPtr progFound;
  static bool CatchProg(IntPtr h, IntPtr l) {
    if (ClassOf(h) == "Progman") { progFound = h; return false; }
    return true;
  }

  static IntPtr DesktopWindow() {
    IntPtr prog = FindWindow("Progman", null);
    if (prog != IntPtr.Zero) return prog;
    progFound = IntPtr.Zero;
    EnumProc cb = CatchProg;
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    return progFound;
  }

  static IntPtr DefView() {
    IntPtr prog = FindWindow("Progman", null);
    if (prog != IntPtr.Zero) {
      IntPtr dv = FindWindowEx(prog, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (dv != IntPtr.Zero) return dv;
    }
    // Win8+ 兜底：WorkerW 之下也可能挂着 SHELLDLL_DefView
    IntPtr found = IntPtr.Zero;
    EnumProc cb = (IntPtr h, IntPtr l) => {
      if (ClassOf(h) == "WorkerW") {
        IntPtr dv = FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (dv != IntPtr.Zero) { found = dv; return false; }
      }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    return found;
  }

  // 所有者设为 SHELLDLL_DefView，不是 SetParent。
  // 分层透明窗口跨进程挂成桌面子窗口在这台系统上不可靠。
  // 显示桌面时把 Dock 留在画面里靠的是 Sink：插到桌面层正上方，并且不进入置顶带。
  public static void PinToDesktop(long hwndValue) {
    IntPtr hwnd = new IntPtr(hwndValue);
    IntPtr def = DefView();
    if (def == IntPtr.Zero) return;
    try {
      IntPtr cur = GetWindowLongPtr(hwnd, GWL_HWNDPARENT);
      if (cur != def) SetWindowLongPtr(hwnd, GWL_HWNDPARENT, def);
    } catch { /* ignore */ }
  }

  static bool IsShellDesktopClass(string c) {
    return c == "Progman" || c == "WorkerW" || c == "SHELLDLL_DefView";
  }

  static bool HasTopmost(IntPtr h) {
    return (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
  }

  // Win11 24H2：图标层在 Progman 里。更早的系统，或 Win+D 把 DefView 带走时，宿主是 WorkerW。
  static IntPtr DesktopHost() {
    IntPtr fg = GetForegroundWindow();
    if (fg != IntPtr.Zero && ClassOf(fg) == "WorkerW") {
      if (FindWindowEx(fg, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return fg;
    }
    IntPtr prog = DesktopWindow();
    if (prog != IntPtr.Zero && FindWindowEx(prog, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return prog;
    IntPtr found = IntPtr.Zero;
    EnumProc cb = (IntPtr h, IntPtr l) => {
      if (ClassOf(h) == "WorkerW" && FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
        found = h;
        return false;
      }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    return found != IntPtr.Zero ? found : prog;
  }

  // 桌面宿主以及紧贴在它上面的 Progman/WorkerW 算同一层，Dock 要高于这一整层。
  static IntPtr TopOfDesktopStack(IntPtr host) {
    IntPtr top = host;
    IntPtr prev = host == IntPtr.Zero ? IntPtr.Zero : GetWindow(host, GW_HWNDPREV);
    int guard = 0;
    while (prev != IntPtr.Zero && guard++ < 40 && IsShellDesktopClass(ClassOf(prev))) {
      top = prev;
      prev = GetWindow(prev, GW_HWNDPREV);
    }
    return top;
  }

  static bool IsAbove(IntPtr hwnd, IntPtr other) {
    if (hwnd == IntPtr.Zero || other == IntPtr.Zero) return false;
    IntPtr prev = GetWindow(other, GW_HWNDPREV);
    int guard = 0;
    while (prev != IntPtr.Zero && guard++ < 4000) {
      if (prev == hwnd) return true;
      prev = GetWindow(prev, GW_HWNDPREV);
    }
    return false;
  }

  static IntPtr LowestRealApp(IntPtr self, IntPtr shellTop) {
    if (shellTop == IntPtr.Zero) return IntPtr.Zero;
    IntPtr prev = GetWindow(shellTop, GW_HWNDPREV);
    int guard = 0;
    while (prev != IntPtr.Zero && guard++ < 4000) {
      if (IsRealApp(prev, self)) return prev;
      prev = GetWindow(prev, GW_HWNDPREV);
    }
    return IntPtr.Zero;
  }

  // 显示桌面把 Progman 升到普通窗口之上。HWND_TOP 跨不过这层（实测 dock 仍在 prog 下面）。
  // 只在这一刻进入置顶带，并贴在置顶带最底部：高于桌面，低于其它置顶窗。
  // 不要停在 HWND_TOPMOST 的最顶上，那一层会被桌面盖住。
  static void SeatAboveDesktop(IntPtr hwnd, IntPtr shellTop) {
    const uint lift = 0x13; // NOSIZE | NOMOVE | NOACTIVATE
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, lift);
    IntPtr prev = shellTop == IntPtr.Zero ? IntPtr.Zero : GetWindow(shellTop, GW_HWNDPREV);
    int guard = 0;
    while (prev != IntPtr.Zero && guard++ < 4000) {
      if (prev != hwnd && HasTopmost(prev)) {
        SetWindowPos(hwnd, prev, 0, 0, 0, 0, lift);
        return;
      }
      prev = GetWindow(prev, GW_HWNDPREV);
    }
    // 没找到置顶锚点就不能停在 HWND_TOPMOST 最顶上，否则会盖住普通窗口。
    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, lift);
  }

  static void UncloakApp(IntPtr hwnd) {
    int v;
    if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out v, 4) != 0) return;
    if ((v & 1) == 0) return;
    int zero = 0;
    DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, ref zero, 4);
  }

  public static bool Sink(long hwndValue) {
    IntPtr hwnd = new IntPtr(hwndValue);
    PinToDesktop(hwndValue);
    UncloakApp(hwnd);
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    else if (!IsWindowVisible(hwnd)) ShowWindow(hwnd, 8);

    IntPtr shellTop = TopOfDesktopStack(DesktopHost());
    IntPtr lowest = LowestRealApp(hwnd, shellTop);

    // 有普通窗口盖在桌面上：退出置顶带，贴在最底那个窗口的下面。
    // Dock 仍高于桌面，但打开的程序都会盖住它。
    if (lowest != IntPtr.Zero) {
      if (HasTopmost(hwnd)) SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, Flags);
      if (GetWindow(lowest, GW_HWNDNEXT) != hwnd) SetWindowPos(hwnd, lowest, 0, 0, 0, 0, Flags);
      return false;
    }

    // Win+D / 点到桌面 / 没有其它窗口。已经高于桌面就不要反复 SetWindowPos。
    // 掉到 Progman 下面时，贴到置顶带底部。有普通窗口后，上面的分支会退出置顶。
    if (!IsAbove(hwnd, shellTop)) SeatAboveDesktop(hwnd, shellTop);
    return true;
  }
}
"@
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    $desk = [DeskGlowZ]::Sink([Int64]::Parse($line))
    if ($desk) { [Console]::Out.WriteLine('DESKTOP') } else { [Console]::Out.WriteLine('APP') }
    [Console]::Out.Flush()
  } catch {}
}
