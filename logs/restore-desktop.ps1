Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DgCount {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static int Apps; public static int Ico;
  public static bool On(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var t = new StringBuilder(80); GetWindowText(h, t, 80);
    if (t.Length < 2) return true;
    Apps++; if (IsIconic(h)) Ico++;
    return true;
  }
}
"@
$cb = [DgCount+EnumProc]{ param($h,$l) [DgCount]::On($h,$l) }
$global:ct = $cb
[void][DgCount]::EnumWindows($global:ct, [IntPtr]::Zero)
Write-Output ("apps=" + [DgCount]::Apps + " iconic=" + [DgCount]::Ico)
if ([DgCount]::Ico -gt 3) {
  [DgCount]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
  [DgCount]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
  [DgCount]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
  [DgCount]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
  Write-Output 'sent Win+D to restore'
}
