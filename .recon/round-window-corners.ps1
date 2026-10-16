Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dwm {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
}
"@

$app = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object -First 1
if (-not $app) { Write-Output 'no app window'; exit 1 }
$hwnd = $app.MainWindowHandle
Write-Output "window hwnd $hwnd : $($app.MainWindowTitle)"

# DWMWA_WINDOW_CORNER_PREFERENCE = 33 ; DWMWCP_DEFAULT=0, DONOTROUND=1, ROUND=2, ROUNDSMALL=3
foreach ($round in 2, 3) {
  $value = $round
  $hr = [Dwm]::DwmSetWindowAttribute($hwnd, 33, [ref]$value, 4)
  Start-Sleep -Milliseconds 400
  $read = -1
  [void][Dwm]::DwmGetWindowAttribute($hwnd, 33, [out]$read, 4)
  Write-Output "set corner preference = $round -> hr=$hr (0 is success), DWM now reports $read"
}

# DWMWA_SYSTEMBACKDROP_TYPE = 38 ; DWMSBT_AUTO=0, NONE=1, MAINWINDOW=2, TRANSIENTWINDOW=3, TABBEDWINDOW=4
$backdrop = 3
$hr2 = [Dwm]::DwmSetWindowAttribute($hwnd, 38, [ref]$backdrop, 4)
Start-Sleep -Milliseconds 400
$read2 = -1
[void][Dwm]::DwmGetWindowAttribute($hwnd, 38, [out]$read2, 4)
Write-Output "set system backdrop = acrylic(3) -> hr=$hr2, DWM now reports $read2"
