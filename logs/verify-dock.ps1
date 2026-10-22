Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Text;
using System.Runtime.InteropServices;
public static class DgSeeDock {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public struct RECT { public int L,T,R,B; }
  public static IntPtr Dock;
  public static RECT R;
  public static bool Find(IntPtr h, IntPtr l) {
    var t = new StringBuilder(80); GetWindowText(h, t, 80);
    if (t.ToString() == "DeskGlow Dock") { Dock = h; GetWindowRect(h, out R); }
    return true;
  }
  public static void Locate() {
    Dock = IntPtr.Zero;
    EnumProc cb = Find; EnumWindows(cb, IntPtr.Zero); GC.KeepAlive(cb);
  }
  public static int Avg() {
    int h = Math.Max(20, R.B - R.T);
    var bmp = new Bitmap(R.R - R.L, h);
    using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(R.L, R.T, 0, 0, new Size(bmp.Width, bmp.Height));
    long sum = 0; int n = 0; int light = 0;
    for (int y = 6; y < h - 6; y += 4) {
      for (int x = 20; x < bmp.Width - 20; x += 8) {
        var c = bmp.GetPixel(x, y);
        int v = c.R + c.G + c.B;
        sum += v; n++;
        if (c.R > 210 && c.G > 210 && c.B > 210) light++;
      }
    }
    bmp.Save(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dg-dock-band.png"), System.Drawing.Imaging.ImageFormat.Png);
    bmp.Dispose();
    return (int)(sum / Math.Max(1, n)) * 100000 + light;
  }
  public static void WinD() {
    keybd_event(0x5B, 0, 0, UIntPtr.Zero); keybd_event(0x44, 0, 0, UIntPtr.Zero);
    keybd_event(0x44, 0, 2, UIntPtr.Zero); keybd_event(0x5B, 0, 2, UIntPtr.Zero);
  }
}
"@ -ReferencedAssemblies System.Windows.Forms,System.Drawing
[DgSeeDock]::Locate()
if ([DgSeeDock]::Dock -eq [IntPtr]::Zero) { Write-Output 'no dock'; exit 1 }
Write-Output ("dock y=" + [DgSeeDock]::R.T + " h=" + ([DgSeeDock]::R.B - [DgSeeDock]::R.T))
[DgSeeDock]::WinD()
Start-Sleep -Milliseconds 1200
[DgSeeDock]::Locate()
$pack = [DgSeeDock]::Avg()
$avg = [int][Math]::Floor($pack / 100000)
$light = $pack % 100000
Write-Output ("desktop avg=$avg light=$light")
[DgSeeDock]::WinD()
Write-Output 'restored'
