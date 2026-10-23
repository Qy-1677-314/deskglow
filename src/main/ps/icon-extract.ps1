param(
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Size = 128
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public class DgIcons
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern uint PrivateExtractIcons(string szFileName, int nIconIndex, int cxIcon, int cyIcon,
        IntPtr[] phicon, uint[] piconid, uint nIcons, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll", EntryPoint = "SHGetFileInfo", CharSet = CharSet.Unicode)]
    static extern IntPtr SHGetFileInfoPidl(IntPtr pidl, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);

    [DllImport("ole32.dll")]
    static extern void CoTaskMemFree(IntPtr pv);

    [DllImport("shell32.dll")]
    static extern int SHGetImageList(int iImageList, ref Guid riid, out IImageList ppv);

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll")]
    static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int istep, IntPtr hbrFlickerFree, int diFlags);

    [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IImageList
    {
        int Add(IntPtr hbmImage, IntPtr hbmMask, ref int pi);
        int ReplaceIcon(int i, IntPtr hicon, ref int pi);
        int SetOverlayImage(int iImage, int iOverlay);
        int Replace(int i, IntPtr hbmImage, IntPtr hbmMask);
        int AddMasked(IntPtr hbmImage, int crMask, ref int pi);
        int Draw(IntPtr pimldp);
        int Remove(int i);
        int GetIcon(int i, int flags, ref IntPtr picon);
    }

    static Bitmap IconToBitmap(IntPtr hIcon, int size)
    {
        if (hIcon == IntPtr.Zero) return null;
        try
        {
            using (Icon ic = Icon.FromHandle(hIcon))
            {
                Bitmap b = ic.ToBitmap();
                if (b != null && b.Width > 0) return b;
            }
        }
        catch { }

        try
        {
            Bitmap b = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(b))
            {
                g.Clear(Color.Transparent);
                IntPtr hdc = g.GetHdc();
                DrawIconEx(hdc, 0, 0, hIcon, size, size, 0, IntPtr.Zero, 3);
                g.ReleaseHdc(hdc);
            }
            return b;
        }
        catch { return null; }
    }

    static Bitmap FromIconFile(string path, int index, int size)
    {
        if (string.IsNullOrEmpty(path)) return null;
        IntPtr[] h = new IntPtr[1];
        uint[] ids = new uint[1];
        uint ok = 0;
        try { ok = PrivateExtractIcons(path, index, size, size, h, ids, 1, 0); }
        catch { ok = 0; }
        if (ok == 0 || h[0] == IntPtr.Zero) return null;
        try { return IconToBitmap(h[0], size); }
        finally { DestroyIcon(h[0]); }
    }

    static Bitmap FromShell(string path, int size)
    {
        if (string.IsNullOrEmpty(path)) return null;
        SHFILEINFO sfi = new SHFILEINFO();
        IntPtr pidl = IntPtr.Zero;
        bool parsed = false;
        try
        {
            IntPtr r;
            if (path.StartsWith("::"))
            {
                uint eaten;
                if (SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out eaten) != 0 || pidl == IntPtr.Zero) return null;
                parsed = true;
                r = SHGetFileInfoPidl(pidl, 0, ref sfi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), 0x8 | 0x4000);
            }
            else
            {
                r = SHGetFileInfo(path, 0, ref sfi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), 0x4000);
            }
            if (r == IntPtr.Zero) return null;

            Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
            IImageList list;
            if (SHGetImageList(4, ref iid, out list) != 0 || list == null) return null;

            IntPtr hicon = IntPtr.Zero;
            try { if (list.GetIcon(sfi.iIcon, 1, ref hicon) != 0) return null; }
            catch { return null; }
            if (hicon == IntPtr.Zero) return null;
            try { return IconToBitmap(hicon, size); }
            finally { DestroyIcon(hicon); }
        }
        finally
        {
            if (parsed && pidl != IntPtr.Zero) CoTaskMemFree(pidl);
        }
    }

    public static string Extract(string primary, int index, string[] alts, string shell, int size)
    {
        Bitmap bmp = FromIconFile(primary, index, size);
        if (bmp == null && alts != null)
        {
            foreach (string a in alts)
            {
                if (string.IsNullOrEmpty(a)) continue;
                bmp = FromIconFile(a, 0, size);
                if (bmp != null) break;
            }
        }
        if (bmp == null) bmp = FromShell(shell, size);
        if (bmp == null) return null;

        try
        {
            using (bmp)
            using (Bitmap outBmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(outBmp))
                {
                    g.Clear(Color.Transparent);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    g.CompositingQuality = CompositingQuality.HighQuality;
                    g.DrawImage(bmp, new Rectangle(0, 0, size, size));
                }
                using (MemoryStream ms = new MemoryStream())
                {
                    outBmp.Save(ms, ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
        }
        catch { return null; }
    }
}
"@

function Expand([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $null }
  try { return [Environment]::ExpandEnvironmentVariables($p) } catch { return $p }
}

$result = @{}
$items = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($it in $items) {
  $id = [string]$it.id

  $primary = Expand ([string]$it.file)
  if ($primary -and -not (Test-Path -LiteralPath $primary)) { $primary = $null }

  $alts = @()
  foreach ($a in @($it.alts)) {
    $af = Expand ([string]$a.file)
    if ($af -and (Test-Path -LiteralPath $af)) { $alts += $af }
  }

  $shellRaw = [string]$it.shell
  $shell = $null
  if ($shellRaw.StartsWith('::')) {
    $shell = $shellRaw
  } else {
    $shell = Expand $shellRaw
    if ($shell -and -not (Test-Path -LiteralPath $shell)) { $shell = $null }
  }

  $idx = 0
  [int]::TryParse([string]$it.index, [ref]$idx) | Out-Null

  $b64 = [DgIcons]::Extract($primary, $idx, $alts, $shell, $Size)
  if ($b64) { $result[$id] = $b64 }
}

$json = ConvertTo-Json -InputObject $result -Compress -Depth 2
if ($result.Count -eq 0) { $json = '{}' }
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
