Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Shot {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$app = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } |
  Select-Object -First 1
if (-not $app) { Write-Output 'no app window found'; exit 1 }
$hwnd = $app.MainWindowHandle
Write-Output "app hwnd $hwnd : $($app.MainWindowTitle)"

$rect = New-Object Shot+RECT
[void][Shot]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

# 1) The window's own rendering, without moving it or stealing focus.
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [Shot]::PrintWindow($hwnd, $dc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($dc)
$g.Dispose()
$bmp.Save('D:\deepseek-kernel-harness\.recon\shot-printwindow.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "PrintWindow returned $ok -> shot-printwindow.png ($w x $h)"

# 2) Raise it properly: a background process may not set the foreground, but attaching to
#    the current foreground thread's input queue lifts that restriction.
$fore = [Shot]::GetForegroundWindow()
$foreThread = [Shot]::GetWindowThreadProcessId($fore, [IntPtr]::Zero)
$mine = [Shot]::GetCurrentThreadId()
[void][Shot]::AttachThreadInput($mine, $foreThread, $true)
[void][Shot]::ShowWindow($hwnd, 9)
Start-Sleep -Milliseconds 300
[void][Shot]::SetForegroundWindow($hwnd)
[void][Shot]::AttachThreadInput($mine, $foreThread, $false)
Start-Sleep -Milliseconds 1200
$now = [Shot]::GetForegroundWindow()
Write-Output "foreground is now the app: $($now -eq $hwnd)"

if ($now -eq $hwnd) {
  $bmp2 = New-Object System.Drawing.Bitmap($w, $h)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
  $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp2.Size)
  $g2.Dispose()
  $bmp2.Save('D:\deepseek-kernel-harness\.recon\shot-foreground.png', [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp2.Dispose()
  Write-Output "composited capture -> shot-foreground.png ($w x $h)"
} else {
  $other = Get-Process | Where-Object { $_.MainWindowHandle -eq $now } | Select-Object -First 1
  Write-Output "still not in front; in front is: $($other.ProcessName) - $($other.MainWindowTitle)"
}
