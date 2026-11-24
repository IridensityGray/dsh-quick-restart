<#
  Restarts the DeepSeek Harness desktop app for the "Development plugin restart"
  bundle.

  index.js normally starts this script through WMI (Win32_Process.Create) so it
  outlives the Host process it makes the desktop app stop. Sequence:

    1. Validate that AppPid really is the desktop application executable.
    2. Remember the original command line so the new instance starts the same way.
    3. Ask Windows for a session end (WM_QUERYENDSESSION), then close the main
       window. The desktop shell treats a session end as a real quit, so the close
       is not turned into a tray hide and its normal shutdown path runs (Host
       shutdown, session flush, tray disposal).
    4. If the application is still running after GracefulMs, terminate it. The
       Host still shuts down gracefully when its IPC channel closes.
    5. Wait for the Host process to exit, then start the executable again.

  A WMI start has no console and no exit code to read, so a failure is also
  written to result-<pid>.txt in the log directory for the host route to report.
#>
param(
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][int]$AppPid,
  [int]$HostPid = 0,
  [int]$WaitSeconds = 180,
  [int]$DelayMs = 1200,
  [int]$GracefulMs = 7000,
  [switch]$DryRun,
  # The WMI start passes a raw command line, not argv, so the host pid and the
  # marker key have their own string arguments.
  [string]$HostPidArg = '',
  [string]$MarkerKey = '',
  # 1: WMI child (reports its own pid); 2: console child (progress in its window).
  [int]$Child = 0
)

$ErrorActionPreference = 'Continue'

# A WMI-started script can inherit a blank TEMP; the relaunch and the log both
# need a usable one.
if ([string]::IsNullOrEmpty($env:TEMP) -or -not (Test-Path -LiteralPath $env:TEMP)) {
  $env:TEMP = [System.IO.Path]::GetTempPath()
  $env:TMP = $env:TEMP
}
$logDir = Join-Path $env:TEMP 'dsh-quick-restart'
try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch { }

if ($HostPid -le 0 -and $HostPidArg -ne '') {
  $parsed = 0
  if ([int]::TryParse($HostPidArg, [ref]$parsed)) { $HostPid = $parsed }
}

$script:ShowConsole = $Child -eq 2
$script:ResultFile = $null
if ($Child -eq 1) { $script:ResultFile = Join-Path $logDir ('result-{0}.txt' -f $PID) }

$logPath = Join-Path $logDir ('restart-{0}-{1}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $AppPid)

# The log directory is diagnostics only; keep the newest few result files.
try {
  $obsolete = Get-ChildItem -LiteralPath $logDir -Filter 'result-*.txt' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 3
  foreach ($file in $obsolete) { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
} catch { }

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Message
  try { Add-Content -LiteralPath $logPath -Value $line } catch { }
  if ($script:ShowConsole -eq $true) {
    try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch { }
  }
}

# One exit point for every outcome. A WMI-started helper has no console or exit
# code to read, so a failure is also written to a result file the host route
# reports; a console child keeps its window open so the reason stays visible.
function Complete-Restart([int]$Code, [string]$Message, [switch]$Failed) {
  Write-Log ('result: {0}' -f $Message)
  if ($Failed.IsPresent) {
    if ($null -ne $script:ResultFile -and $Child -eq 1) {
      try { Set-Content -LiteralPath $script:ResultFile -Value $Message -Encoding ASCII } catch { }
    }
    if ($script:ShowConsole -eq $true) {
      try {
        [Console]::Out.WriteLine('')
        [Console]::Out.WriteLine('Press Enter to close this window.')
        [void][Console]::In.ReadLine()
      } catch { }
    }
  }
  exit $Code
}

# When WMI is asked to start this script from the plugin process, the WMI host
# owns the returned process id, not this one: the child reports it instead.
# (An object-valued expression would be collected by the pipeline and written
# as an empty file, so the report is one string.)
if ($Child -eq 1 -and $MarkerKey -ne '') {
  $parentName = ''
  try {
    $own = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $PID) -ErrorAction SilentlyContinue
    if ($null -ne $own) {
      $parent = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $own.ParentProcessId) -ErrorAction SilentlyContinue
      if ($null -ne $parent) { $parentName = [string]$parent.Name }
    }
  } catch { }
  try {
    $data = '{{ "{0}": {1}, "parent": "{2}" }}' -f $MarkerKey, $PID, $parentName
    Set-Content -LiteralPath (Join-Path $logDir ($MarkerKey + '.json')) -Value $data -Encoding ASCII -ErrorAction Stop
  } catch {
    Write-Log ('marker write failed: ' + $_.Exception.Message)
  }
}

$appProcess = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
$appStart = $null
if ($null -ne $appProcess) {
  try { $appStart = $appProcess.StartTime } catch { }
}

# A recycled PID must never be mistaken for the application.
function Test-AppProcess {
  $candidate = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  if ($null -eq $candidate) { return $false }
  if ($null -ne $appStart) {
    try {
      if ($candidate.StartTime -ne $appStart) { return $false }
    } catch {
      return $false
    }
  }
  return $true
}

Write-Log ('helper start; exe="{0}"; appPid={1}; hostPid={2}; wait={3}s; delay={4}ms; dryRun={5}; child={6}' -f $AppExe, $AppPid, $HostPid, $WaitSeconds, $DelayMs, $DryRun.IsPresent, $Child)

if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
  Complete-Restart 2 'the application executable was not found' -Failed
}
if (-not (Test-AppProcess)) {
  Complete-Restart 3 'the application is no longer running' -Failed
}
$appPath = ''
try { $appPath = [string]$appProcess.Path } catch { }
if ([string]::IsNullOrWhiteSpace($appPath)) {
  Complete-Restart 4 'the application process path cannot be read' -Failed
}
$expected = [System.IO.Path]::GetFullPath($AppExe)
$actual = [System.IO.Path]::GetFullPath($appPath)
if (-not [string]::Equals($expected, $actual, [System.StringComparison]::OrdinalIgnoreCase)) {
  Complete-Restart 5 ('the identified process is not the application; expected "{0}", found "{1}"' -f $expected, $actual) -Failed
}

$relaunchArgs = ''
try {
  $info = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $AppPid) -ErrorAction Stop
  $commandLine = [string]$info.CommandLine
  if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
    $index = $commandLine.IndexOf($AppExe, [System.StringComparison]::OrdinalIgnoreCase)
    if ($index -ge 0) {
      $relaunchArgs = $commandLine.Substring($index + $AppExe.Length).Trim()
      if ($relaunchArgs.StartsWith('"')) { $relaunchArgs = $relaunchArgs.Substring(1).Trim() }
    }
  }
} catch {
  Write-Log ('command line read failed: ' + $_.Exception.Message)
}
Write-Log ('relaunch arguments: "{0}"' -f $relaunchArgs)

if ($DryRun) {
  Write-Log 'dry run: validation succeeded; nothing was changed'
  exit 0
}

Start-Sleep -Milliseconds $DelayMs

# P/Invoke for the session-end request and the window close.
$native = $false
try {
  if (-not ('DshQuickRestart.Win32' -as [type])) {
    Add-Type -Namespace DshQuickRestart -Name Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern System.IntPtr SendMessageW(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool PostMessageW(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);
'@
  }
  $native = $true
} catch {
  Write-Log ('window control unavailable: ' + $_.Exception.Message)
}

$windowHandle = [System.IntPtr]::Zero
try {
  $current = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  if ($null -ne $current) { $windowHandle = [System.IntPtr]$current.MainWindowHandle }
} catch { }

if ($native -and $windowHandle -ne [System.IntPtr]::Zero) {
  # The session-end request marks this as a real quit, so the shell does not
  # convert the following close into a tray hide.
  [void][DshQuickRestart.Win32]::SendMessageW($windowHandle, 0x0011, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
  Write-Log 'sent WM_QUERYENDSESSION'
  Start-Sleep -Milliseconds 250
  [void][DshQuickRestart.Win32]::PostMessageW($windowHandle, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
  Write-Log 'sent WM_CLOSE'
} else {
  Write-Log 'no usable main window; skipping the graceful quit request'
}

# The request gives no answer, so leave the shell time to finish its own quit.
$deadline = (Get-Date).AddMilliseconds($GracefulMs)
while ((Get-Date) -lt $deadline) {
  if (-not (Test-AppProcess)) { break }
  Start-Sleep -Milliseconds 250
}

if (Test-AppProcess) {
  Write-Log 'application still running; terminating it'
  try {
    Stop-Process -Id $AppPid -Force -ErrorAction Stop
  } catch {
    Write-Log ('terminate failed: ' + $_.Exception.Message)
  }
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (-not (Test-AppProcess)) { break }
  Start-Sleep -Milliseconds 250
}
if (Test-AppProcess) {
  Complete-Restart 6 'the application did not exit, so it was not relaunched' -Failed
}
Write-Log 'application exited'

if ($HostPid -gt 0) {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($null -ne (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) {
    Write-Log 'host process is still running; terminating it before relaunch'
    try { Stop-Process -Id $HostPid -Force -ErrorAction Stop } catch { Write-Log ('host terminate failed: ' + $_.Exception.Message) }
    Start-Sleep -Milliseconds 500
  } else {
    Write-Log 'host process exited'
  }
}

Start-Sleep -Milliseconds 1000

$workingDirectory = Split-Path -Parent $expected
$started = $null
try {
  if ([string]::IsNullOrWhiteSpace($relaunchArgs)) {
    $started = Start-Process -FilePath $expected -WorkingDirectory $workingDirectory -PassThru -ErrorAction Stop
  } else {
    $started = Start-Process -FilePath $expected -ArgumentList $relaunchArgs -WorkingDirectory $workingDirectory -PassThru -ErrorAction Stop
  }
} catch {
  Complete-Restart 7 ('the application could not be started again: {0}' -f $_.Exception.Message) -Failed
}
Write-Log ('relaunch started; pid={0}' -f $started.Id)
Start-Sleep -Milliseconds 3000
if (-not $started.HasExited) {
  Complete-Restart 0 'the application was restarted'
}
Complete-Restart 8 'the new instance exited right after it started; use the system tray or the Start menu to open the app again' -Failed
