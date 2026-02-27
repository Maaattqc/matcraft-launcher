# dllGuard.ps1 — Persistent PowerShell worker for anti-cheat scanning
# Communicates via NDJSON (one JSON object per line) on stdin/stdout.
# Commands: getModules, scanOverlays, scanBlacklist, exit

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

# ── Compile P/Invoke helpers once at startup ──
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public class WinApi {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED  = 0x00080000;
    public const int WS_EX_TOPMOST  = 0x00000008;

    public static List<OverlayInfo> FindOverlays() {
        var results = new List<OverlayInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;

            int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_LAYERED) == 0 || (exStyle & WS_EX_TOPMOST) == 0)
                return true;

            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);

            int len = GetWindowTextLength(hWnd);
            string title = "";
            if (len > 0) {
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                title = sb.ToString();
            }

            results.Add(new OverlayInfo { Pid = pid, Title = title });
            return true;
        }, IntPtr.Zero);
        return results;
    }

    public class OverlayInfo {
        public uint Pid;
        public string Title;
    }
}
"@ -Language CSharp

# Signal ready
[Console]::Out.WriteLine('{"status":"ready"}')
[Console]::Out.Flush()

# ── Overlay whitelist (lowercase process names without .exe) ──
$overlayWhitelist = @(
    'discord','discordcanary','discordptb',
    'steam','steamwebhelper','gameoverlayui',
    'nvidia share','nvspcaps64','nvcontainer',
    'gamebar','gamebarpresencewriter','applicationframehost',
    'msedgewebview2',
    'obs64','obs32','obs',
    'rivatunerstatisticsserver','rtss','msiafterburner',
    'explorer'
)

# ── Blacklist (lowercase process names without .exe) ──
$blacklistNames = @(
    'cheatengine','cheatengine-x86_64',
    'processhacker','systeminformer',
    'x64dbg','x32dbg','ollydbg',
    'ida','ida64','idaq','idaq64',
    'dnspy','de4dot',
    'httpanalyzer','fiddler','charles'
)

# ── Main loop: read NDJSON commands from stdin ──
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }  # stdin closed
    $line = $line.Trim()
    if ($line -eq '') { continue }

    try {
        $req = $line | ConvertFrom-Json
    } catch {
        # Malformed JSON — skip
        continue
    }

    $id  = $req.id
    $cmd = $req.cmd

    try {
        switch ($cmd) {
            'getModules' {
                $pid = [int]$req.params.pid
                $proc = Get-Process -Id $pid -ErrorAction Stop
                $modules = @()
                foreach ($m in $proc.Modules) {
                    if ($m.FileName) { $modules += $m.FileName }
                }
                $resp = @{ id = $id; result = @{ modules = $modules } }
                [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
                [Console]::Out.Flush()
            }

            'scanOverlays' {
                $overlays = [WinApi]::FindOverlays()
                $suspects = @()
                foreach ($ov in $overlays) {
                    try {
                        $proc = Get-Process -Id $ov.Pid -ErrorAction SilentlyContinue
                        if ($null -eq $proc) { continue }
                        $pname = $proc.ProcessName.ToLower()
                        if ($overlayWhitelist -notcontains $pname) {
                            $suspects += @{
                                process = $pname
                                title   = $ov.Title
                                pid     = [int]$ov.Pid
                            }
                        }
                    } catch {
                        continue
                    }
                }
                $resp = @{ id = $id; result = @{ overlays = $suspects } }
                [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
                [Console]::Out.Flush()
            }

            'scanBlacklist' {
                $found = @()
                $allProcs = Get-Process -ErrorAction SilentlyContinue
                foreach ($p in $allProcs) {
                    $pname = $p.ProcessName.ToLower()
                    if ($blacklistNames -contains $pname) {
                        if ($found -notcontains $pname) {
                            $found += $pname
                        }
                    }
                }
                $resp = @{ id = $id; result = @{ blacklisted = $found } }
                [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
                [Console]::Out.Flush()
            }

            'exit' {
                $resp = @{ id = $id; result = @{ ok = $true } }
                [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
                [Console]::Out.Flush()
                exit 0
            }

            default {
                $resp = @{ id = $id; error = "unknown command: $cmd" }
                [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
                [Console]::Out.Flush()
            }
        }
    } catch {
        $resp = @{ id = $id; error = $_.Exception.Message }
        [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
        [Console]::Out.Flush()
    }
}
