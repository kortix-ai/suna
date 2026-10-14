param(
  [string]$ManifestPath = (Join-Path $env:TEMP "kortix-windows-user-flow-manifest.json"),
  [ValidateSet("notepad", "browser_form", "notepad_advanced", "notepad_selection_shortcuts", "notepad_mouse_selection", "notepad_shift_drag_selection", "notepad_triple_click_text", "notepad_menu_shortcuts", "notepad_context_menu", "notepad_window_controls", "notepad_window_mouse", "notepad_window_resize", "notepad_save_dialog", "notepad_find_dialog", "notepad_replace_dialog", "notepad_print_dialog", "explorer_file_rename", "explorer_new_folder", "explorer_drag_drop", "explorer_file_open", "windows_run_calculator", "browser_modifiers", "browser_mouse_variants", "browser_clipboard_shortcuts", "browser_keyboard_navigation", "browser_editing_keys", "browser_word_shortcuts", "browser_capslock_typing")]
  [string]$Scenario = "notepad"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class KortixUser32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto, EntryPoint="SendMessage")] public static extern IntPtr SendMessageText(IntPtr hWnd, uint msg, int wParam, StringBuilder lParam);
  [DllImport("user32.dll", SetLastError=true, EntryPoint="SendMessage")] public static extern IntPtr SendMessagePtr(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern short GetKeyState(int nVirtKey);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
}
"@

Add-Type -TypeDefinition $source

$INPUT_MOUSE = [uint32]0
$INPUT_KEYBOARD = [uint32]1
$MOUSEEVENTF_MOVE = [uint32]0x0001
$MOUSEEVENTF_LEFTDOWN = [uint32]0x0002
$MOUSEEVENTF_LEFTUP = [uint32]0x0004
$MOUSEEVENTF_RIGHTDOWN = [uint32]0x0008
$MOUSEEVENTF_RIGHTUP = [uint32]0x0010
$MOUSEEVENTF_MIDDLEDOWN = [uint32]0x0020
$MOUSEEVENTF_MIDDLEUP = [uint32]0x0040
$MOUSEEVENTF_WHEEL = [uint32]0x0800
$MOUSEEVENTF_ABSOLUTE = [uint32]0x8000
$MOUSE_WHEEL_POSITIVE_DELTA = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]480), 0)
$MOUSE_WHEEL_NEGATIVE_DELTA = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]-480), 0)
$KEYEVENTF_KEYUP = [uint32]0x0002
$KEYEVENTF_UNICODE = [uint32]0x0004
$VK_RETURN = [uint16]0x0D
$VK_BACK = [uint16]0x08
$VK_DELETE = [uint16]0x2E
$VK_CONTROL = [uint16]0x11
$VK_MENU = [uint16]0x12
$VK_SHIFT = [uint16]0x10
$VK_TAB = [uint16]0x09
$VK_ESCAPE = [uint16]0x1B
$VK_CAPITAL = [uint16]0x14
$VK_LWIN = [uint16]0x5B
$VK_PRIOR = [uint16]0x21
$VK_NEXT = [uint16]0x22
$VK_END = [uint16]0x23
$VK_HOME = [uint16]0x24
$VK_A = [uint16]0x41
$VK_C = [uint16]0x43
$VK_E = [uint16]0x45
$VK_F = [uint16]0x46
$VK_H = [uint16]0x48
$VK_N = [uint16]0x4E
$VK_P = [uint16]0x50
$VK_R = [uint16]0x52
$VK_S = [uint16]0x53
$VK_V = [uint16]0x56
$VK_X = [uint16]0x58
$VK_Y = [uint16]0x59
$VK_Z = [uint16]0x5A
$VK_SPACE = [uint16]0x20
$VK_LEFT = [uint16]0x25
$VK_UP = [uint16]0x26
$VK_RIGHT = [uint16]0x27
$VK_DOWN = [uint16]0x28
$VK_ADD = [uint16]0x6B
$VK_F2 = [uint16]0x71
$VK_F4 = [uint16]0x73
$VK_F5 = [uint16]0x74
$WM_GETTEXT = [uint32]0x000D
$WM_GETTEXTLENGTH = [uint32]0x000E

function Send-MouseInput([uint32]$flags, [int]$dx = 0, [int]$dy = 0, [uint32]$data = 0) {
  [KortixUser32]::mouse_event($flags, $dx, $dy, $data, [UIntPtr]::Zero)
}

function Send-MouseInputViaSendInput([uint32]$flags, [int]$dx = 0, [int]$dy = 0, [uint32]$data = 0) {
  $input = New-Object KortixUser32+INPUT
  $input.type = $INPUT_MOUSE
  $input.U.mi.dx = $dx
  $input.U.mi.dy = $dy
  $input.U.mi.mouseData = $data
  $input.U.mi.dwFlags = $flags
  [KortixUser32]::SendInput(1, @($input), [Runtime.InteropServices.Marshal]::SizeOf([type][KortixUser32+INPUT])) | Out-Null
}

function Send-MouseRelease([uint32]$flags) {
  Send-MouseInput $flags
  Start-Sleep -Milliseconds 20
  Send-MouseInputViaSendInput $flags
}

function Send-MouseAbsoluteMove([int]$x, [int]$y) {
  $screenWidth = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(0) - 1)
  $screenHeight = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(1) - 1)
  $absX = [int][Math]::Round($x * 65535 / $screenWidth)
  $absY = [int][Math]::Round($y * 65535 / $screenHeight)
  Send-MouseInput ($MOUSEEVENTF_MOVE -bor $MOUSEEVENTF_ABSOLUTE) $absX $absY 0
}

function Normalize-X([int]$x) {
  $screenWidth = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(0))
  return [Math]::Round($x / $screenWidth, 4)
}

function Normalize-Y([int]$y) {
  $screenHeight = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(1))
  return [Math]::Round($y / $screenHeight, 4)
}

function Send-KeyInput([uint16]$vk, [bool]$up = $false) {
  [KortixUser32]::keybd_event([byte]$vk, [byte]0, $(if ($up) { $KEYEVENTF_KEYUP } else { [uint32]0 }), [UIntPtr]::Zero)
}

function Send-UnicodeChar([char]$ch) {
  $down = New-Object KortixUser32+INPUT
  $down.type = $INPUT_KEYBOARD
  $down.U.ki.wScan = [uint16][int][char]$ch
  $down.U.ki.dwFlags = $KEYEVENTF_UNICODE
  $up = New-Object KortixUser32+INPUT
  $up.type = $INPUT_KEYBOARD
  $up.U.ki.wScan = [uint16][int][char]$ch
  $up.U.ki.dwFlags = ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)
  [KortixUser32]::SendInput(2, @($down, $up), [Runtime.InteropServices.Marshal]::SizeOf([type][KortixUser32+INPUT])) | Out-Null
}

function Send-Text([string]$text, [int]$DelayMs = 35) {
  foreach ($ch in $text.ToCharArray()) {
    Send-UnicodeChar $ch
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Send-AsciiText([string]$text, [int]$DelayMs = 35) {
  foreach ($ch in $text.ToLowerInvariant().ToCharArray()) {
    if ($ch -eq ' ') {
      $vk = $VK_SPACE
    } elseif ($ch -ge 'a' -and $ch -le 'z') {
      $vk = [uint16]([int][char]'A' + ([int][char]$ch - [int][char]'a'))
    } elseif ($ch -ge '0' -and $ch -le '9') {
      $vk = [uint16][int][char]$ch
    } else {
      Send-UnicodeChar $ch
      Start-Sleep -Milliseconds $DelayMs
      continue
    }
    Send-KeyInput $vk
    Start-Sleep -Milliseconds 25
    Send-KeyInput $vk $true
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Send-KeyboardText([string]$text, [int]$DelayMs = 35) {
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq ' ') {
      $vk = $VK_SPACE
      Press-Key $vk 35
      Start-Sleep -Milliseconds $DelayMs
      continue
    }

    if ($ch -ge 'a' -and $ch -le 'z') {
      $vk = [uint16]([int][char]'A' + ([int][char]$ch - [int][char]'a'))
      Press-Key $vk 35
      Start-Sleep -Milliseconds $DelayMs
      continue
    }

    if ($ch -ge 'A' -and $ch -le 'Z') {
      $vk = [uint16]([int][char]'A' + ([int][char]$ch - [int][char]'A'))
      Send-KeyInput $VK_SHIFT
      Start-Sleep -Milliseconds 30
      Press-Key $vk 35
      Start-Sleep -Milliseconds 30
      Send-KeyInput $VK_SHIFT $true
      Start-Sleep -Milliseconds $DelayMs
      continue
    }

    if ($ch -ge '0' -and $ch -le '9') {
      $vk = [uint16][int][char]$ch
      Press-Key $vk 35
      Start-Sleep -Milliseconds $DelayMs
      continue
    }

    Send-UnicodeChar $ch
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Press-Key([uint16]$vk, [int]$HoldMs = 40) {
  Send-KeyInput $vk
  Start-Sleep -Milliseconds $HoldMs
  Send-KeyInput $vk $true
}

function Test-ToggleKeyOn([uint16]$vk) {
  return (([int][KortixUser32]::GetKeyState([int]$vk)) -band 1) -ne 0
}

function Press-CtrlA() {
  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_A
  Start-Sleep -Milliseconds 60
  Send-KeyInput $VK_A $true
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_CONTROL $true
}

function Press-CtrlKey([uint16]$vk) {
  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 40
  Send-KeyInput $vk
  Start-Sleep -Milliseconds 60
  Send-KeyInput $vk $true
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_CONTROL $true
}

function Press-CtrlShiftKey([uint16]$vk) {
  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_SHIFT
  Start-Sleep -Milliseconds 40
  Send-KeyInput $vk
  Start-Sleep -Milliseconds 70
  Send-KeyInput $vk $true
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_SHIFT $true
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_CONTROL $true
}

function Press-AltKey([uint16]$vk) {
  Send-KeyInput $VK_MENU
  Start-Sleep -Milliseconds 70
  Send-KeyInput $vk
  Start-Sleep -Milliseconds 70
  Send-KeyInput $vk $true
  Start-Sleep -Milliseconds 70
  Send-KeyInput $VK_MENU $true
}

function Press-WinKey([uint16]$vk) {
  Send-KeyInput $VK_LWIN
  Start-Sleep -Milliseconds 80
  Send-KeyInput $vk
  Start-Sleep -Milliseconds 80
  Send-KeyInput $vk $true
  Start-Sleep -Milliseconds 80
  Send-KeyInput $VK_LWIN $true
}

function Press-CtrlC() {
  Press-CtrlKey $VK_C
}

function Press-CtrlV() {
  Press-CtrlKey $VK_V
}

function Press-CtrlX() {
  Press-CtrlKey $VK_X
}

function Press-CtrlY() {
  Press-CtrlKey $VK_Y
}

function Press-CtrlZ() {
  Press-CtrlKey $VK_Z
}

function Press-CtrlShiftY() {
  Press-CtrlShiftKey $VK_Y
}

function Press-ShiftTab() {
  Send-KeyInput $VK_SHIFT
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_TAB
  Start-Sleep -Milliseconds 60
  Send-KeyInput $VK_TAB $true
  Start-Sleep -Milliseconds 40
  Send-KeyInput $VK_SHIFT $true
}

function Move-Stepped([int]$fromX, [int]$fromY, [int]$toX, [int]$toY, [int]$steps = 10, [int]$DelayMs = 60) {
  Send-MouseAbsoluteMove $fromX $fromY
  Start-Sleep -Milliseconds $DelayMs
  for ($i = 0; $i -le $steps; $i++) {
    $x = [int]($fromX + (($toX - $fromX) * $i / $steps))
    $y = [int]($fromY + (($toY - $fromY) * $i / $steps))
    Send-MouseAbsoluteMove $x $y
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Release-LeftMouse([int]$Repeats = 3, [int]$DelayMs = 60) {
  for ($i = 0; $i -lt $Repeats; $i++) {
    Send-MouseRelease $MOUSEEVENTF_LEFTUP
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Release-RightMouse([int]$Repeats = 3, [int]$DelayMs = 60) {
  for ($i = 0; $i -lt $Repeats; $i++) {
    Send-MouseRelease $MOUSEEVENTF_RIGHTUP
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Release-MiddleMouse([int]$Repeats = 3, [int]$DelayMs = 60) {
  for ($i = 0; $i -lt $Repeats; $i++) {
    Send-MouseRelease $MOUSEEVENTF_MIDDLEUP
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Click-Left() {
  Send-MouseInput $MOUSEEVENTF_LEFTDOWN
  Start-Sleep -Milliseconds 80
  Send-MouseInput $MOUSEEVENTF_LEFTUP
}

function Click-LeftRobust([int]$HoldMs = 140) {
  Release-LeftMouse 1 50
  Send-MouseInput $MOUSEEVENTF_LEFTDOWN
  Start-Sleep -Milliseconds $HoldMs
  Release-LeftMouse 3 70
}

function Click-RightRobust([int]$HoldMs = 140) {
  Release-RightMouse 1 50
  Send-MouseInput $MOUSEEVENTF_RIGHTDOWN
  Start-Sleep -Milliseconds $HoldMs
  Release-RightMouse 3 70
}

function Click-MiddleRobust([int]$HoldMs = 140) {
  Release-MiddleMouse 1 50
  Send-MouseInput $MOUSEEVENTF_MIDDLEDOWN
  Start-Sleep -Milliseconds $HoldMs
  Release-MiddleMouse 3 70
}

function Drag-Absolute([int]$fromX, [int]$fromY, [int]$toX, [int]$toY, [int]$steps = 12, [int]$DelayMs = 70) {
  Release-LeftMouse 2 50
  [KortixUser32]::SetCursorPos($fromX, $fromY) | Out-Null
  Send-MouseAbsoluteMove $fromX $fromY
  Start-Sleep -Milliseconds 150
  Send-MouseInput $MOUSEEVENTF_LEFTDOWN
  Start-Sleep -Milliseconds 120

  for ($i = 1; $i -le $steps; $i++) {
    $nextX = [int][Math]::Round($fromX + (($toX - $fromX) * $i / $steps))
    $nextY = [int][Math]::Round($fromY + (($toY - $fromY) * $i / $steps))
    Send-MouseAbsoluteMove $nextX $nextY
    Start-Sleep -Milliseconds $DelayMs
  }

  Release-LeftMouse 3 70
}

function ShiftDrag-Absolute([int]$fromX, [int]$fromY, [int]$toX, [int]$toY, [int]$steps = 12, [int]$DelayMs = 70) {
  Release-LeftMouse 2 50
  [KortixUser32]::SetCursorPos($fromX, $fromY) | Out-Null
  Send-MouseAbsoluteMove $fromX $fromY
  Start-Sleep -Milliseconds 150

  Send-KeyInput $VK_SHIFT
  Start-Sleep -Milliseconds 100
  try {
    Send-MouseInput $MOUSEEVENTF_LEFTDOWN
    Start-Sleep -Milliseconds 120

    for ($i = 1; $i -le $steps; $i++) {
      $nextX = [int][Math]::Round($fromX + (($toX - $fromX) * $i / $steps))
      $nextY = [int][Math]::Round($fromY + (($toY - $fromY) * $i / $steps))
      Send-MouseAbsoluteMove $nextX $nextY
      Start-Sleep -Milliseconds $DelayMs
    }

    Release-LeftMouse 3 70
  } finally {
    Send-KeyInput $VK_SHIFT $true
  }
}

function Scroll-DownDetents([int]$x, [int]$y, [int]$Detents = 3, [int]$DelayMs = 120) {
  Release-LeftMouse 2 50
  [KortixUser32]::SetCursorPos($x, $y) | Out-Null
  Send-MouseAbsoluteMove $x $y
  Start-Sleep -Milliseconds 180
  for ($i = 0; $i -lt $Detents; $i++) {
    Send-MouseInput $MOUSEEVENTF_WHEEL 0 0 $MOUSE_WHEEL_NEGATIVE_DELTA
    Start-Sleep -Milliseconds $DelayMs
  }
}

function Scroll-UpDetents([int]$x, [int]$y, [int]$Detents = 3, [int]$DelayMs = 120) {
  Release-LeftMouse 2 50
  [KortixUser32]::SetCursorPos($x, $y) | Out-Null
  Send-MouseAbsoluteMove $x $y
  Start-Sleep -Milliseconds 180
  for ($i = 0; $i -lt $Detents; $i++) {
    Send-MouseInput $MOUSEEVENTF_WHEEL 0 0 $MOUSE_WHEEL_POSITIVE_DELTA
    Start-Sleep -Milliseconds $DelayMs
  }
}

$phases = New-Object System.Collections.Generic.List[object]
function Add-Phase([string]$name, [hashtable]$details = @{}) {
  $phases.Add([ordered]@{
    name = $name
    utc = [DateTime]::UtcNow.ToString("o")
    details = $details
  }) | Out-Null
}

function Wait-WindowHandle([System.Diagnostics.Process]$Process, [string]$ProcessName, [int]$TimeoutMs = 8000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $Process.Refresh()
      if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
        return $Process.MainWindowHandle
      }
    } catch {}

    $candidate = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.MainWindowHandle
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $ProcessName window handle"
}

function Get-TopLevelWindowTitle([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) {
    return ""
  }
  $length = [Math]::Max(0, [KortixUser32]::GetWindowTextLength($Handle))
  if ($length -eq 0) {
    return ""
  }
  $builder = New-Object System.Text.StringBuilder($length + 1)
  [KortixUser32]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
  return $builder.ToString()
}

function Find-VisibleWindowByTitle([string]$TitleContains) {
  $windowMatches = New-Object System.Collections.Generic.List[object]
  $callback = [KortixUser32+EnumWindowsProc]{
    param([IntPtr]$hwnd, [IntPtr]$lParam)

    if ($hwnd -eq [IntPtr]::Zero -or -not [KortixUser32]::IsWindowVisible($hwnd)) {
      return $true
    }

    $title = Get-TopLevelWindowTitle $hwnd
    if ($title -and $title.IndexOf($TitleContains, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $processId = [uint32]0
      [KortixUser32]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
      $windowMatches.Add([ordered]@{
        hwnd = $hwnd
        process_id = [int]$processId
        title = $title
      }) | Out-Null
    }

    return $true
  }

  [KortixUser32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  if ($windowMatches.Count -eq 0) {
    return $null
  }
  return $windowMatches[0]
}

function Wait-VisibleWindowByTitle([string]$TitleContains, [int]$TimeoutMs = 10000, [int]$IntervalMs = 250) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $match = Find-VisibleWindowByTitle $TitleContains
    if ($match) {
      return $match
    }
    Start-Sleep -Milliseconds $IntervalMs
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Timed out waiting for visible window title containing '$TitleContains'"
}

function Wait-VisibleWindowGoneByTitle([string]$TitleContains, [int]$TimeoutMs = 5000, [int]$IntervalMs = 150) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $match = Find-VisibleWindowByTitle $TitleContains
    if (-not $match) {
      return $true
    }
    Start-Sleep -Milliseconds $IntervalMs
  } while ([DateTime]::UtcNow -lt $deadline)

  return $false
}

function Wait-ExplorerWindowForPath([string]$Path, [int]$TimeoutMs = 12000) {
  $targetPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $shell = New-Object -ComObject Shell.Application
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($window in @($shell.Windows())) {
      try {
        $folderPath = [string]$window.Document.Folder.Self.Path
        if ($folderPath.TrimEnd('\') -ieq $targetPath) {
          return [IntPtr]([int64]$window.HWND)
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for Explorer window at $targetPath"
}

function Get-WindowRectChecked([IntPtr]$Handle) {
  $rect = New-Object KortixUser32+RECT
  if (-not [KortixUser32]::GetWindowRect($Handle, [ref]$rect)) {
    throw "GetWindowRect failed for handle $($Handle.ToInt64())"
  }
  return $rect
}

function Move-WindowChecked([IntPtr]$Handle, [int]$X, [int]$Y, [int]$Width, [int]$Height) {
  if (-not [KortixUser32]::MoveWindow($Handle, $X, $Y, $Width, $Height, $true)) {
    throw "MoveWindow failed for handle $($Handle.ToInt64())"
  }
  Start-Sleep -Milliseconds 350
  return Get-WindowRectChecked $Handle
}

function Get-WindowTextRaw([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) {
    return ""
  }
  $length = [Math]::Max(0, [int][KortixUser32]::SendMessagePtr($Handle, $WM_GETTEXTLENGTH, [UIntPtr]::Zero, [IntPtr]::Zero))
  if ($length -eq 0) {
    $length = [Math]::Max(0, [KortixUser32]::GetWindowTextLength($Handle))
  }
  $builder = New-Object System.Text.StringBuilder($length + 256)
  [KortixUser32]::SendMessageText($Handle, $WM_GETTEXT, $builder.Capacity, $builder) | Out-Null
  if ($builder.Length -eq 0) {
    [KortixUser32]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
  }
  return $builder.ToString()
}

function Get-NotepadEditHandle([IntPtr]$Handle) {
  $edit = [KortixUser32]::FindWindowEx($Handle, [IntPtr]::Zero, "Edit", $null)
  if ($edit -eq [IntPtr]::Zero) {
    throw "Notepad Edit control was not found for handle $($Handle.ToInt64())"
  }
  return $edit
}

function Wait-WindowTextContains([IntPtr]$Handle, [string]$Expected, [string]$Label, [int]$TimeoutMs = 3500, [int]$IntervalMs = 100) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $actual = Get-WindowTextRaw $Handle
    if ($actual.Contains($Expected)) {
      return $actual
    }
    Start-Sleep -Milliseconds $IntervalMs
  } while ([DateTime]::UtcNow -lt $deadline)

  $foreground = [KortixUser32]::GetForegroundWindow()
  $foregroundTitle = Get-WindowTextRaw $foreground
  throw "$Label did not contain expected text '$Expected'; target=$($Handle.ToInt64()) actual='$(Get-WindowTextRaw $Handle)' foreground=$($foreground.ToInt64()) foreground_title='$foregroundTitle'"
}

function Wait-FindDialog([int]$TimeoutMs = 3500, [int]$IntervalMs = 100) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $dialog = [KortixUser32]::FindWindow("#32770", "Find")
    if ($dialog -ne [IntPtr]::Zero -and [KortixUser32]::IsWindowVisible($dialog)) {
      return $dialog
    }
    Start-Sleep -Milliseconds $IntervalMs
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Find dialog did not appear"
}

function Wait-ReplaceDialog([int]$TimeoutMs = 3500, [int]$IntervalMs = 100) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $dialog = [KortixUser32]::FindWindow("#32770", "Replace")
    if ($dialog -ne [IntPtr]::Zero -and [KortixUser32]::IsWindowVisible($dialog)) {
      return $dialog
    }
    Start-Sleep -Milliseconds $IntervalMs
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Replace dialog did not appear"
}

function Set-ForegroundWindowRobust([IntPtr]$Handle, [int]$ShowCommand = 9, [int]$Attempts = 6, [int]$DelayMs = 150) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    [KortixUser32]::ShowWindow($Handle, $ShowCommand) | Out-Null
    [KortixUser32]::SetForegroundWindow($Handle) | Out-Null
    Start-Sleep -Milliseconds $DelayMs
    if ([KortixUser32]::GetForegroundWindow().ToInt64() -eq $Handle.ToInt64()) {
      return $true
    }
  }
  return $false
}

function Set-NotepadEditorFocusRobust([IntPtr]$Handle, [int]$Attempts = 6, [int]$DelayMs = 150) {
  $focusedChild = [IntPtr]::Zero
  for ($i = 0; $i -lt $Attempts; $i++) {
    Set-ForegroundWindowRobust $Handle 9 2 $DelayMs | Out-Null
    $edit = [KortixUser32]::FindWindowEx($Handle, [IntPtr]::Zero, "Edit", $null)
    if ($edit -eq [IntPtr]::Zero) {
      $edit = $Handle
    }

    $targetProcessId = [uint32]0
    $targetThreadId = [KortixUser32]::GetWindowThreadProcessId($edit, [ref]$targetProcessId)
    $currentThreadId = [KortixUser32]::GetCurrentThreadId()
    $attached = $false
    if ($targetThreadId -ne 0 -and $targetThreadId -ne $currentThreadId) {
      $attached = [KortixUser32]::AttachThreadInput($currentThreadId, $targetThreadId, $true)
    }

    try {
      [KortixUser32]::SetFocus($edit) | Out-Null
      $focusedChild = $edit
    } finally {
      if ($attached) {
        [KortixUser32]::AttachThreadInput($currentThreadId, $targetThreadId, $false) | Out-Null
      }
    }

    Start-Sleep -Milliseconds $DelayMs
    if ([KortixUser32]::GetForegroundWindow().ToInt64() -eq $Handle.ToInt64()) {
      return $focusedChild
    }
  }
  return $focusedChild
}

function Run-NotepadScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $startX = $left + 160
  $startY = $top + 150
  $dragStartX = $left + 210
  $dragStartY = $top + 210
  $dragEndX = $left + 520
  $dragEndY = $top + 300

  Add-Phase "notepad_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 40) ($top + 40) $startX $startY 12 45
  Add-Phase "mouse_move" @{ x = $startX; y = $startY }

  Click-Left
  Add-Phase "click" @{ x = $startX; y = $startY; button = "left" }
  Start-Sleep -Milliseconds 250

  Click-Left
  Start-Sleep -Milliseconds 110
  Click-Left
  Add-Phase "double_click" @{ x = $startX; y = $startY; button = "left" }
  Start-Sleep -Milliseconds 850

  [KortixUser32]::SetCursorPos($dragStartX, $dragStartY) | Out-Null
  Start-Sleep -Milliseconds 100
  Send-MouseInput $MOUSEEVENTF_LEFTDOWN
  Move-Stepped $dragStartX $dragStartY $dragEndX $dragEndY 14 70
  Send-MouseInput $MOUSEEVENTF_LEFTUP
  Add-Phase "drag" @{ start_x = $dragStartX; start_y = $dragStartY; end_x = $dragEndX; end_y = $dragEndY; steps = 14 }
  Start-Sleep -Milliseconds 300

  Send-MouseInput $MOUSEEVENTF_WHEEL 0 0 $MOUSE_WHEEL_NEGATIVE_DELTA
  Start-Sleep -Milliseconds 90
  Send-MouseInput $MOUSEEVENTF_WHEEL 0 0 $MOUSE_WHEEL_NEGATIVE_DELTA
  Add-Phase "scroll" @{ clicks = -2 }
  Start-Sleep -Milliseconds 250

  Send-AsciiText "kortix real trace validation" 35
  Add-Phase "type_text" @{ text = "kortix real trace validation" }
  Start-Sleep -Milliseconds 200

  Press-Key $VK_RETURN
  Add-Phase "enter" @{ key = "enter" }
  Start-Sleep -Milliseconds 200

  Send-AsciiText "delete this line" 35
  Start-Sleep -Milliseconds 150
  Press-CtrlA
  Start-Sleep -Milliseconds 140
  Press-Key $VK_BACK
  Add-Phase "hotkey_delete" @{ hotkey = "ctrl+a"; delete_key = "backspace" }

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "drag", "scroll", "hotkey_or_press")
  }
}

function DoubleClick-Left([int]$x, [int]$y) {
  Release-LeftMouse 2 50
  [KortixUser32]::SetCursorPos($x, $y) | Out-Null
  Send-MouseAbsoluteMove $x $y
  Start-Sleep -Milliseconds 120
  Click-Left
  Start-Sleep -Milliseconds 110
  Click-Left
}

function TripleClick-Left([int]$x, [int]$y) {
  Release-LeftMouse 2 50
  [KortixUser32]::SetCursorPos($x, $y) | Out-Null
  Send-MouseAbsoluteMove $x $y
  Start-Sleep -Milliseconds 120
  Click-Left
  Start-Sleep -Milliseconds 110
  Click-Left
  Start-Sleep -Milliseconds 110
  Click-Left
}

function Run-NotepadAdvancedScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $startX = $left + 170
  $startY = $top + 155
  $doubleX = $left + 230
  $doubleY = $top + 155
  $shiftClickX = $left + 310
  $shiftClickY = $top + 178
  $rightClickX = $left + 390
  $rightClickY = $top + 205

  Add-Phase "notepad_advanced_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $startX $startY 10 45
  Click-Left
  Add-Phase "initial_click" @{ x = $startX; y = $startY; button = "left" }
  Start-Sleep -Milliseconds 250

  Send-AsciiText "advanced trace" 45
  Add-Phase "type_first_line" @{ text = "advanced trace" }
  Start-Sleep -Milliseconds 180

  Press-Key $VK_RETURN
  Add-Phase "enter_after_first_line" @{ key = "enter" }
  Start-Sleep -Milliseconds 180

  Send-AsciiText "second line" 45
  Add-Phase "type_second_line" @{ text = "second line" }
  Start-Sleep -Milliseconds 220

  Press-CtrlA
  Start-Sleep -Milliseconds 150
  Press-Key $VK_BACK
  Add-Phase "select_all_delete" @{ hotkey = "ctrl+a"; delete_key = "backspace" }
  Start-Sleep -Milliseconds 220

  Send-AsciiText "repeat keys" 45
  Add-Phase "type_repeat_keys" @{ text = "repeat keys" }
  Start-Sleep -Milliseconds 180

  for ($i = 0; $i -lt 3; $i++) {
    Press-Key $VK_LEFT 35
    Start-Sleep -Milliseconds 70
  }
  Add-Phase "repeat_left" @{ key = "left"; count = 3 }
  Start-Sleep -Milliseconds 380

  Press-Key $VK_F5
  Add-Phase "function_key" @{ key = "f5" }
  Start-Sleep -Milliseconds 700

  DoubleClick-Left $doubleX $doubleY
  Add-Phase "double_click" @{ x = $doubleX; y = $doubleY; button = "left" }
  Start-Sleep -Milliseconds 800

  Send-KeyInput $VK_SHIFT
  Start-Sleep -Milliseconds 80
  Move-Stepped $doubleX $doubleY $shiftClickX $shiftClickY 8 35
  Click-LeftRobust 150
  Add-Phase "shift_click" @{ x = $shiftClickX; y = $shiftClickY; button = "left"; modifiers = @("shift") }
  Start-Sleep -Milliseconds 120
  Send-KeyInput $VK_SHIFT $true
  Start-Sleep -Milliseconds 750

  Move-Stepped $shiftClickX $shiftClickY $rightClickX $rightClickY 8 35
  Click-RightRobust 160
  Add-Phase "right_click" @{ x = $rightClickX; y = $rightClickY; button = "right" }
  Start-Sleep -Milliseconds 700

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $startX; y = Normalize-Y $startY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "advanced trace" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "second line" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "a") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "backspace" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "repeat keys" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "left"; count = 3 } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "f5" } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $doubleX; y = Normalize-Y $doubleY; clicks = 2; button = "left"; modifiers = @() } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $shiftClickX; y = Normalize-Y $shiftClickY; clicks = 1; button = "left"; modifiers = @("shift") } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $rightClickX; y = Normalize-Y $rightClickY; clicks = 1; button = "right"; modifiers = @() } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadSelectionShortcutsScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 180
  $editorY = $top + 155
  $text = "alpha beta gamma delta"

  Add-Phase "notepad_selection_shortcuts_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  Click-Left
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 300

  Send-AsciiText $text 45
  Add-Phase "type_words" @{ text = $text }
  Start-Sleep -Milliseconds 650

  Press-CtrlShiftKey $VK_LEFT
  Add-Phase "select_previous_word" @{ hotkey = "ctrl+shift+left" }
  Start-Sleep -Milliseconds 850

  Press-CtrlShiftKey $VK_LEFT
  Add-Phase "extend_selection_previous_word" @{ hotkey = "ctrl+shift+left" }
  Start-Sleep -Milliseconds 850

  Press-CtrlShiftKey $VK_RIGHT
  Add-Phase "shrink_selection_next_word" @{ hotkey = "ctrl+shift+right" }
  Start-Sleep -Milliseconds 950

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $text } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "shift", "left") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "shift", "left") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "shift", "right") } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadMouseSelectionScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 180
  $editorY = $top + 155
  $dragStartX = $left + 170
  $dragStartY = $editorY
  $dragEndX = $left + 28
  $dragEndY = $editorY
  $text = "mouse selection target"

  Add-Phase "notepad_mouse_selection_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  Click-Left
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 300

  Send-AsciiText $text 45
  Add-Phase "type_words" @{ text = $text }
  Start-Sleep -Milliseconds 750

  Drag-Absolute $dragStartX $dragStartY $dragEndX $dragEndY 16 65
  Add-Phase "mouse_select_text" @{ start_x = $dragStartX; start_y = $dragStartY; end_x = $dragEndX; end_y = $dragEndY; steps = 16 }
  Start-Sleep -Milliseconds 950

  Press-Key $VK_BACK
  Add-Phase "delete_selection" @{ key = "backspace" }
  Start-Sleep -Milliseconds 950

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $text } },
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $dragStartX; start_y = Normalize-Y $dragStartY; end_x = Normalize-X $dragEndX; end_y = Normalize-Y $dragEndY; button = "left"; modifiers = @() } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "backspace" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "drag", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadShiftDragSelectionScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $dragStartX = $left + 310
  $dragStartY = $top + 155
  $dragEndX = $left + 72
  $dragEndY = $dragStartY
  $text = "shift drag selection"

  $editorHandle = Set-NotepadEditorFocusRobust $handle
  Add-Phase "notepad_shift_drag_selection_focused" @{ hwnd = $handle.ToInt64(); editor_hwnd = $editorHandle.ToInt64() }
  Start-Sleep -Milliseconds 650

  Send-AsciiText $text 45
  Add-Phase "type_words" @{ text = $text }
  Start-Sleep -Milliseconds 900

  ShiftDrag-Absolute $dragStartX $dragStartY $dragEndX $dragEndY 16 65
  Add-Phase "shift_drag_select_text" @{ start_x = $dragStartX; start_y = $dragStartY; end_x = $dragEndX; end_y = $dragEndY; steps = 16; modifiers = @("shift") }
  Start-Sleep -Milliseconds 1200

  Press-Key $VK_BACK
  Add-Phase "delete_selection" @{ key = "backspace" }
  Start-Sleep -Milliseconds 950

  $expectedActions = @(
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $text } },
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $dragStartX; start_y = Normalize-Y $dragStartY; end_x = Normalize-X $dragEndX; end_y = Normalize-Y $dragEndY; button = "left"; modifiers = @("shift") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "backspace" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("typewrite", "drag", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadTripleClickTextScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 180
  $editorY = $top + 155
  $tripleClickX = $left + 165
  $tripleClickY = $editorY
  $text = "triple click selection"

  Add-Phase "notepad_triple_click_text_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  Click-Left
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-AsciiText $text 45
  Add-Phase "type_words" @{ text = $text }
  Start-Sleep -Milliseconds 1500

  TripleClick-Left $tripleClickX $tripleClickY
  Add-Phase "triple_click_text" @{ x = $tripleClickX; y = $tripleClickY; button = "left"; clicks = 3 }
  Start-Sleep -Milliseconds 1500

  Press-Key $VK_SHIFT
  Add-Phase "flush_triple_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending triple-click before deletion" }
  Start-Sleep -Milliseconds 1200

  Press-Key $VK_BACK
  Add-Phase "delete_after_triple_click" @{ key = "backspace" }
  Start-Sleep -Milliseconds 950

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $text } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $tripleClickX; y = Normalize-Y $tripleClickY; clicks = 3; button = "left"; modifiers = @() } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "backspace" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadMenuShortcutsScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 185
  $editorY = $top + 155
  $text = "menu coverage"

  Add-Phase "notepad_menu_shortcuts_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  Click-Left
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 300

  Send-AsciiText $text 45
  Add-Phase "type_words" @{ text = $text }
  Start-Sleep -Milliseconds 650

  Press-AltKey $VK_F
  Add-Phase "open_file_menu" @{ hotkey = "alt+f" }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_ESCAPE
  Add-Phase "close_file_menu" @{ key = "esc" }
  Start-Sleep -Milliseconds 650

  Press-AltKey $VK_E
  Add-Phase "open_edit_menu" @{ hotkey = "alt+e" }
  Start-Sleep -Milliseconds 850

  for ($i = 0; $i -lt 2; $i++) {
    Press-Key $VK_DOWN 35
    Start-Sleep -Milliseconds 90
  }
  Add-Phase "menu_down" @{ key = "down"; count = 2 }
  Start-Sleep -Milliseconds 750

  Press-Key $VK_ESCAPE
  Add-Phase "close_edit_menu" @{ key = "esc" }
  Start-Sleep -Milliseconds 800

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $text } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "f") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "esc" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "e") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "down"; count = 2 } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "esc" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadContextMenuScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 185
  $editorY = $top + 155

  Add-Phase "notepad_context_menu_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  Click-Left
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Click-RightRobust 160
  Add-Phase "open_context_menu" @{ x = $editorX; y = $editorY; button = "right" }
  Start-Sleep -Milliseconds 900

  for ($i = 0; $i -lt 2; $i++) {
    Press-Key $VK_DOWN 35
    Start-Sleep -Milliseconds 90
  }
  Add-Phase "context_menu_down" @{ key = "down"; count = 2 }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_ESCAPE
  Add-Phase "close_context_menu" @{ key = "esc" }
  Start-Sleep -Milliseconds 900

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "right"; modifiers = @() } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "down"; count = 2 } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "esc" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadWindowControlsScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 185
  $editorY = $top + 155

  Add-Phase "notepad_window_controls_focused" @{ hwnd = $handle.ToInt64() }

  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  Click-Left
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Press-AltKey $VK_SPACE
  Add-Phase "open_system_menu_for_maximize" @{ hotkey = "alt+space" }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_X
  Add-Phase "maximize_window" @{ key = "x" }
  Start-Sleep -Milliseconds 950

  Press-AltKey $VK_SPACE
  Add-Phase "open_system_menu_for_restore" @{ hotkey = "alt+space" }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_R
  Add-Phase "restore_window" @{ key = "r" }
  Start-Sleep -Milliseconds 950

  Press-AltKey $VK_SPACE
  Add-Phase "open_system_menu_for_minimize" @{ hotkey = "alt+space" }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_N
  Add-Phase "minimize_window" @{ key = "n" }
  Start-Sleep -Milliseconds 950

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "space") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "x" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "space") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "r" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "space") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "n" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadWindowMouseScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $titleY = $top + 16
  $dragStartX = $left + 260
  $dragStartY = $titleY
  $dragEndX = $dragStartX + 300
  $dragEndY = $dragStartY + 160

  Add-Phase "notepad_window_mouse_focused" @{ hwnd = $handle.ToInt64() }

  Drag-Absolute $dragStartX $dragStartY $dragEndX $dragEndY 18 65
  Add-Phase "drag_titlebar" @{ start_x = $dragStartX; start_y = $dragStartY; end_x = $dragEndX; end_y = $dragEndY; steps = 18 }
  Start-Sleep -Milliseconds 950

  $draggedRect = Get-WindowRectChecked $handle
  $maximizeX = $draggedRect.Left + 260
  $maximizeY = $draggedRect.Top + 16
  DoubleClick-Left $maximizeX $maximizeY
  Add-Phase "double_click_titlebar_maximize" @{ x = $maximizeX; y = $maximizeY; button = "left"; clicks = 2 }
  Start-Sleep -Milliseconds 1100

  $maxRect = Get-WindowRectChecked $handle
  $restoreX = $maxRect.Left + 260
  $restoreY = $maxRect.Top + 16
  DoubleClick-Left $restoreX $restoreY
  Add-Phase "double_click_titlebar_restore" @{ x = $restoreX; y = $restoreY; button = "left"; clicks = 2 }
  Start-Sleep -Milliseconds 1100

  $restoredRect = Get-WindowRectChecked $handle
  $minimizeX = $restoredRect.Right - 124
  $minimizeY = $restoredRect.Top + 16
  Move-Stepped $restoreX $restoreY $minimizeX $minimizeY 10 45
  Click-LeftRobust 150
  Add-Phase "click_minimize_button" @{ x = $minimizeX; y = $minimizeY; button = "left" }
  Start-Sleep -Milliseconds 1100

  $expectedActions = @(
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $dragStartX; start_y = Normalize-Y $dragStartY; end_x = Normalize-X $dragEndX; end_y = Normalize-Y $dragEndY; button = "left"; modifiers = @() } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $maximizeX; y = Normalize-Y $maximizeY; clicks = 2; button = "left"; modifiers = @() } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $restoreX; y = Normalize-Y $restoreY; clicks = 2; button = "left"; modifiers = @() } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $minimizeX; y = Normalize-Y $minimizeY; clicks = 1; button = "left"; modifiers = @() } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "drag")
    expected_actions = $expectedActions
  }
}

function Run-NotepadWindowResizeScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 500

  $screenWidth = [KortixUser32]::GetSystemMetrics(0)
  $screenHeight = [KortixUser32]::GetSystemMetrics(1)
  $rect = Get-WindowRectChecked $handle

  $shrinkStartX = $rect.Right - 6
  $shrinkStartY = $rect.Bottom - 6
  $shrinkEndX = [Math]::Max($rect.Left + 360, $shrinkStartX - 260)
  $shrinkEndY = [Math]::Max($rect.Top + 260, $shrinkStartY - 170)

  Add-Phase "notepad_window_resize_focused" @{
    hwnd = $handle.ToInt64()
    rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
  }

  Drag-Absolute $shrinkStartX $shrinkStartY $shrinkEndX $shrinkEndY 18 65
  Add-Phase "resize_bottom_right_shrink" @{
    start_x = $shrinkStartX
    start_y = $shrinkStartY
    end_x = $shrinkEndX
    end_y = $shrinkEndY
    steps = 18
  }
  Start-Sleep -Milliseconds 1100

  $shrunkRect = Get-WindowRectChecked $handle
  $expandStartX = $shrunkRect.Right - 6
  $expandStartY = $shrunkRect.Bottom - 6
  $expandEndX = [Math]::Min($screenWidth - 12, $expandStartX + 300)
  $expandEndY = [Math]::Min($screenHeight - 12, $expandStartY + 190)

  Drag-Absolute $expandStartX $expandStartY $expandEndX $expandEndY 20 65
  Add-Phase "resize_bottom_right_expand" @{
    start_x = $expandStartX
    start_y = $expandStartY
    end_x = $expandEndX
    end_y = $expandEndY
    steps = 20
    rect_after_shrink = @{ left = $shrunkRect.Left; top = $shrunkRect.Top; right = $shrunkRect.Right; bottom = $shrunkRect.Bottom }
  }
  Start-Sleep -Milliseconds 1100

  $expectedActions = @(
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $shrinkStartX; start_y = Normalize-Y $shrinkStartY; end_x = Normalize-X $shrinkEndX; end_y = Normalize-Y $shrinkEndY; button = "left"; modifiers = @() } },
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $expandStartX; start_y = Normalize-Y $expandStartY; end_x = Normalize-X $expandEndX; end_y = Normalize-Y $expandEndY; button = "left"; modifiers = @() } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("drag")
    expected_actions = $expectedActions
  }
}

function Run-NotepadSaveDialogScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 600

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $startX = $left + 165
  $startY = $top + 155
  $bodyText = "save dialog trace"
  $fileName = "kortix save dialog trace " + [DateTime]::UtcNow.ToString("HHmmss")

  Add-Phase "notepad_save_dialog_focused" @{ hwnd = $handle.ToInt64(); file_name = $fileName }

  Move-Stepped ($left + 55) ($top + 75) $startX $startY 10 45
  Click-Left
  Add-Phase "initial_click" @{ x = $startX; y = $startY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-AsciiText $bodyText 45
  Add-Phase "type_body" @{ text = $bodyText }
  Start-Sleep -Milliseconds 250

  Press-CtrlKey $VK_S
  Add-Phase "open_save_dialog" @{ hotkey = "ctrl+s" }
  Start-Sleep -Milliseconds 1400

  Send-KeyboardText $fileName 45
  Add-Phase "type_file_name" @{ text = $fileName }
  Start-Sleep -Milliseconds 250

  Press-Key $VK_RETURN
  Add-Phase "confirm_save" @{ key = "enter"; file_name = $fileName }
  Start-Sleep -Milliseconds 1200

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $startX; y = Normalize-Y $startY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $bodyText } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "s") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $fileName } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadFindDialogScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 600

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 170
  $editorY = $top + 155
  $bodyText = "alpha needle beta needle gamma"
  $queryText = "needle"

  $editorHandle = Set-NotepadEditorFocusRobust $handle
  Add-Phase "notepad_find_dialog_focused" @{ hwnd = $handle.ToInt64(); editor_hwnd = $editorHandle.ToInt64() }
  Start-Sleep -Milliseconds 650

  $editHandle = Get-NotepadEditHandle $handle
  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  [KortixUser32]::SetCursorPos($editorX, $editorY) | Out-Null
  Send-MouseAbsoluteMove $editorX $editorY
  Start-Sleep -Milliseconds 150
  Click-LeftRobust 180
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Set-ForegroundWindowRobust $handle | Out-Null
  Set-NotepadEditorFocusRobust $handle | Out-Null
  Start-Sleep -Milliseconds 350

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-AsciiText $bodyText 45
  Add-Phase "type_body" @{ text = $bodyText }
  $verifiedBody = Wait-WindowTextContains $editHandle $bodyText "Notepad editor"
  Add-Phase "body_text_verified" @{ text = $verifiedBody }
  Start-Sleep -Milliseconds 1200

  Press-Key $VK_HOME
  Add-Phase "move_to_line_start" @{ key = "home" }
  Start-Sleep -Milliseconds 650

  Press-CtrlKey $VK_F
  Add-Phase "open_find_dialog" @{ hotkey = "ctrl+f" }
  $findHandle = Wait-FindDialog
  Add-Phase "find_dialog_verified" @{ hwnd = $findHandle.ToInt64() }
  Start-Sleep -Milliseconds 1100

  Send-AsciiText $queryText 45
  Add-Phase "type_find_query" @{ text = $queryText }
  $findEdit = [KortixUser32]::FindWindowEx($findHandle, [IntPtr]::Zero, "Edit", $null)
  if ($findEdit -eq [IntPtr]::Zero) {
    throw "Find dialog Edit control was not found"
  }
  $verifiedQuery = Wait-WindowTextContains $findEdit $queryText "Find query box"
  Add-Phase "find_query_verified" @{ text = $verifiedQuery }
  Start-Sleep -Milliseconds 900

  Press-Key $VK_RETURN
  Add-Phase "find_next" @{ key = "enter"; query = $queryText }
  Start-Sleep -Milliseconds 1100

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $bodyText } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "home" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "f") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $queryText } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadReplaceDialogScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 600

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 170
  $editorY = $top + 155
  $bodyText = "alpha needle beta needle gamma"
  $findText = "needle"
  $replacementText = "marker"
  $finalText = "alpha marker beta marker gamma"

  $editorHandle = Set-NotepadEditorFocusRobust $handle
  Add-Phase "notepad_replace_dialog_focused" @{ hwnd = $handle.ToInt64(); editor_hwnd = $editorHandle.ToInt64() }
  Start-Sleep -Milliseconds 650

  $editHandle = Get-NotepadEditHandle $handle
  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  [KortixUser32]::SetCursorPos($editorX, $editorY) | Out-Null
  Send-MouseAbsoluteMove $editorX $editorY
  Start-Sleep -Milliseconds 150
  Click-LeftRobust 180
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Set-ForegroundWindowRobust $handle | Out-Null
  Set-NotepadEditorFocusRobust $handle | Out-Null
  Start-Sleep -Milliseconds 350

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-AsciiText $bodyText 45
  Add-Phase "type_body" @{ text = $bodyText }
  $verifiedBody = Wait-WindowTextContains $editHandle $bodyText "Notepad editor original body"
  Add-Phase "original_body_text_verified" @{ expected_text = $bodyText; actual_text = $verifiedBody }
  Start-Sleep -Milliseconds 1200

  Press-CtrlKey $VK_H
  Add-Phase "open_replace_dialog" @{ hotkey = "ctrl+h" }
  $replaceHandle = Wait-ReplaceDialog
  Add-Phase "replace_dialog_verified" @{ hwnd = $replaceHandle.ToInt64(); title = (Get-WindowTextRaw $replaceHandle) }
  Start-Sleep -Milliseconds 1100

  Send-AsciiText $findText 45
  Add-Phase "type_find_query" @{ text = $findText }
  $findEdit = [KortixUser32]::FindWindowEx($replaceHandle, [IntPtr]::Zero, "Edit", $null)
  if ($findEdit -eq [IntPtr]::Zero) {
    throw "Replace dialog find Edit control was not found"
  }
  $verifiedQuery = Wait-WindowTextContains $findEdit $findText "Replace dialog find box"
  Add-Phase "replace_find_query_verified" @{ expected_text = $findText; actual_text = $verifiedQuery }
  Start-Sleep -Milliseconds 450

  Press-Key $VK_TAB
  Add-Phase "focus_replace_field" @{ key = "tab"; note = "moves from find text to replacement text field in the native Replace dialog" }
  Start-Sleep -Milliseconds 450

  Send-AsciiText $replacementText 45
  Add-Phase "type_replacement_text" @{ text = $replacementText }
  $replacementEdit = [KortixUser32]::FindWindowEx($replaceHandle, $findEdit, "Edit", $null)
  if ($replacementEdit -eq [IntPtr]::Zero) {
    throw "Replace dialog replacement Edit control was not found"
  }
  $verifiedReplacement = Wait-WindowTextContains $replacementEdit $replacementText "Replace dialog replacement box"
  Add-Phase "replacement_text_verified" @{ expected_text = $replacementText; actual_text = $verifiedReplacement }
  Start-Sleep -Milliseconds 900

  Press-AltKey $VK_A
  Add-Phase "replace_all" @{ hotkey = "alt+a"; find_text = $findText; replacement_text = $replacementText }
  $verifiedFinal = Wait-WindowTextContains $editHandle $finalText "Notepad editor final replaced body" 4500 100
  Add-Phase "final_replacement_verified" @{ expected_text = $finalText; actual_text = $verifiedFinal }
  Start-Sleep -Milliseconds 1100

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $bodyText } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "h") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $findText } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $replacementText } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "a") } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-NotepadPrintDialogScenario() {
  $process = Start-Process notepad.exe -PassThru
  Start-Sleep -Milliseconds 1400
  $handle = Wait-WindowHandle $process "notepad"
  Set-ForegroundWindowRobust $handle | Out-Null
  Start-Sleep -Milliseconds 600

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 170
  $editorY = $top + 155
  $bodyText = "print dialog trace"

  $editorHandle = Set-NotepadEditorFocusRobust $handle
  Add-Phase "notepad_print_dialog_focused" @{ hwnd = $handle.ToInt64(); editor_hwnd = $editorHandle.ToInt64() }
  Start-Sleep -Milliseconds 650

  $editHandle = Get-NotepadEditHandle $handle
  Move-Stepped ($left + 50) ($top + 70) $editorX $editorY 10 45
  [KortixUser32]::SetCursorPos($editorX, $editorY) | Out-Null
  Send-MouseAbsoluteMove $editorX $editorY
  Start-Sleep -Milliseconds 150
  Click-LeftRobust 180
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Set-ForegroundWindowRobust $handle | Out-Null
  Set-NotepadEditorFocusRobust $handle | Out-Null
  Start-Sleep -Milliseconds 350

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-AsciiText $bodyText 45
  Add-Phase "type_body" @{ text = $bodyText }
  $verifiedBody = Wait-WindowTextContains $editHandle $bodyText "Notepad editor"
  Add-Phase "body_text_verified" @{ expected_text = $bodyText; actual_text = $verifiedBody }
  Start-Sleep -Milliseconds 1200

  Press-CtrlKey $VK_P
  Add-Phase "open_print_dialog" @{ hotkey = "ctrl+p" }
  $printWindow = Wait-VisibleWindowByTitle "Print" 10000 200
  Add-Phase "print_dialog_visible" @{ hwnd = $printWindow.hwnd.ToInt64(); title = $printWindow.title; process_id = $printWindow.process_id }
  Start-Sleep -Milliseconds 2800

  Press-Key $VK_TAB
  Add-Phase "print_dialog_tab_navigation" @{ key = "tab"; note = "safe deterministic focus movement inside the native Print dialog" }
  Start-Sleep -Milliseconds 900

  Press-Key $VK_ESCAPE
  Add-Phase "print_dialog_cancel" @{ key = "esc" }
  $printGone = Wait-VisibleWindowGoneByTitle "Print" 5000 150
  $foreground = [KortixUser32]::GetForegroundWindow()
  Add-Phase "print_dialog_cancel_verified" @{
    print_window_gone = $printGone
    foreground_hwnd = $foreground.ToInt64()
    foreground_title = (Get-WindowTextRaw $foreground)
  }
  if (-not $printGone) {
    throw "Print dialog did not close after Esc; foreground=$($foreground.ToInt64()) title='$(Get-WindowTextRaw $foreground)'"
  }
  Start-Sleep -Milliseconds 900

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $bodyText } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "p") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "esc" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-ExplorerFileRenameScenario() {
  $dir = Join-Path $env:TEMP ("kortix-explorer-rename-" + [DateTime]::UtcNow.ToString("HHmmss"))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $oldName = "alpha trace item"
  $newName = "renamed trace item " + [DateTime]::UtcNow.ToString("HHmmss")
  $oldPath = Join-Path $dir $oldName
  Set-Content -Encoding UTF8 -Path $oldPath -Value "kortix explorer rename trace"

  $argument = "/select,`"$oldPath`""
  $process = Start-Process explorer.exe -ArgumentList $argument -PassThru
  Start-Sleep -Milliseconds 1800
  $handle = Wait-ExplorerWindowForPath $dir 12000
  Set-ForegroundWindowRobust $handle 9 8 180 | Out-Null
  Start-Sleep -Milliseconds 900

  Add-Phase "explorer_file_rename_focused" @{
    hwnd = $handle.ToInt64()
    directory = $dir
    old_name = $oldName
    new_name = $newName
  }

  Press-Key $VK_SHIFT
  Add-Phase "flush_selection_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python startup focus before meaningful keys" }
  Start-Sleep -Milliseconds 450

  Press-Key $VK_F2
  Add-Phase "rename_start" @{ key = "f2"; old_name = $oldName }
  Start-Sleep -Milliseconds 900

  Send-KeyboardText $newName 45
  Add-Phase "type_new_file_name" @{ text = $newName }
  Start-Sleep -Milliseconds 350

  Press-Key $VK_RETURN
  Add-Phase "rename_confirm" @{ key = "enter"; new_name = $newName }
  Start-Sleep -Milliseconds 1200

  $expectedActions = @(
    [ordered]@{ type = "press"; args = [ordered]@{ key = "f2" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $newName } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-ExplorerNewFolderScenario() {
  $dir = Join-Path $env:TEMP ("kortix-explorer-new-folder-" + [DateTime]::UtcNow.ToString("HHmmss"))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $folderName = "trace folder " + [DateTime]::UtcNow.ToString("HHmmss")

  $process = Start-Process explorer.exe -ArgumentList "`"$dir`"" -PassThru
  Start-Sleep -Milliseconds 1800
  $handle = Wait-ExplorerWindowForPath $dir 12000
  Set-ForegroundWindowRobust $handle 9 8 180 | Out-Null
  Start-Sleep -Milliseconds 900

  Add-Phase "explorer_new_folder_focused" @{
    hwnd = $handle.ToInt64()
    directory = $dir
    folder_name = $folderName
  }

  Press-Key $VK_SHIFT
  Add-Phase "flush_startup_focus_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python startup focus before meaningful keys" }
  Start-Sleep -Milliseconds 450

  Press-CtrlShiftKey $VK_N
  Add-Phase "new_folder_start" @{ hotkey = "ctrl+shift+n"; folder_name = $folderName }
  Start-Sleep -Milliseconds 900

  Send-KeyboardText $folderName 45
  Add-Phase "type_new_folder_name" @{ text = $folderName }
  Start-Sleep -Milliseconds 350

  Press-Key $VK_RETURN
  Add-Phase "new_folder_confirm" @{ key = "enter"; folder_name = $folderName }
  Start-Sleep -Milliseconds 1200

  $folderPath = Join-Path $dir $folderName
  $deadline = [DateTime]::UtcNow.AddMilliseconds(5000)
  while ((-not (Test-Path -LiteralPath $folderPath -PathType Container)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $folderPath -PathType Container)) {
    throw "Timed out waiting for Explorer new folder at $folderPath"
  }
  Add-Phase "new_folder_final_state" @{ path = $folderPath }

  $expectedActions = @(
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "N") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $folderName } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-ExplorerDragDropScenario() {
  $parentDir = Join-Path $env:TEMP ("kortix-explorer-drag-drop-" + [DateTime]::UtcNow.ToString("HHmmss"))
  $targetDir = Join-Path $parentDir "target"
  New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $fileName = "drag-source.txt"
  $sourcePath = Join-Path $parentDir $fileName
  $targetPath = Join-Path $targetDir $fileName
  Set-Content -Encoding UTF8 -Path $sourcePath -Value "kortix explorer drag drop trace"

  $sourceArgument = "/select,`"$sourcePath`""
  $sourceProcess = Start-Process explorer.exe -ArgumentList $sourceArgument -PassThru
  Start-Sleep -Milliseconds 2200

  $sourceHandle = Wait-ExplorerWindowForPath $parentDir 12000

  $screenWidth = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(0))
  $screenHeight = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(1))
  $gap = 24
  $windowWidth = [Math]::Min(760, $screenWidth - ($gap * 2))
  $windowWidth = [Math]::Max(520, $windowWidth)
  $windowHeight = [Math]::Min(620, $screenHeight - 90)
  $windowHeight = [Math]::Max(360, $windowHeight)
  $windowTop = 40

  $sourceRect = Move-WindowChecked $sourceHandle $gap $windowTop $windowWidth $windowHeight

  $sourceWindowProcessId = [uint32]0
  [KortixUser32]::GetWindowThreadProcessId($sourceHandle, [ref]$sourceWindowProcessId) | Out-Null
  Set-ForegroundWindowRobust $sourceHandle 9 8 180 | Out-Null
  Start-Sleep -Milliseconds 900

  $fileX = $sourceRect.Left + 190
  $fileY = $sourceRect.Top + 154
  $dropX = $sourceRect.Left + 190
  $dropY = $sourceRect.Top + 130

  Add-Phase "explorer_drag_drop_focused" @{
    source_hwnd = $sourceHandle.ToInt64()
    parent_directory = $parentDir
    target_directory = $targetDir
    file_name = $fileName
    source_process_id = [int]$sourceWindowProcessId
    source_launcher_process_id = $sourceProcess.Id
  }

  Move-Stepped ($sourceRect.Left + 60) ($sourceRect.Top + 90) $fileX $fileY 8 45
  [KortixUser32]::SetCursorPos($fileX, $fileY) | Out-Null
  Send-MouseAbsoluteMove $fileX $fileY
  Start-Sleep -Milliseconds 180
  Click-LeftRobust 180
  Add-Phase "select_source_file" @{ x = $fileX; y = $fileY; file_name = $fileName; button = "left" }
  Start-Sleep -Milliseconds 700

  Drag-Absolute $fileX $fileY $dropX $dropY 18 70
  Add-Phase "drag_file_to_target" @{
    start_x = $fileX
    start_y = $fileY
    end_x = $dropX
    end_y = $dropY
    steps = 18
    target_folder = "target"
    source_path = $sourcePath
    target_path = $targetPath
  }

  $deadline = [DateTime]::UtcNow.AddMilliseconds(6000)
  while ((Test-Path -LiteralPath $sourcePath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "Explorer drag/drop did not create target file at $targetPath"
  }
  if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
    throw "Explorer drag/drop left original file at $sourcePath"
  }
  Add-Phase "drag_drop_final_state" @{ source_exists = $false; target_exists = $true; target_path = $targetPath }
  Start-Sleep -Milliseconds 1200

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $fileX; y = Normalize-Y $fileY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $fileX; start_y = Normalize-Y $fileY; end_x = Normalize-X $dropX; end_y = Normalize-Y $dropY; button = "left"; modifiers = @() } }
  )

  return [ordered]@{
    process_id = [int]$sourceWindowProcessId
    expected_action_families = @("click", "drag")
    expected_actions = $expectedActions
  }
}

function Run-ExplorerFileOpenScenario() {
  $dir = Join-Path $env:TEMP ("kortix-explorer-file-open-" + [DateTime]::UtcNow.ToString("HHmmss"))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $dir "anchor") | Out-Null

  $marker = "kortix explorer file open marker " + [Guid]::NewGuid().ToString("N")
  $fileName = "open-trace-" + [DateTime]::UtcNow.ToString("HHmmss") + ".txt"
  $titleNeedle = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
  $filePath = Join-Path $dir $fileName
  Set-Content -Encoding UTF8 -Path $filePath -Value $marker

  $argument = "/select,`"$filePath`""
  $process = Start-Process explorer.exe -ArgumentList $argument -PassThru
  Start-Sleep -Milliseconds 2200
  $handle = Wait-ExplorerWindowForPath $dir 12000

  $screenWidth = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(0))
  $screenHeight = [Math]::Max(1, [KortixUser32]::GetSystemMetrics(1))
  $gap = 24
  $windowWidth = [Math]::Min(760, $screenWidth - ($gap * 2))
  $windowWidth = [Math]::Max(520, $windowWidth)
  $windowHeight = [Math]::Min(620, $screenHeight - 90)
  $windowHeight = [Math]::Max(360, $windowHeight)
  $windowTop = 40

  $rect = Move-WindowChecked $handle $gap $windowTop $windowWidth $windowHeight

  $explorerProcessId = [uint32]0
  [KortixUser32]::GetWindowThreadProcessId($handle, [ref]$explorerProcessId) | Out-Null
  Set-ForegroundWindowRobust $handle 9 8 180 | Out-Null
  Start-Sleep -Milliseconds 900

  $fileX = $rect.Left + 190
  $fileY = $rect.Top + 154

  Add-Phase "explorer_file_open_focused" @{
    hwnd = $handle.ToInt64()
    directory = $dir
    anchor_folder = "anchor"
    file_name = $fileName
    file_path = $filePath
    marker = $marker
    explorer_process_id = [int]$explorerProcessId
    launcher_process_id = $process.Id
  }

  Move-Stepped ($rect.Left + 60) ($rect.Top + 90) $fileX $fileY 8 45
  DoubleClick-Left $fileX $fileY
  Add-Phase "open_file_double_click" @{
    x = $fileX
    y = $fileY
    file_name = $fileName
    button = "left"
    clicks = 2
  }

  $notepad = Wait-VisibleWindowByTitle $titleNeedle 10000 200
  $editHandle = Get-NotepadEditHandle $notepad.hwnd
  $verifiedText = Wait-WindowTextContains $editHandle $marker "Notepad opened Explorer file" 6000 150
  Set-ForegroundWindowRobust $notepad.hwnd 9 6 150 | Out-Null
  Add-Phase "opened_file_verified" @{
    notepad_hwnd = $notepad.hwnd.ToInt64()
    notepad_process_id = $notepad.process_id
    title = $notepad.title
    marker = $marker
    text_length = $verifiedText.Length
  }
  Start-Sleep -Milliseconds 1200

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $fileX; y = Normalize-Y $fileY; clicks = 2; button = "left"; modifiers = @() } }
  )

  return [ordered]@{
    process_id = [int]$explorerProcessId
    expected_action_families = @("click")
    expected_actions = $expectedActions
  }
}

function Run-WindowsRunCalculatorScenario() {
  $expressionText = "12+3"

  Press-WinKey $VK_R
  Add-Phase "run_dialog_open" @{ hotkey = "win+r" }
  Start-Sleep -Milliseconds 700

  $runWindow = Wait-VisibleWindowByTitle "Run" 5000 150
  Add-Phase "run_dialog_visible" @{ hwnd = $runWindow.hwnd.ToInt64(); title = $runWindow.title }

  Send-KeyboardText "calc" 60
  Add-Phase "type_run_command" @{ text = "calc" }
  Start-Sleep -Milliseconds 250

  Press-Key $VK_RETURN
  Add-Phase "launch_calculator" @{ key = "enter" }
  Start-Sleep -Milliseconds 1800

  $calculatorWindow = Wait-VisibleWindowByTitle "Calculator" 12000 250
  Set-ForegroundWindowRobust $calculatorWindow.hwnd 9 8 180 | Out-Null
  Start-Sleep -Milliseconds 700

  $rect = Get-WindowRectChecked $calculatorWindow.hwnd
  Add-Phase "calculator_visible" @{
    hwnd = $calculatorWindow.hwnd.ToInt64()
    process_id = $calculatorWindow.process_id
    title = $calculatorWindow.title
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
  }

  Send-KeyboardText "12" 70
  Press-Key $VK_ADD
  Start-Sleep -Milliseconds 70
  Send-KeyboardText "3" 70
  Add-Phase "calculator_expression_typed" @{ text = $expressionText }
  Start-Sleep -Milliseconds 400

  Press-Key $VK_RETURN
  Add-Phase "calculator_expression_submitted" @{ key = "enter"; expected_result = "15" }
  Start-Sleep -Milliseconds 1000

  Press-AltKey $VK_F4
  Add-Phase "calculator_close" @{ hotkey = "alt+f4" }
  Start-Sleep -Milliseconds 900

  $expectedActions = @(
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("windows", "r") } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "calc" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $expressionText } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("alt", "f4") } }
  )

  return [ordered]@{
    process_id = $calculatorWindow.process_id
    expected_action_families = @("typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-BrowserFormScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-form-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Form Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #f6f7fb; color: #172033; min-height: 1500px; }
    main { width: 820px; background: white; border: 1px solid #cfd7e6; padding: 16px; }
    h1 { font-size: 24px; margin: 0 0 10px 0; }
    label { display: block; margin-top: 8px; font-size: 16px; font-weight: 600; }
    input, textarea { display: block; width: 580px; font-size: 18px; padding: 7px; margin-top: 4px; border: 2px solid #73819a; }
    textarea { height: 58px; }
    .checkline { margin-top: 12px; font-size: 16px; }
    .checkline input { display: inline-block; width: auto; transform: scale(1.4); margin-right: 12px; }
    input[type=range] { width: 580px; padding: 0; }
    .spacer { height: 640px; border-top: 1px solid #d8deea; margin-top: 20px; padding-top: 18px; }
    .bottom { height: 260px; background: #e8eef9; padding: 24px; font-size: 22px; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser form scenario</h1>
    <label>Name <input id="name" autocomplete="off"></label>
    <label>Email <input id="email" autocomplete="off"></label>
    <label>Search <input id="search" autocomplete="off" value="replace me"></label>
    <label>Notes <textarea id="notes"></textarea></label>
    <div class="checkline"><input id="confirm" type="checkbox"> Confirm training data capture</div>
    <label>Confidence <input id="confidence" type="range" min="0" max="100" value="20"></label>
    <div class="spacer">Scroll target area</div>
    <div class="bottom">Bottom of form reached</div>
  </main>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_form scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $nameX = $left + 250
  $nameY = $top + 150
  $checkboxX = $left + 70
  $checkboxY = $top + 410
  $sliderStartX = $left + 290
  $sliderY = $top + 470
  $sliderEndX = $left + 620

  Add-Phase "browser_form_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Move-Stepped ($left + 60) ($top + 80) $nameX $nameY 12 45
  Click-Left
  Add-Phase "click_name" @{ x = $nameX; y = $nameY; button = "left" }
  Start-Sleep -Milliseconds 180
  Send-AsciiText "browser form validation" 50
  Add-Phase "type_name" @{ text = "browser form validation" }
  Start-Sleep -Milliseconds 180

  Press-Key $VK_TAB
  Start-Sleep -Milliseconds 120
  Send-AsciiText "trace example com" 50
  Add-Phase "tab_type_email" @{ text = "trace example com" }
  Start-Sleep -Milliseconds 180

  Press-Key $VK_TAB
  Start-Sleep -Milliseconds 120
  Press-CtrlA
  Start-Sleep -Milliseconds 120
  Press-Key $VK_BACK
  Start-Sleep -Milliseconds 120
  Send-AsciiText "final query" 50
  Add-Phase "replace_search" @{ hotkey = "ctrl+a"; delete_key = "backspace"; text = "final query" }
  Start-Sleep -Milliseconds 180

  Press-Key $VK_TAB
  Start-Sleep -Milliseconds 120
  Send-AsciiText "line one" 50
  Start-Sleep -Milliseconds 240
  Press-Key $VK_RETURN
  Start-Sleep -Milliseconds 160
  Send-AsciiText "line two" 50
  Add-Phase "type_notes" @{ text = "line one\\nline two" }
  Start-Sleep -Milliseconds 180

  Press-ShiftTab
  Add-Phase "shift_tab" @{ hotkey = "shift+tab" }
  Start-Sleep -Milliseconds 160
  Press-Key $VK_TAB
  Start-Sleep -Milliseconds 160

  Move-Stepped $nameX $nameY $checkboxX $checkboxY 12 40
  Click-LeftRobust 160
  Add-Phase "click_checkbox" @{ x = $checkboxX; y = $checkboxY; button = "left" }
  Start-Sleep -Milliseconds 850

  Drag-Absolute $sliderStartX $sliderY $sliderEndX $sliderY 12 70
  Add-Phase "drag_slider" @{ start_x = $sliderStartX; start_y = $sliderY; end_x = $sliderEndX; end_y = $sliderY; steps = 12 }
  Start-Sleep -Milliseconds 900

  Scroll-DownDetents $sliderEndX $sliderY 3 120
  Add-Phase "scroll_page" @{ clicks = -3 }
  Start-Sleep -Milliseconds 450

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $nameX; y = Normalize-Y $nameY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "browser form validation" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "trace example com" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "a") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "backspace" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "final query" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "line one" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "line two" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $checkboxX; y = Normalize-Y $checkboxY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $sliderStartX; start_y = Normalize-Y $sliderY; end_x = Normalize-X $sliderEndX; end_y = Normalize-Y $sliderY; button = "left"; modifiers = @() } },
    [ordered]@{ type = "scroll"; args = [ordered]@{ clicks = -12; x = Normalize-X $sliderEndX; y = Normalize-Y $sliderY } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "drag", "scroll", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-BrowserModifiersScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-modifiers-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Modifier Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #eef3f8; color: #172033; }
    main { width: 920px; background: white; border: 1px solid #b8c6d8; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 12px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .target { height: 150px; border: 3px solid #345995; background: #dce9ff; font-size: 20px; font-weight: 700; display: flex; align-items: center; justify-content: center; user-select: none; }
    .wide { grid-column: 1 / span 2; height: 170px; background: #ecf7e8; border-color: #31704b; }
    #log { margin-top: 16px; min-height: 130px; border: 2px solid #58677d; background: #111827; color: #f8fafc; padding: 12px; font: 18px Consolas, monospace; white-space: pre-line; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser modifier scenario</h1>
    <div class="grid">
      <div id="ctrlClick" class="target">Ctrl Click Target</div>
      <div id="comboClick" class="target">Ctrl Shift Click Target</div>
      <div id="dragZone" class="target wide">Ctrl Shift Drag Zone</div>
      <div id="rightClick" class="target">Ctrl Right Click Target</div>
      <div id="spare" class="target">Visible State Panel</div>
    </div>
    <div id="log">ready</div>
  </main>
  <script>
    var log = document.getElementById("log");
    function describe(event) {
      var parts = [];
      if (event.ctrlKey) parts.push("ctrl");
      if (event.shiftKey) parts.push("shift");
      if (event.altKey) parts.push("alt");
      parts.push("button=" + event.button);
      return parts.join("+");
    }
    function append(name, event) {
      log.textContent = name + " " + describe(event) + "\n" + log.textContent;
    }
    document.getElementById("ctrlClick").addEventListener("click", function(event) { append("ctrl-click", event); });
    document.getElementById("comboClick").addEventListener("click", function(event) { append("ctrl-shift-click", event); });
    document.getElementById("rightClick").addEventListener("contextmenu", function(event) { event.preventDefault(); append("ctrl-right-click", event); });
    var dragZone = document.getElementById("dragZone");
    dragZone.addEventListener("mousedown", function(event) { append("drag-start", event); });
    dragZone.addEventListener("mouseup", function(event) { append("drag-end", event); });
  </script>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-modifiers-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_modifiers scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $ctrlClickX = $left + 190
  $ctrlClickY = $top + 210
  $comboClickX = $left + 590
  $comboClickY = $top + 210
  $dragStartX = $left + 180
  $dragStartY = $top + 410
  $dragEndX = $left + 720
  $dragEndY = $top + 410
  $rightClickX = $left + 200
  $rightClickY = $top + 610

  Add-Phase "browser_modifiers_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 120
  Move-Stepped ($left + 70) ($top + 90) $ctrlClickX $ctrlClickY 8 45
  Click-LeftRobust 150
  Add-Phase "ctrl_click" @{ x = $ctrlClickX; y = $ctrlClickY; button = "left"; modifiers = @("ctrl") }
  Start-Sleep -Milliseconds 120
  Send-KeyInput $VK_CONTROL $true
  Start-Sleep -Milliseconds 650

  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 60
  Send-KeyInput $VK_SHIFT
  Start-Sleep -Milliseconds 120
  Move-Stepped $ctrlClickX $ctrlClickY $comboClickX $comboClickY 8 45
  Click-LeftRobust 150
  Add-Phase "ctrl_shift_click" @{ x = $comboClickX; y = $comboClickY; button = "left"; modifiers = @("ctrl", "shift") }
  Start-Sleep -Milliseconds 120
  Send-KeyInput $VK_SHIFT $true
  Start-Sleep -Milliseconds 60
  Send-KeyInput $VK_CONTROL $true
  Start-Sleep -Milliseconds 650

  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 60
  Send-KeyInput $VK_SHIFT
  Start-Sleep -Milliseconds 120
  Drag-Absolute $dragStartX $dragStartY $dragEndX $dragEndY 14 65
  Add-Phase "ctrl_shift_drag" @{ start_x = $dragStartX; start_y = $dragStartY; end_x = $dragEndX; end_y = $dragEndY; modifiers = @("ctrl", "shift") }
  Start-Sleep -Milliseconds 140
  Send-KeyInput $VK_SHIFT $true
  Start-Sleep -Milliseconds 60
  Send-KeyInput $VK_CONTROL $true
  Start-Sleep -Milliseconds 800

  Send-KeyInput $VK_CONTROL
  Start-Sleep -Milliseconds 120
  Move-Stepped $dragEndX $dragEndY $rightClickX $rightClickY 10 45
  Click-RightRobust 160
  Add-Phase "ctrl_right_click" @{ x = $rightClickX; y = $rightClickY; button = "right"; modifiers = @("ctrl") }
  Start-Sleep -Milliseconds 120
  Send-KeyInput $VK_CONTROL $true
  Start-Sleep -Milliseconds 700

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $ctrlClickX; y = Normalize-Y $ctrlClickY; clicks = 1; button = "left"; modifiers = @("ctrl") } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $comboClickX; y = Normalize-Y $comboClickY; clicks = 1; button = "left"; modifiers = @("ctrl", "shift") } },
    [ordered]@{ type = "drag"; args = [ordered]@{ start_x = Normalize-X $dragStartX; start_y = Normalize-Y $dragStartY; end_x = Normalize-X $dragEndX; end_y = Normalize-Y $dragEndY; button = "left"; modifiers = @("ctrl", "shift") } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $rightClickX; y = Normalize-Y $rightClickY; clicks = 1; button = "right"; modifiers = @("ctrl") } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "drag")
    expected_actions = $expectedActions
  }
}

function Run-BrowserMouseVariantsScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-mouse-variants-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Mouse Variants Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #f2f4f7; color: #182235; min-height: 1700px; }
    main { width: 920px; background: white; border: 1px solid #b8c4d5; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 14px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .target { height: 160px; border: 3px solid #2f5d8c; background: #dceeff; font-size: 20px; font-weight: 700; display: flex; align-items: center; justify-content: center; user-select: none; }
    .scrollpad { grid-column: 1 / span 2; height: 420px; background: linear-gradient(#edf7e5, #d6ead0); border-color: #397d49; align-items: flex-start; padding-top: 44px; }
    #log { margin-top: 16px; min-height: 160px; border: 2px solid #526276; background: #111827; color: #f8fafc; padding: 12px; font: 18px Consolas, monospace; white-space: pre-line; }
    .tail { height: 760px; margin-top: 20px; border-top: 1px solid #ccd6e5; padding-top: 24px; font-size: 24px; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser mouse variants scenario</h1>
    <div class="grid">
      <div id="middleTarget" class="target">Middle Click Target</div>
      <div id="altTarget" class="target">Alt Click Target</div>
      <div id="scrollPad" class="target scrollpad">Scroll Direction Pad</div>
    </div>
    <div id="log">ready</div>
    <div class="tail">Lower scroll marker</div>
  </main>
  <script>
    var log = document.getElementById("log");
    function modifiers(event) {
      var parts = [];
      if (event.altKey) parts.push("alt");
      if (event.ctrlKey) parts.push("ctrl");
      if (event.shiftKey) parts.push("shift");
      return parts.length ? parts.join("+") : "none";
    }
    function append(name, event) {
      log.textContent = name + " button=" + event.button + " modifiers=" + modifiers(event) + "\n" + log.textContent;
    }
    document.getElementById("middleTarget").addEventListener("auxclick", function(event) { event.preventDefault(); append("middle-click", event); });
    document.getElementById("middleTarget").addEventListener("mousedown", function(event) { if (event.button === 1) event.preventDefault(); });
    document.getElementById("altTarget").addEventListener("click", function(event) { append("alt-click", event); });
    document.getElementById("scrollPad").addEventListener("wheel", function(event) { append(event.deltaY < 0 ? "scroll-up" : "scroll-down", event); });
  </script>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-mouse-variants-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_mouse_variants scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $middleX = $left + 220
  $middleY = $top + 220
  $altX = $left + 620
  $altY = $top + 220
  $scrollX = $left + 460
  $scrollY = $top + 470

  Add-Phase "browser_mouse_variants_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Move-Stepped ($left + 70) ($top + 90) $middleX $middleY 8 45
  Click-MiddleRobust 150
  Add-Phase "middle_click" @{ x = $middleX; y = $middleY; button = "middle" }
  Start-Sleep -Milliseconds 750

  Send-KeyInput $VK_MENU
  Start-Sleep -Milliseconds 120
  Move-Stepped $middleX $middleY $altX $altY 8 45
  Click-LeftRobust 150
  Add-Phase "alt_click" @{ x = $altX; y = $altY; button = "left"; modifiers = @("alt") }
  Start-Sleep -Milliseconds 120
  Send-KeyInput $VK_MENU $true
  Start-Sleep -Milliseconds 750

  Move-Stepped $altX $altY $scrollX $scrollY 8 45
  Scroll-DownDetents $scrollX $scrollY 2 130
  Add-Phase "scroll_down" @{ clicks = -2; x = $scrollX; y = $scrollY }
  Start-Sleep -Milliseconds 850

  Scroll-UpDetents $scrollX $scrollY 2 130
  Add-Phase "scroll_up" @{ clicks = 2; x = $scrollX; y = $scrollY }
  Start-Sleep -Milliseconds 650

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $middleX; y = Normalize-Y $middleY; clicks = 1; button = "middle"; modifiers = @() } },
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $altX; y = Normalize-Y $altY; clicks = 1; button = "left"; modifiers = @("alt") } },
    [ordered]@{ type = "scroll"; args = [ordered]@{ clicks = -8; x = Normalize-X $scrollX; y = Normalize-Y $scrollY } },
    [ordered]@{ type = "scroll"; args = [ordered]@{ clicks = 8; x = Normalize-X $scrollX; y = Normalize-Y $scrollY } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "scroll")
    expected_actions = $expectedActions
  }
}

function Run-BrowserClipboardShortcutsScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-clipboard-shortcuts-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Clipboard Shortcuts Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #f3f6fa; color: #142035; }
    main { width: 940px; background: white; border: 1px solid #b8c4d5; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 14px 0; }
    label { display: block; margin-top: 12px; font-size: 16px; font-weight: 700; }
    input, textarea { display: block; width: 720px; font-size: 20px; padding: 8px; margin-top: 5px; border: 2px solid #52627a; }
    textarea { height: 56px; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
    .panel { min-height: 132px; border: 2px solid #52627a; padding: 12px; font: 18px Consolas, monospace; white-space: pre-line; }
    #state { background: #e9f3ec; color: #12321f; }
    #log { background: #111827; color: #f8fafc; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser clipboard shortcuts scenario</h1>
    <label>Source input <input id="source" autocomplete="off"></label>
    <label>Destination box <textarea id="destination"></textarea></label>
    <label>Clipboard state box <textarea id="sink"></textarea></label>
    <div class="panels">
      <div id="state" class="panel">source=[]
destination=[]
state=[]</div>
      <div id="log" class="panel">ready</div>
    </div>
  </main>
  <script>
    var log = document.getElementById("log");
    var state = document.getElementById("state");
    function fieldValue(id) {
      return document.getElementById(id).value || "";
    }
    function append(message) {
      log.textContent = message + "\n" + log.textContent;
    }
    function updateState(reason) {
      state.textContent =
        "source=[" + fieldValue("source") + "]\n" +
        "destination=[" + fieldValue("destination") + "]\n" +
        "state=[" + fieldValue("sink") + "]\n" +
        "last=" + reason;
    }
    function scheduleUpdate(reason) {
      window.setTimeout(function() { updateState(reason); }, 90);
    }
    function watch(id) {
      var field = document.getElementById(id);
      field.addEventListener("input", function() { scheduleUpdate(id + " input"); });
      field.addEventListener("keyup", function() { scheduleUpdate(id + " keyup"); });
      field.addEventListener("paste", function() { append("paste into " + id); scheduleUpdate(id + " paste"); });
      field.addEventListener("cut", function() { append("cut from " + id); scheduleUpdate(id + " cut"); });
      field.addEventListener("copy", function() { append("copy from " + id); scheduleUpdate(id + " copy"); });
    }
    watch("source");
    watch("destination");
    watch("sink");
    document.addEventListener("keydown", function(event) {
      var key = event.key || String.fromCharCode(event.keyCode || event.which);
      var lower = String(key).toLowerCase();
      if (event.ctrlKey && event.shiftKey && lower === "y") {
        event.preventDefault();
        event.returnValue = false;
        append("blocked ctrl+shift+y");
        updateState("blocked ctrl+shift+y");
        return false;
      }
      if (event.ctrlKey && (lower === "a" || lower === "c" || lower === "v" || lower === "x")) {
        append("shortcut ctrl+" + lower);
        scheduleUpdate("shortcut ctrl+" + lower);
      }
      return true;
    });
    updateState("ready");
  </script>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-clipboard-shortcuts-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_clipboard_shortcuts scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $sourceX = $left + 310
  $sourceY = $top + 170
  $sourceText = "Clipboard source 2026"

  Add-Phase "browser_clipboard_shortcuts_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Move-Stepped ($left + 70) ($top + 90) $sourceX $sourceY 10 45
  Click-LeftRobust 150
  Add-Phase "click_source" @{ x = $sourceX; y = $sourceY; button = "left" }
  Start-Sleep -Milliseconds 220

  Send-KeyboardText $sourceText 50
  Add-Phase "type_source" @{ text = $sourceText }
  Start-Sleep -Milliseconds 260

  Press-CtrlA
  Add-Phase "select_source" @{ hotkey = "ctrl+a" }
  Start-Sleep -Milliseconds 260

  Press-CtrlC
  Add-Phase "copy_source" @{ hotkey = "ctrl+c" }
  Start-Sleep -Milliseconds 360

  Press-Key $VK_TAB
  Add-Phase "tab_to_destination" @{ key = "tab" }
  Start-Sleep -Milliseconds 260

  Press-CtrlV
  Add-Phase "paste_destination" @{ hotkey = "ctrl+v" }
  Start-Sleep -Milliseconds 460

  Press-CtrlA
  Add-Phase "select_destination" @{ hotkey = "ctrl+a" }
  Start-Sleep -Milliseconds 260

  Press-CtrlX
  Add-Phase "cut_destination" @{ hotkey = "ctrl+x" }
  Start-Sleep -Milliseconds 460

  Press-Key $VK_TAB
  Add-Phase "tab_to_state_box" @{ key = "tab" }
  Start-Sleep -Milliseconds 260

  Press-CtrlV
  Add-Phase "paste_state_box" @{ hotkey = "ctrl+v" }
  Start-Sleep -Milliseconds 460

  Press-CtrlShiftY
  Add-Phase "blocked_ctrl_shift_y" @{ hotkey = "ctrl+shift+y"; prevented_default = $true }
  Start-Sleep -Milliseconds 700

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $sourceX; y = Normalize-Y $sourceY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $sourceText } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "a") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "c") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "v") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "a") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "x") } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "tab" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "v") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "Y") } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-BrowserKeyboardNavigationScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-keyboard-navigation-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Keyboard Navigation Scenario</title>
  <style>
    html, body { margin: 0; padding: 0; }
    body { font-family: Segoe UI, Arial, sans-serif; background: #eef2f6; color: #132238; min-height: 1900px; }
    main { width: 940px; margin: 0; padding: 170px 18px 18px 18px; }
    h1 { font-size: 24px; margin: 0 0 12px 0; }
    #surface { min-height: 520px; border: 3px solid #315f83; background: #ffffff; padding: 16px; outline: none; }
    #surface:focus { border-color: #12805c; box-shadow: inset 0 0 0 4px #b8ead6; }
    #state { position: fixed; top: 12px; left: 18px; width: 880px; z-index: 2; border: 2px solid #3b4a5f; background: #101827; color: #f8fafc; padding: 12px; font: 18px Consolas, monospace; white-space: pre-line; }
    #viewport { height: 300px; margin-top: 16px; border: 2px solid #9aa8ba; background: #dfe9f5; position: relative; overflow: hidden; }
    #cursor { position: absolute; width: 62px; height: 62px; left: 110px; top: 115px; background: #f8c14f; border: 3px solid #6b3f00; text-align: center; line-height: 62px; font-size: 26px; font-weight: 700; }
    .marker { height: 360px; margin-top: 22px; padding: 24px; border: 2px solid #b5c2d1; background: #f7fafc; font-size: 28px; font-weight: 700; }
    .marker:nth-child(odd) { background: #e7f4eb; }
    #bottomMarker { background: #fff1d4; border-color: #d39b22; }
  </style>
</head>
<body>
  <main>
    <div id="surface" tabindex="0">
      <h1>Kortix browser keyboard navigation scenario</h1>
      <div id="state">ready
last=none
position=110,115
scroll=0
right=0
down=0</div>
      <div id="viewport"><div id="cursor">K</div></div>
      <div id="topMarker" class="marker">Top marker</div>
      <div class="marker">Middle marker A</div>
      <div class="marker">Middle marker B</div>
      <div id="bottomMarker" class="marker">Bottom marker</div>
    </div>
  </main>
  <script>
    var surface = document.getElementById("surface");
    var state = document.getElementById("state");
    var cursor = document.getElementById("cursor");
    var topMarker = document.getElementById("topMarker");
    var bottomMarker = document.getElementById("bottomMarker");
    var x = 110;
    var y = 115;
    var rightCount = 0;
    var downCount = 0;
    var log = ["ready"];

    function scrollTopValue() {
      return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    function updateState(name) {
      cursor.style.left = x + "px";
      cursor.style.top = y + "px";
      log.unshift(name);
      if (log.length > 6) log.length = 6;
      state.textContent =
        "last=" + name + "\n" +
        "position=" + x + "," + y + "\n" +
        "scroll=" + Math.round(scrollTopValue()) + "\n" +
        "right=" + rightCount + "\n" +
        "down=" + downCount + "\n" +
        "log=" + log.join(" > ");
    }

    function keyName(event) {
      var key = event.key || "";
      var code = event.keyCode || event.which || 0;
      if (key === "PageDown" || code === 34) return "pagedown";
      if (key === "PageUp" || code === 33) return "pageup";
      if (key === "Home" || code === 36) return "home";
      if (key === "End" || code === 35) return "end";
      if (key === "Escape" || key === "Esc" || code === 27) return "esc";
      if (key === "ArrowRight" || key === "Right" || code === 39) return "right";
      if (key === "ArrowDown" || key === "Down" || code === 40) return "down";
      return String(key).toLowerCase();
    }

    surface.addEventListener("mousedown", function() {
      surface.focus();
    });

    surface.addEventListener("keydown", function(event) {
      var name = keyName(event);
      if (name === "home") {
        event.preventDefault();
        topMarker.scrollIntoView(true);
        x = 70;
        y = 40;
        updateState("home");
      } else if (name === "end") {
        event.preventDefault();
        bottomMarker.scrollIntoView(false);
        x = 760;
        y = 220;
        updateState("end");
      } else if (name === "pageup") {
        event.preventDefault();
        window.scrollTo(0, Math.max(0, scrollTopValue() - 520));
        x = 180;
        y = 90;
        updateState("pageup");
      } else if (name === "pagedown") {
        event.preventDefault();
        window.scrollTo(0, scrollTopValue() + 520);
        x = 620;
        y = 190;
        updateState("pagedown");
      } else if (name === "right") {
        event.preventDefault();
        rightCount += 1;
        x = Math.min(830, x + 36);
        updateState("right-" + rightCount);
      } else if (name === "down") {
        event.preventDefault();
        downCount += 1;
        y = Math.min(230, y + 34);
        updateState("down-" + downCount);
      } else if (name === "esc") {
        event.preventDefault();
        x = 110;
        y = 115;
        updateState("esc");
      }
      return true;
    });

    surface.focus();
    updateState("focused");
  </script>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-keyboard-navigation-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_keyboard_navigation scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $focusX = $left + 340
  $focusY = $top + 340

  Add-Phase "browser_keyboard_navigation_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Move-Stepped ($left + 70) ($top + 90) $focusX $focusY 10 45
  Click-LeftRobust 150
  Add-Phase "click_keyboard_surface" @{ x = $focusX; y = $focusY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Press-Key $VK_HOME
  Add-Phase "press_home" @{ key = "home" }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_END
  Add-Phase "press_end" @{ key = "end" }
  Start-Sleep -Milliseconds 950

  Press-Key $VK_PRIOR
  Add-Phase "press_pageup" @{ key = "pageup" }
  Start-Sleep -Milliseconds 850

  Press-Key $VK_NEXT
  Add-Phase "press_pagedown" @{ key = "pagedown" }
  Start-Sleep -Milliseconds 850

  for ($i = 0; $i -lt 4; $i++) {
    Press-Key $VK_RIGHT 35
    Start-Sleep -Milliseconds 85
  }
  Add-Phase "repeat_right" @{ key = "right"; count = 4 }
  Start-Sleep -Milliseconds 750

  for ($i = 0; $i -lt 3; $i++) {
    Press-Key $VK_DOWN 35
    Start-Sleep -Milliseconds 85
  }
  Add-Phase "repeat_down" @{ key = "down"; count = 3 }
  Start-Sleep -Milliseconds 750

  Press-Key $VK_ESCAPE
  Add-Phase "press_escape" @{ key = "esc" }
  Start-Sleep -Milliseconds 900

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $focusX; y = Normalize-Y $focusY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "home" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "end" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "pageup" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "pagedown" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "right"; count = 4 } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "down"; count = 3 } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "esc" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-BrowserEditingKeysScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-editing-keys-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Editing Keys Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #eef3f0; color: #132238; }
    main { width: 960px; background: white; border: 1px solid #9fb0c5; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 14px 0; }
    label { display: block; margin-top: 12px; font-size: 16px; font-weight: 700; }
    textarea { display: block; width: 760px; height: 120px; font: 22px Consolas, monospace; padding: 10px; margin-top: 6px; border: 3px solid #405875; }
    textarea:focus { border-color: #08724f; box-shadow: 0 0 0 4px #b9ead8; outline: none; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
    .panel { min-height: 154px; border: 2px solid #53657c; padding: 12px; font: 18px Consolas, monospace; white-space: pre-line; }
    #state { background: #e9f5ee; color: #12321f; }
    #log { background: #111827; color: #f8fafc; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser editing keys scenario</h1>
    <label>Editor<textarea id="editor" spellcheck="false" autocomplete="off"></textarea></label>
    <div class="panels">
      <div id="state" class="panel">value=[]
length=0
selection=0:0
last=ready</div>
      <div id="log" class="panel">ready</div>
    </div>
  </main>
  <script>
    var editor = document.getElementById("editor");
    var state = document.getElementById("state");
    var log = document.getElementById("log");
    var entries = ["ready"];

    function keyName(event) {
      var key = event.key || "";
      var code = event.keyCode || event.which || 0;
      if (key === "Backspace" || code === 8) return "backspace";
      if (key === "Delete" || key === "Del" || code === 46) return "delete";
      if (key === "Enter" || key === "Return" || code === 13) return "enter";
      if (key === "ArrowLeft" || key === "Left" || code === 37) return "left";
      return String(key).toLowerCase();
    }

    function append(message) {
      entries.unshift(message);
      if (entries.length > 7) entries.length = 7;
      log.textContent = entries.join("\n");
    }

    function updateState(reason) {
      state.textContent =
        "value=[" + editor.value + "]\n" +
        "length=" + editor.value.length + "\n" +
        "selection=" + editor.selectionStart + ":" + editor.selectionEnd + "\n" +
        "last=" + reason;
    }

    function scheduleState(reason) {
      window.setTimeout(function() { updateState(reason); }, 100);
    }

    editor.addEventListener("keydown", function(event) {
      var name = keyName(event);
      var lower = name.toLowerCase();
      if (event.ctrlKey && (lower === "z" || lower === "y")) {
        append("hotkey ctrl+" + lower);
        scheduleState("hotkey ctrl+" + lower);
      } else if (name === "backspace" || name === "delete" || name === "enter" || name === "left") {
        append("press " + name);
        scheduleState("press " + name);
      }
    });
    editor.addEventListener("input", function() { scheduleState("input"); });
    editor.addEventListener("keyup", function(event) { scheduleState("keyup " + keyName(event)); });
    editor.focus();
    updateState("focused");
  </script>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-editing-keys-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_editing_keys scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 360
  $editorY = $top + 210
  $firstText = "alpha beta"
  $secondText = "second line"

  Add-Phase "browser_editing_keys_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Move-Stepped ($left + 70) ($top + 90) $editorX $editorY 10 45
  Click-LeftRobust 150
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-KeyboardText $firstText 50
  Add-Phase "type_first_text" @{ text = $firstText }
  Start-Sleep -Milliseconds 750

  Press-Key $VK_RETURN
  Add-Phase "press_enter" @{ key = "enter" }
  Start-Sleep -Milliseconds 750

  Send-KeyboardText $secondText 50
  Add-Phase "type_second_text" @{ text = $secondText }
  Start-Sleep -Milliseconds 750

  Press-Key $VK_BACK
  Add-Phase "press_backspace" @{ key = "backspace" }
  Start-Sleep -Milliseconds 750

  Press-Key $VK_LEFT
  Add-Phase "press_left" @{ key = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_DELETE
  Add-Phase "press_delete" @{ key = "delete" }
  Start-Sleep -Milliseconds 750

  Press-CtrlZ
  Add-Phase "undo_delete" @{ hotkey = "ctrl+z" }
  Start-Sleep -Milliseconds 850

  Press-CtrlY
  Add-Phase "redo_delete" @{ hotkey = "ctrl+y" }
  Start-Sleep -Milliseconds 900

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $firstText } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "enter" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $secondText } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "backspace" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "left" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "delete" } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "z") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "y") } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-BrowserWordShortcutsScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-word-shortcuts-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser Word Shortcuts Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #f0f4f7; color: #132238; }
    main { width: 960px; background: white; border: 1px solid #9fb0c5; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 14px 0; }
    label { display: block; margin-top: 12px; font-size: 16px; font-weight: 700; }
    textarea { display: block; width: 780px; height: 104px; font: 22px Consolas, monospace; padding: 10px; margin-top: 6px; border: 3px solid #405875; }
    textarea:focus { border-color: #08724f; box-shadow: 0 0 0 4px #b9ead8; outline: none; }
    #state { margin-top: 16px; width: 780px; min-height: 80px; border: 2px solid #53657c; padding: 12px; font: 18px Consolas, monospace; background: #eef8f1; color: #12321f; white-space: pre-line; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser word shortcuts scenario</h1>
    <label>Editor<textarea id="editor" spellcheck="false" autocomplete="off"></textarea></label>
    <div id="state">Native text-field word movement and deletion are visible in the editor value.</div>
  </main>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-word-shortcuts-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_word_shortcuts scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $editorX = $left + 370
  $editorY = $top + 205
  $text = "alpha beta gamma delta"

  Add-Phase "browser_word_shortcuts_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser }

  Move-Stepped ($left + 70) ($top + 90) $editorX $editorY 10 45
  Click-LeftRobust 150
  Add-Phase "click_editor" @{ x = $editorX; y = $editorY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Send-KeyboardText $text 50
  Add-Phase "type_words" @{ text = $text }
  Start-Sleep -Milliseconds 800

  Press-CtrlKey $VK_LEFT
  Add-Phase "word_left" @{ hotkey = "ctrl+left" }
  Start-Sleep -Milliseconds 850

  Press-CtrlKey $VK_BACK
  Add-Phase "word_backspace" @{ hotkey = "ctrl+backspace" }
  Start-Sleep -Milliseconds 850

  Press-CtrlKey $VK_LEFT
  Add-Phase "word_left_again" @{ hotkey = "ctrl+left" }
  Start-Sleep -Milliseconds 850

  Press-CtrlKey $VK_RIGHT
  Add-Phase "word_right" @{ hotkey = "ctrl+right" }
  Start-Sleep -Milliseconds 850

  Press-CtrlKey $VK_DELETE
  Add-Phase "word_delete" @{ hotkey = "ctrl+delete" }
  Start-Sleep -Milliseconds 950

  $expectedActions = @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $editorX; y = Normalize-Y $editorY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = $text } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "left") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "backspace") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "left") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "right") } },
    [ordered]@{ type = "hotkey"; args = [ordered]@{ keys = @("ctrl", "delete") } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

function Run-BrowserCapsLockTypingScenario() {
  $htmlPath = Join-Path $env:TEMP "kortix-browser-capslock-typing-scenario.html"
  $html = @"
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kortix Browser CapsLock Typing Scenario</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 18px; background: #f2f5f8; color: #132238; }
    main { width: 940px; background: white; border: 1px solid #9fb0c5; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 14px 0; }
    label { display: block; margin-top: 12px; font-size: 16px; font-weight: 700; }
    input { display: block; width: 720px; font: 24px Consolas, monospace; padding: 10px; margin-top: 6px; border: 3px solid #405875; }
    input:focus { border-color: #08724f; box-shadow: 0 0 0 4px #b9ead8; outline: none; }
    #state { margin-top: 16px; width: 720px; min-height: 80px; border: 2px solid #53657c; padding: 12px; font: 18px Consolas, monospace; background: #eef8f1; color: #12321f; white-space: pre-line; }
  </style>
</head>
<body>
  <main>
    <h1>Kortix browser CapsLock typing scenario</h1>
    <label>CapsLock input<input id="editor" spellcheck="false" autocomplete="off"></label>
    <div id="state">CapsLock should make abc appear as uppercase, then def should remain lowercase.</div>
  </main>
</body>
</html>
"@
  Set-Content -Encoding UTF8 $htmlPath $html

  $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue
  if ($edge) {
    $edgeProfile = Join-Path $env:TEMP "kortix-edge-capslock-typing-profile"
    Remove-Item -Recurse -Force $edgeProfile -ErrorAction SilentlyContinue
    $urlPath = $htmlPath.Replace("\", "/")
    $url = "file:///$urlPath"
    $args = @(
      "--user-data-dir=$edgeProfile",
      "--no-first-run",
      "--disable-first-run-ui",
      "--disable-features=msEdgeFirstRunExperience",
      "--disable-sync",
      "--disable-extensions",
      "--new-window",
      $url
    )
    $process = Start-Process -FilePath $edge.Source -ArgumentList $args -PassThru
    $browserProcessName = "msedge"
    $browser = "edge"
  } else {
    $hta = Get-Command mshta.exe -ErrorAction SilentlyContinue
    if (-not $hta) { throw "Neither msedge.exe nor mshta.exe was found for browser_capslock_typing scenario" }
    $process = Start-Process -FilePath $hta.Source -ArgumentList @($htmlPath) -PassThru
    $browserProcessName = "mshta"
    $browser = "mshta"
  }
  Start-Sleep -Milliseconds 2600
  $handle = Wait-WindowHandle $process $browserProcessName 12000
  Set-ForegroundWindowRobust $handle 3 | Out-Null
  Start-Sleep -Milliseconds 800

  $rect = Get-WindowRectChecked $handle
  $left = $rect.Left
  $top = $rect.Top
  $inputX = $left + 350
  $inputY = $top + 172
  $capsLockInitiallyOn = Test-ToggleKeyOn $VK_CAPITAL

  Add-Phase "browser_capslock_typing_focused" @{ hwnd = $handle.ToInt64(); html_path = $htmlPath; browser = $browser; capslock_initially_on = $capsLockInitiallyOn }

  $expectedActions = @()
  if ($capsLockInitiallyOn) {
    Press-Key $VK_CAPITAL
    Add-Phase "capslock_reset_off" @{ key = "capslock"; note = "normalizes sticky CapsLock before deterministic typing" }
    Start-Sleep -Milliseconds 650
    $expectedActions += [ordered]@{ type = "press"; args = [ordered]@{ key = "capslock" } }
  }

  Move-Stepped ($left + 70) ($top + 90) $inputX $inputY 10 45
  Click-LeftRobust 150
  Add-Phase "click_input" @{ x = $inputX; y = $inputY; button = "left" }
  Start-Sleep -Milliseconds 650

  Press-Key $VK_SHIFT
  Add-Phase "flush_click_with_shift" @{ key = "shift"; note = "modifier pulse flushes legacy Python pending click before meaningful keys" }
  Start-Sleep -Milliseconds 350

  Press-Key $VK_CAPITAL
  Add-Phase "capslock_on" @{ key = "capslock" }
  Start-Sleep -Milliseconds 650

  Send-KeyboardText "abc" 70
  Add-Phase "type_caps_text" @{ text = "ABC"; note = "CapsLock should make unshifted abc uppercase" }
  Start-Sleep -Milliseconds 750

  Press-Key $VK_CAPITAL
  Add-Phase "capslock_off" @{ key = "capslock" }
  Start-Sleep -Milliseconds 650

  Send-KeyboardText "def" 70
  Add-Phase "type_lower_text" @{ text = "def" }
  Start-Sleep -Milliseconds 900

  $expectedActions += @(
    [ordered]@{ type = "click"; args = [ordered]@{ x = Normalize-X $inputX; y = Normalize-Y $inputY; clicks = 1; button = "left"; modifiers = @() } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "capslock" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "ABC" } },
    [ordered]@{ type = "press"; args = [ordered]@{ key = "capslock" } },
    [ordered]@{ type = "typewrite"; args = [ordered]@{ text = "def" } }
  )

  return [ordered]@{
    process_id = $process.Id
    expected_action_families = @("click", "typewrite", "hotkey_or_press")
    expected_actions = $expectedActions
  }
}

switch ($Scenario) {
  "notepad" { $scenarioResult = Run-NotepadScenario }
  "browser_form" { $scenarioResult = Run-BrowserFormScenario }
  "notepad_advanced" { $scenarioResult = Run-NotepadAdvancedScenario }
  "notepad_selection_shortcuts" { $scenarioResult = Run-NotepadSelectionShortcutsScenario }
  "notepad_mouse_selection" { $scenarioResult = Run-NotepadMouseSelectionScenario }
  "notepad_shift_drag_selection" { $scenarioResult = Run-NotepadShiftDragSelectionScenario }
  "notepad_triple_click_text" { $scenarioResult = Run-NotepadTripleClickTextScenario }
  "notepad_menu_shortcuts" { $scenarioResult = Run-NotepadMenuShortcutsScenario }
  "notepad_context_menu" { $scenarioResult = Run-NotepadContextMenuScenario }
  "notepad_window_controls" { $scenarioResult = Run-NotepadWindowControlsScenario }
  "notepad_window_mouse" { $scenarioResult = Run-NotepadWindowMouseScenario }
  "notepad_window_resize" { $scenarioResult = Run-NotepadWindowResizeScenario }
  "notepad_save_dialog" { $scenarioResult = Run-NotepadSaveDialogScenario }
  "notepad_find_dialog" { $scenarioResult = Run-NotepadFindDialogScenario }
  "notepad_replace_dialog" { $scenarioResult = Run-NotepadReplaceDialogScenario }
  "notepad_print_dialog" { $scenarioResult = Run-NotepadPrintDialogScenario }
  "explorer_file_rename" { $scenarioResult = Run-ExplorerFileRenameScenario }
  "explorer_new_folder" { $scenarioResult = Run-ExplorerNewFolderScenario }
  "explorer_drag_drop" { $scenarioResult = Run-ExplorerDragDropScenario }
  "explorer_file_open" { $scenarioResult = Run-ExplorerFileOpenScenario }
  "windows_run_calculator" { $scenarioResult = Run-WindowsRunCalculatorScenario }
  "browser_modifiers" { $scenarioResult = Run-BrowserModifiersScenario }
  "browser_mouse_variants" { $scenarioResult = Run-BrowserMouseVariantsScenario }
  "browser_clipboard_shortcuts" { $scenarioResult = Run-BrowserClipboardShortcutsScenario }
  "browser_keyboard_navigation" { $scenarioResult = Run-BrowserKeyboardNavigationScenario }
  "browser_editing_keys" { $scenarioResult = Run-BrowserEditingKeysScenario }
  "browser_word_shortcuts" { $scenarioResult = Run-BrowserWordShortcutsScenario }
  "browser_capslock_typing" { $scenarioResult = Run-BrowserCapsLockTypingScenario }
  default { throw "Unsupported scenario: $Scenario" }
}

$manifestDir = Split-Path -Parent $ManifestPath
if ($manifestDir) {
  New-Item -ItemType Directory -Force $manifestDir | Out-Null
}

[ordered]@{
  version = 1
  simulator = "windows_user_flow_simulate.ps1"
  scenario = $Scenario
  started_utc = $phases[0].utc
  completed_utc = [DateTime]::UtcNow.ToString("o")
  process_id = $scenarioResult.process_id
  expected_action_families = $scenarioResult.expected_action_families
  expected_actions = $scenarioResult.expected_actions
  phases = $phases
} | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $ManifestPath

Write-Output "KORTIX_USER_FLOW_MANIFEST $ManifestPath"
