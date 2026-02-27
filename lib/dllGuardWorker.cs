// dllGuardWorker.cs — Compiled anti-cheat worker (replaces dllGuard.ps1)
// Communicates via NDJSON on stdin/stdout.
// Commands: getModules, scanOverlays, scanBlacklist, exit
//
// Compile with .NET Framework 4.8 csc.exe (present on all Windows 10/11):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /out:lib\dllGuardWorker.exe lib\dllGuardWorker.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class DllGuardWorker
{
    // ── P/Invoke ──

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    static extern int GetWindowTextLength(IntPtr hWnd);

    const int GWL_EXSTYLE    = -20;
    const int WS_EX_LAYERED  = 0x00080000;
    const int WS_EX_TOPMOST  = 0x00000008;

    // ── Overlay whitelist (lowercase, no .exe) ──
    static readonly HashSet<string> OverlayWhitelist = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "discord","discordcanary","discordptb",
        "steam","steamwebhelper","gameoverlayui",
        "nvidia share","nvspcaps64","nvcontainer",
        "gamebar","gamebarpresencewriter","applicationframehost",
        "msedgewebview2",
        "obs64","obs32","obs",
        "rivatunerstatisticsserver","rtss","msiafterburner",
        "explorer"
    };

    // ── Blacklist (lowercase, no .exe) ──
    static readonly string[] BlacklistNames = {
        "cheatengine","cheat engine","cheatengine-x86_64","cheatengine-i386",
        "processhacker","systeminformer",
        "x64dbg","x32dbg","ollydbg",
        "ida","ida64","idaq","idaq64",
        "dnspy","de4dot",
        "httpanalyzer","fiddler","charles"
    };

    // ── JSON helpers (no external deps) ──

    static string JsonEscape(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n");  break;
                case '\r': sb.Append("\\r");  break;
                case '\t': sb.Append("\\t");  break;
                default:
                    if (c < 0x20)
                        sb.AppendFormat("\\u{0:x4}", (int)c);
                    else
                        sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    static void WriteResponse(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    static void WriteResult(string id, string resultBody)
    {
        WriteResponse("{\"id\":" + id + ",\"result\":{" + resultBody + "}}");
    }

    static void WriteError(string id, string message)
    {
        WriteResponse("{\"id\":" + id + ",\"error\":\"" + JsonEscape(message) + "\"}");
    }

    // ── Minimal JSON field extraction ──
    // Handles: {"id":123,"cmd":"xxx","params":{"pid":456}}

    static string ExtractString(string json, string key)
    {
        string pattern = "\"" + key + "\"";
        int idx = json.IndexOf(pattern, StringComparison.Ordinal);
        if (idx < 0) return null;
        idx += pattern.Length;

        // skip whitespace and colon
        while (idx < json.Length && (json[idx] == ' ' || json[idx] == ':')) idx++;
        if (idx >= json.Length) return null;

        if (json[idx] == '"')
        {
            idx++; // skip opening quote
            var sb = new StringBuilder();
            while (idx < json.Length && json[idx] != '"')
            {
                if (json[idx] == '\\' && idx + 1 < json.Length)
                {
                    idx++;
                    sb.Append(json[idx]);
                }
                else
                {
                    sb.Append(json[idx]);
                }
                idx++;
            }
            return sb.ToString();
        }
        else
        {
            // number or literal
            var sb = new StringBuilder();
            while (idx < json.Length && json[idx] != ',' && json[idx] != '}' && json[idx] != ' ')
            {
                sb.Append(json[idx]);
                idx++;
            }
            return sb.ToString();
        }
    }

    // ── Commands ──

    static string HandleGetModules(string json)
    {
        string pidStr = ExtractString(json, "pid");
        if (pidStr == null) return null;

        int pid;
        if (!int.TryParse(pidStr, out pid)) return null;

        Process proc = Process.GetProcessById(pid);
        var modules = new List<string>();
        try
        {
            foreach (ProcessModule m in proc.Modules)
            {
                if (m.FileName != null)
                    modules.Add(m.FileName);
            }
        }
        catch
        {
            // access denied on some modules is normal
        }

        var sb = new StringBuilder();
        sb.Append("\"modules\":[");
        for (int i = 0; i < modules.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"');
            sb.Append(JsonEscape(modules[i]));
            sb.Append('"');
        }
        sb.Append(']');
        return sb.ToString();
    }

    struct OverlayInfo
    {
        public uint Pid;
        public string Title;
    }

    static List<OverlayInfo> FindOverlays()
    {
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
            if (len > 0)
            {
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                title = sb.ToString();
            }

            results.Add(new OverlayInfo { Pid = pid, Title = title });
            return true;
        }, IntPtr.Zero);
        return results;
    }

    static string HandleScanOverlays()
    {
        var overlays = FindOverlays();
        var suspects = new List<string>(); // pre-formatted JSON objects

        foreach (var ov in overlays)
        {
            try
            {
                Process proc = Process.GetProcessById((int)ov.Pid);
                string pname = proc.ProcessName.ToLower();
                if (!OverlayWhitelist.Contains(pname))
                {
                    suspects.Add("{\"process\":\"" + JsonEscape(pname) +
                                 "\",\"title\":\"" + JsonEscape(ov.Title) +
                                 "\",\"pid\":" + ov.Pid + "}");
                }
            }
            catch
            {
                // process may have exited
            }
        }

        var sb = new StringBuilder();
        sb.Append("\"overlays\":[");
        for (int i = 0; i < suspects.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(suspects[i]);
        }
        sb.Append(']');
        return sb.ToString();
    }

    static string HandleScanBlacklist()
    {
        var found = new List<string>();
        Process[] allProcs;
        try
        {
            allProcs = Process.GetProcesses();
        }
        catch
        {
            return "\"blacklisted\":[]";
        }

        foreach (var p in allProcs)
        {
            try
            {
                string pname = p.ProcessName.ToLower();
                foreach (string bl in BlacklistNames)
                {
                    if (pname.Contains(bl))
                    {
                        if (!found.Contains(pname))
                            found.Add(pname);
                        break;
                    }
                }
            }
            catch
            {
                // access denied
            }
        }

        var sb = new StringBuilder();
        sb.Append("\"blacklisted\":[");
        for (int i = 0; i < found.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"');
            sb.Append(JsonEscape(found[i]));
            sb.Append('"');
        }
        sb.Append(']');
        return sb.ToString();
    }

    // ── Main ──

    static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding  = Encoding.UTF8;

        // Signal ready
        WriteResponse("{\"status\":\"ready\"}");

        // Main loop: read NDJSON commands from stdin
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;

            string id  = ExtractString(line, "id");
            string cmd = ExtractString(line, "cmd");

            if (id == null) id = "0";

            try
            {
                switch (cmd)
                {
                    case "getModules":
                    {
                        string result = HandleGetModules(line);
                        if (result != null)
                            WriteResult(id, result);
                        else
                            WriteError(id, "missing or invalid pid parameter");
                        break;
                    }

                    case "scanOverlays":
                    {
                        string result = HandleScanOverlays();
                        WriteResult(id, result);
                        break;
                    }

                    case "scanBlacklist":
                    {
                        string result = HandleScanBlacklist();
                        WriteResult(id, result);
                        break;
                    }

                    case "exit":
                    {
                        WriteResult(id, "\"ok\":true");
                        return;
                    }

                    default:
                    {
                        WriteError(id, "unknown command: " + (cmd ?? "(null)"));
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                WriteError(id, ex.Message);
            }
        }
    }
}
