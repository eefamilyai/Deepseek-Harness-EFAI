Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Corners {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$app = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object -First 1
$hwnd = $app.MainWindowHandle
$fore = [Corners]::GetForegroundWindow()
[void][Corners]::AttachThreadInput([Corners]::GetCurrentThreadId(), [Corners]::GetWindowThreadProcessId($fore, [IntPtr]::Zero), $true)
[void][Corners]::ShowWindow($hwnd, 9)
[void][Corners]::SetForegroundWindow($hwnd)
[void][Corners]::AttachThreadInput([Corners]::GetCurrentThreadId(), [Corners]::GetWindowThreadProcessId($fore, [IntPtr]::Zero), $false)
Start-Sleep -Milliseconds 1500
Write-Output "app in front: $([Corners]::GetForegroundWindow() -eq $hwnd)"

$r = New-Object Corners+RECT
[void][Corners]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top

$screen = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($screen)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $screen.Size)
$g.Dispose()
$screen.Save('D:\deepseek-kernel-harness\.recon\shot-corners.png', [System.Drawing.Imaging.ImageFormat]::Png)

# The four corners, 120px each, blown up and laid out in one strip for inspection.
$size = 120
$zoom = 2
$strip = New-Object System.Drawing.Bitmap(($size * 4 * $zoom), ($size * $zoom))
$sg = [System.Drawing.Graphics]::FromImage($strip)
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$spots = @(
  @{ x = 0;             y = 0 },
  @{ x = $w - $size;    y = 0 },
  @{ x = 0;             y = $h - $size },
  @{ x = $w - $size;    y = $h - $size }
)
for ($i = 0; $i -lt 4; $i++) {
  $src = New-Object System.Drawing.Rectangle($spots[$i].x, $spots[$i].y, $size, $size)
  $dst = New-Object System.Drawing.Rectangle(($i * $size * $zoom), 0, ($size * $zoom), ($size * $zoom))
  $sg.DrawImage($screen, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
}
$sg.Dispose()
$strip.Save('D:\deepseek-kernel-harness\.recon\corners-strip.png', [System.Drawing.Imaging.ImageFormat]::Png)
$screen.Dispose(); $strip.Dispose()
Write-Output "captured $w x $h -> shot-corners.png, corners-strip.png"
