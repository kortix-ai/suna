import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HELPER_VERSION = 'v1';
const BIN_DIR = join(homedir(), '.agent-tunnel', 'bin');
const HELPER_PATH = join(BIN_DIR, `desktop-helper-win-${HELPER_VERSION}.exe`);

const CSHARP_SOURCE = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

class Helper
{
    // ─── P/Invoke ────────────────────────────────────────────────
    [DllImport("user32.dll")] static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const int SW_MINIMIZE = 6;
    const uint WM_CLOSE = 0x0010;
    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public INPUTUNION u; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    // ─── JSON helpers (minimal, no dependencies) ─────────────────
    static string JsonStr(string s) => "\\"" + s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\n", "\\\\n").Replace("\\r", "\\\\r").Replace("\\t", "\\\\t") + "\\"";

    static Dictionary<string, object> ParseJson(string json)
    {
        var d = new Dictionary<string, object>();
        json = json.Trim();
        if (json.StartsWith("{")) json = json.Substring(1, json.Length - 2).Trim();

        int i = 0;
        while (i < json.Length)
        {
            while (i < json.Length && (json[i] == ',' || json[i] == ' ' || json[i] == '\\n' || json[i] == '\\r' || json[i] == '\\t')) i++;
            if (i >= json.Length) break;

            var key = ParseJsonString(json, ref i);
            while (i < json.Length && (json[i] == ' ' || json[i] == ':')) i++;
            var val = ParseJsonValue(json, ref i);
            d[key] = val;
        }
        return d;
    }

    static string ParseJsonString(string json, ref int i)
    {
        if (json[i] != '\\"') throw new Exception("Expected string at " + i);
        i++;
        var sb = new StringBuilder();
        while (i < json.Length && json[i] != '\\"')
        {
            if (json[i] == '\\\\') { i++; sb.Append(json[i]); }
            else sb.Append(json[i]);
            i++;
        }
        i++; // skip closing quote
        return sb.ToString();
    }

    static object ParseJsonValue(string json, ref int i)
    {
        while (i < json.Length && json[i] == ' ') i++;
        if (i >= json.Length) return null;

        if (json[i] == '\\"') return ParseJsonString(json, ref i);
        if (json[i] == '[')
        {
            i++;
            var list = new List<object>();
            while (i < json.Length && json[i] != ']')
            {
                while (i < json.Length && (json[i] == ',' || json[i] == ' ' || json[i] == '\\n' || json[i] == '\\r' || json[i] == '\\t')) i++;
                if (i < json.Length && json[i] != ']')
                    list.Add(ParseJsonValue(json, ref i));
            }
            if (i < json.Length) i++;
            return list;
        }
        if (json[i] == '{')
        {
            var start = i;
            int depth = 1; i++;
            while (i < json.Length && depth > 0) { if (json[i] == '{') depth++; if (json[i] == '}') depth--; i++; }
            return json.Substring(start, i - start);
        }
        if (json[i] == 'n' && json.Substring(i, 4) == "null") { i += 4; return null; }
        if (json[i] == 't' && json.Substring(i, 4) == "true") { i += 4; return true; }
        if (json[i] == 'f' && json.Substring(i, 5) == "false") { i += 5; return false; }

        // number
        var numStart = i;
        while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '.' || json[i] == '-' || json[i] == 'e' || json[i] == 'E' || json[i] == '+')) i++;
        var numStr = json.Substring(numStart, i - numStart);
        if (numStr.Contains(".")) return double.Parse(numStr, System.Globalization.CultureInfo.InvariantCulture);
        return int.Parse(numStr);
    }

    static int GetInt(Dictionary<string, object> d, string k, int def = 0) { return d.ContainsKey(k) && d[k] != null ? Convert.ToInt32(d[k]) : def; }
    static double GetDbl(Dictionary<string, object> d, string k, double def = 0) { return d.ContainsKey(k) && d[k] != null ? Convert.ToDouble(d[k]) : def; }
    static string GetStr(Dictionary<string, object> d, string k, string def = "") { return d.ContainsKey(k) && d[k] is string ? (string)d[k] : def; }
    static List<object> GetList(Dictionary<string, object> d, string k) { return d.ContainsKey(k) && d[k] is List<object> ? (List<object>)d[k] : new List<object>(); }

    // ─── Virtual key codes ───────────────────────────────────────
    static Dictionary<string, ushort> VKMap = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
        {"return", 0x0D}, {"enter", 0x0D}, {"tab", 0x09}, {"space", 0x20},
        {"backspace", 0x08}, {"delete", 0x2E}, {"escape", 0x1B}, {"esc", 0x1B},
        {"up", 0x26}, {"down", 0x28}, {"left", 0x25}, {"right", 0x27},
        {"home", 0x24}, {"end", 0x23}, {"pageup", 0x21}, {"pagedown", 0x22},
        {"f1", 0x70}, {"f2", 0x71}, {"f3", 0x72}, {"f4", 0x73},
        {"f5", 0x74}, {"f6", 0x75}, {"f7", 0x76}, {"f8", 0x77},
        {"f9", 0x78}, {"f10", 0x79}, {"f11", 0x7A}, {"f12", 0x7B},
        {"shift", 0x10}, {"ctrl", 0x11}, {"control", 0x11},
        {"alt", 0x12}, {"option", 0x12}, {"cmd", 0x5B}, {"command", 0x5B},
        {"a", 0x41}, {"b", 0x42}, {"c", 0x43}, {"d", 0x44}, {"e", 0x45}, {"f", 0x46},
        {"g", 0x47}, {"h", 0x48}, {"i", 0x49}, {"j", 0x4A}, {"k", 0x4B}, {"l", 0x4C},
        {"m", 0x4D}, {"n", 0x4E}, {"o", 0x4F}, {"p", 0x50}, {"q", 0x51}, {"r", 0x52},
        {"s", 0x53}, {"t", 0x54}, {"u", 0x55}, {"v", 0x56}, {"w", 0x57}, {"x", 0x58},
        {"y", 0x59}, {"z", 0x5A},
        {"0", 0x30}, {"1", 0x31}, {"2", 0x32}, {"3", 0x33}, {"4", 0x34},
        {"5", 0x35}, {"6", 0x36}, {"7", 0x37}, {"8", 0x38}, {"9", 0x39},
    };

    static ushort GetVK(string key)
    {
        ushort vk;
        if (VKMap.TryGetValue(key, out vk)) return vk;
        if (key.Length == 1) return (ushort)char.ToUpper(key[0]);
        return 0;
    }

    static bool IsModifier(string key)
    {
        var k = key.ToLower();
        return k == "shift" || k == "ctrl" || k == "control" || k == "alt" || k == "option" || k == "cmd" || k == "command";
    }

    // ─── Mouse helpers ───────────────────────────────────────────
    static void SendMouseClick(int x, int y, string button, int clicks)
    {
        SetCursorPos(x, y);
        Thread.Sleep(10);

        uint downFlag, upFlag;
        switch (button)
        {
            case "right": downFlag = MOUSEEVENTF_RIGHTDOWN; upFlag = MOUSEEVENTF_RIGHTUP; break;
            case "middle": downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; break;
            default: downFlag = MOUSEEVENTF_LEFTDOWN; upFlag = MOUSEEVENTF_LEFTUP; break;
        }

        for (int c = 0; c < clicks; c++)
        {
            var inputs = new INPUT[]
            {
                new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = downFlag } } },
                new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = upFlag } } },
            };
            SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (c < clicks - 1) Thread.Sleep(50);
        }
    }

    // ─── AX helpers ──────────────────────────────────────────────
    static int axElementCount;

    static string WalkAXTree(AutomationElement el, int depth, int maxDepth, List<string> roles, string pathPrefix)
    {
        if (el == null || depth > maxDepth) return "null";
        axElementCount++;

        string role = "";
        string name = "";
        string val = "";
        string desc = "";
        var bounds = System.Windows.Rect.Empty;
        bool enabled = true;
        bool focused = false;
        var actionList = new List<string>();

        try { role = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch {}
        try { name = el.Current.Name ?? ""; } catch {}
        try { val = el.Current.AutomationId ?? ""; } catch {}
        try { desc = el.Current.HelpText ?? ""; } catch {}
        try { bounds = el.Current.BoundingRectangle; } catch {}
        try { enabled = el.Current.IsEnabled; } catch {}
        try { focused = el.Current.HasKeyboardFocus; } catch {}

        // Check supported patterns for actions
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) actionList.Add("invoke"); } catch {}
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)) actionList.Add("toggle"); } catch {}
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty)) actionList.Add("expandcollapse"); } catch {}
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty)) actionList.Add("setvalue"); } catch {}

        if (roles != null && roles.Count > 0 && !roles.Contains(role.ToLower()))
        {
            // Skip this element but still walk children
            var sb2 = new StringBuilder();
            bool first2 = true;
            int childIdx = 0;
            try
            {
                var walker = TreeWalker.ControlViewWalker;
                var child = walker.GetFirstChild(el);
                while (child != null)
                {
                    var childPath = pathPrefix.Length > 0 ? pathPrefix + "." + childIdx : childIdx.ToString();
                    var childJson = WalkAXTree(child, depth, maxDepth, roles, childPath);
                    if (childJson != "null")
                    {
                        if (!first2) sb2.Append(",");
                        sb2.Append(childJson);
                        first2 = false;
                    }
                    child = walker.GetNextSibling(child);
                    childIdx++;
                }
            } catch {}
            if (sb2.Length == 0) return "null";
            return sb2.ToString();
        }

        var sb = new StringBuilder();
        sb.Append("{");
        sb.AppendFormat("\\"id\\":{0}", JsonStr(pathPrefix));
        sb.AppendFormat(",\\"role\\":{0}", JsonStr(role));
        sb.AppendFormat(",\\"title\\":{0}", JsonStr(name));
        sb.AppendFormat(",\\"value\\":{0}", JsonStr(val));
        sb.AppendFormat(",\\"description\\":{0}", JsonStr(desc));
        sb.AppendFormat(",\\"bounds\\":{{\\"x\\":{0},\\"y\\":{1},\\"width\\":{2},\\"height\\":{3}}}",
            bounds.IsEmpty ? 0 : (int)bounds.X,
            bounds.IsEmpty ? 0 : (int)bounds.Y,
            bounds.IsEmpty ? 0 : (int)bounds.Width,
            bounds.IsEmpty ? 0 : (int)bounds.Height);
        sb.AppendFormat(",\\"enabled\\":{0}", enabled ? "true" : "false");
        sb.AppendFormat(",\\"focused\\":{0}", focused ? "true" : "false");
        sb.Append(",\\"actions\\":[");
        for (int a = 0; a < actionList.Count; a++) { if (a > 0) sb.Append(","); sb.Append(JsonStr(actionList[a])); }
        sb.Append("]");

        // Children
        sb.Append(",\\"children\\":[");
        if (depth < maxDepth)
        {
            bool first = true;
            int childIdx = 0;
            try
            {
                var walker = TreeWalker.ControlViewWalker;
                var child = walker.GetFirstChild(el);
                while (child != null)
                {
                    var childPath = pathPrefix.Length > 0 ? pathPrefix + "." + childIdx : childIdx.ToString();
                    var childJson = WalkAXTree(child, depth + 1, maxDepth, roles, childPath);
                    if (childJson != "null")
                    {
                        if (!first) sb.Append(",");
                        sb.Append(childJson);
                        first = false;
                    }
                    child = walker.GetNextSibling(child);
                    childIdx++;
                }
            } catch {}
        }
        sb.Append("]");
        sb.Append("}");
        return sb.ToString();
    }

    static AutomationElement NavigateToElement(AutomationElement root, string elementId)
    {
        var parts = elementId.Split('.');
        var current = root;

        foreach (var part in parts)
        {
            int idx = int.Parse(part);
            var walker = TreeWalker.ControlViewWalker;
            var child = walker.GetFirstChild(current);
            for (int i = 0; i < idx && child != null; i++)
                child = walker.GetNextSibling(child);
            if (child == null) throw new Exception("Element not found at path: " + elementId);
            current = child;
        }
        return current;
    }

    static void SearchAXTree(AutomationElement el, string query, string roleFilter, int maxResults, List<string> results, string pathPrefix, int depth, int maxDepth)
    {
        if (el == null || results.Count >= maxResults || depth > maxDepth) return;

        string role = "";
        string name = "";
        string val = "";
        string desc = "";
        var bounds = System.Windows.Rect.Empty;
        bool enabled = true;
        bool focused = false;
        var actionList = new List<string>();

        try { role = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch {}
        try { name = el.Current.Name ?? ""; } catch {}
        try { val = el.Current.AutomationId ?? ""; } catch {}
        try { desc = el.Current.HelpText ?? ""; } catch {}
        try { bounds = el.Current.BoundingRectangle; } catch {}
        try { enabled = el.Current.IsEnabled; } catch {}
        try { focused = el.Current.HasKeyboardFocus; } catch {}

        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) actionList.Add("invoke"); } catch {}
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)) actionList.Add("toggle"); } catch {}
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty)) actionList.Add("expandcollapse"); } catch {}
        try { if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty)) actionList.Add("setvalue"); } catch {}

        var queryLower = query.ToLower();
        bool match = name.ToLower().Contains(queryLower) || val.ToLower().Contains(queryLower) || desc.ToLower().Contains(queryLower);

        if (roleFilter != null && roleFilter.Length > 0 && role.ToLower() != roleFilter.ToLower())
            match = false;

        if (match)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\\"id\\":{0}", JsonStr(pathPrefix));
            sb.AppendFormat(",\\"role\\":{0}", JsonStr(role));
            sb.AppendFormat(",\\"title\\":{0}", JsonStr(name));
            sb.AppendFormat(",\\"value\\":{0}", JsonStr(val));
            sb.AppendFormat(",\\"description\\":{0}", JsonStr(desc));
            sb.AppendFormat(",\\"bounds\\":{{\\"x\\":{0},\\"y\\":{1},\\"width\\":{2},\\"height\\":{3}}}",
                bounds.IsEmpty ? 0 : (int)bounds.X, bounds.IsEmpty ? 0 : (int)bounds.Y,
                bounds.IsEmpty ? 0 : (int)bounds.Width, bounds.IsEmpty ? 0 : (int)bounds.Height);
            sb.AppendFormat(",\\"enabled\\":{0}", enabled ? "true" : "false");
            sb.AppendFormat(",\\"focused\\":{0}", focused ? "true" : "false");
            sb.Append(",\\"actions\\":[");
            for (int a = 0; a < actionList.Count; a++) { if (a > 0) sb.Append(","); sb.Append(JsonStr(actionList[a])); }
            sb.Append("],\\"children\\":[]}");
            results.Add(sb.ToString());
        }

        int childIdx = 0;
        try
        {
            var walker = TreeWalker.ControlViewWalker;
            var child = walker.GetFirstChild(el);
            while (child != null && results.Count < maxResults)
            {
                var childPath = pathPrefix.Length > 0 ? pathPrefix + "." + childIdx : childIdx.ToString();
                SearchAXTree(child, query, roleFilter, maxResults, results, childPath, depth + 1, maxDepth);
                child = walker.GetNextSibling(child);
                childIdx++;
            }
        } catch {}
    }

    static AutomationElement FindAppRoot(int pid)
    {
        if (pid <= 0) return AutomationElement.RootElement;

        var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
        var el = AutomationElement.RootElement.FindFirst(TreeScope.Children, cond);
        if (el == null) throw new Exception("No UI Automation element found for PID " + pid);
        return el;
    }

    // ─── Main ────────────────────────────────────────────────────
    [STAThread]
    static void Main()
    {
        var input = Console.In.ReadToEnd().Trim();
        Dictionary<string, object> req;
        try { req = ParseJson(input); }
        catch (Exception ex) { Console.WriteLine("{\\"ok\\":false,\\"error\\":" + JsonStr("Invalid JSON: " + ex.Message) + "}"); return; }

        var action = GetStr(req, "action");

        try
        {
            switch (action)
            {
                case "click":
                {
                    var x = (int)GetDbl(req, "x");
                    var y = (int)GetDbl(req, "y");
                    var button = GetStr(req, "button", "left");
                    var clicks = GetInt(req, "clicks", 1);
                    SendMouseClick(x, y, button, clicks);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "move":
                {
                    SetCursorPos((int)GetDbl(req, "x"), (int)GetDbl(req, "y"));
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "drag":
                {
                    int fx = (int)GetDbl(req, "x"), fy = (int)GetDbl(req, "y");
                    int tx = (int)GetDbl(req, "toX"), ty = (int)GetDbl(req, "toY");
                    SetCursorPos(fx, fy);
                    Thread.Sleep(50);
                    var down = new INPUT[] { new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_LEFTDOWN } } } };
                    SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));

                    for (int i = 1; i <= 10; i++)
                    {
                        double t = i / 10.0;
                        int mx = fx + (int)((tx - fx) * t);
                        int my = fy + (int)((ty - fy) * t);
                        SetCursorPos(mx, my);
                        Thread.Sleep(10);
                    }

                    var up = new INPUT[] { new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_LEFTUP } } } };
                    SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "scroll":
                {
                    SetCursorPos((int)GetDbl(req, "x"), (int)GetDbl(req, "y"));
                    Thread.Sleep(10);
                    int dy = GetInt(req, "deltaY");
                    int dx = GetInt(req, "deltaX");
                    if (dy != 0)
                    {
                        var inputs = new INPUT[] { new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { mouseData = (uint)(dy * 120), dwFlags = MOUSEEVENTF_WHEEL } } } };
                        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
                    }
                    if (dx != 0)
                    {
                        var inputs = new INPUT[] { new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { mouseData = (uint)(dx * 120), dwFlags = MOUSEEVENTF_HWHEEL } } } };
                        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
                    }
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "position":
                {
                    POINT p;
                    GetCursorPos(out p);
                    Console.WriteLine("{\\"ok\\":true,\\"x\\":" + p.X + ",\\"y\\":" + p.Y + "}");
                    break;
                }
                case "key":
                {
                    var keys = GetList(req, "keys");
                    var mods = new List<ushort>();
                    var mainKeys = new List<ushort>();

                    foreach (var k in keys)
                    {
                        var keyStr = k.ToString();
                        var vk = GetVK(keyStr);
                        if (vk == 0) { Console.WriteLine("{\\"ok\\":false,\\"error\\":" + JsonStr("Unknown key: " + keyStr) + "}"); return; }
                        if (IsModifier(keyStr)) mods.Add(vk); else mainKeys.Add(vk);
                    }

                    var inputList = new List<INPUT>();
                    foreach (var m in mods) inputList.Add(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = m } } });
                    foreach (var k in mainKeys) inputList.Add(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = k } } });
                    foreach (var k in mainKeys) inputList.Add(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = k, dwFlags = KEYEVENTF_KEYUP } } });
                    foreach (var m in mods) inputList.Add(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = m, dwFlags = KEYEVENTF_KEYUP } } });

                    SendInput((uint)inputList.Count, inputList.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "type":
                {
                    var text = GetStr(req, "text");
                    var inputList = new List<INPUT>();
                    foreach (char c in text)
                    {
                        inputList.Add(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE } } });
                        inputList.Add(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } });
                    }
                    SendInput((uint)inputList.Count, inputList.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "screenshot":
                {
                    var bounds = Screen.PrimaryScreen.Bounds;
                    using (var bmp = new Bitmap(bounds.Width, bounds.Height))
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);

                        // Downscale if > 1920
                        Bitmap output = bmp;
                        bool scaled = false;
                        if (bmp.Width > 1920 || bmp.Height > 1920)
                        {
                            double scale = Math.Min(1920.0 / bmp.Width, 1920.0 / bmp.Height);
                            int nw = (int)(bmp.Width * scale);
                            int nh = (int)(bmp.Height * scale);
                            output = new Bitmap(nw, nh);
                            using (var g2 = Graphics.FromImage(output))
                            {
                                g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                                g2.DrawImage(bmp, 0, 0, nw, nh);
                            }
                            scaled = true;
                        }

                        using (var ms = new MemoryStream())
                        {
                            var jpegEncoder = ImageCodecInfo.GetImageEncoders().First(e => e.FormatID == ImageFormat.Jpeg.Guid);
                            var encoderParams = new EncoderParameters(1);
                            encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 60L);
                            output.Save(ms, jpegEncoder, encoderParams);

                            var b64 = Convert.ToBase64String(ms.ToArray());
                            Console.WriteLine("{\\"ok\\":true,\\"image\\":" + JsonStr(b64) + ",\\"width\\":" + output.Width + ",\\"height\\":" + output.Height + ",\\"format\\":\\"jpeg\\"}");
                        }
                        if (scaled) output.Dispose();
                    }
                    break;
                }
                case "window_list":
                {
                    var windows = new List<string>();
                    EnumWindows((hWnd, _) =>
                    {
                        if (!IsWindowVisible(hWnd)) return true;
                        int len = GetWindowTextLength(hWnd);
                        if (len == 0) return true;
                        var sb = new StringBuilder(len + 1);
                        GetWindowText(hWnd, sb, sb.Capacity);
                        var title = sb.ToString();

                        RECT r;
                        GetWindowRect(hWnd, out r);

                        uint pid;
                        GetWindowThreadProcessId(hWnd, out pid);
                        string appName = "";
                        try { appName = Process.GetProcessById((int)pid).ProcessName; } catch {}

                        windows.Add(String.Format("{{\\"id\\":{0},\\"app\\":{1},\\"title\\":{2},\\"bounds\\":{{\\"x\\":{3},\\"y\\":{4},\\"width\\":{5},\\"height\\":{6}}},\\"minimized\\":false}}",
                            hWnd.ToInt64(), JsonStr(appName), JsonStr(title),
                            r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top));
                        return true;
                    }, IntPtr.Zero);

                    Console.WriteLine("{\\"ok\\":true,\\"windows\\":[" + string.Join(",", windows) + "]}");
                    break;
                }
                case "window_focus":
                {
                    var wid = (IntPtr)(long)GetDbl(req, "windowId");
                    SetForegroundWindow(wid);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "window_resize":
                {
                    var wid = (IntPtr)(long)GetDbl(req, "windowId");
                    int x = (int)GetDbl(req, "x"), y = (int)GetDbl(req, "y");
                    int w = (int)GetDbl(req, "width"), h = (int)GetDbl(req, "height");
                    MoveWindow(wid, x, y, w, h, true);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "window_close":
                {
                    var wid = (IntPtr)(long)GetDbl(req, "windowId");
                    SendMessage(wid, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "window_minimize":
                {
                    var wid = (IntPtr)(long)GetDbl(req, "windowId");
                    ShowWindow(wid, SW_MINIMIZE);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "app_launch":
                {
                    var app = GetStr(req, "name");
                    Process.Start(app);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "app_quit":
                {
                    var app = GetStr(req, "name").ToLower();
                    foreach (var p in Process.GetProcesses())
                    {
                        try { if (p.ProcessName.ToLower() == app) p.Kill(); } catch {}
                    }
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "app_list":
                {
                    var apps = new List<string>();
                    var seen = new HashSet<int>();
                    foreach (var p in Process.GetProcesses())
                    {
                        try
                        {
                            if (p.MainWindowHandle != IntPtr.Zero && !seen.Contains(p.Id))
                            {
                                seen.Add(p.Id);
                                apps.Add(String.Format("{{\\"name\\":{0},\\"pid\\":{1}}}", JsonStr(p.ProcessName), p.Id));
                            }
                        } catch {}
                    }
                    Console.WriteLine("{\\"ok\\":true,\\"apps\\":[" + string.Join(",", apps) + "]}");
                    break;
                }
                case "clipboard_read":
                {
                    string text = Clipboard.GetText() ?? "";
                    Console.WriteLine("{\\"ok\\":true,\\"text\\":" + JsonStr(text) + "}");
                    break;
                }
                case "clipboard_write":
                {
                    var text = GetStr(req, "text");
                    if (string.IsNullOrEmpty(text)) Clipboard.Clear();
                    else Clipboard.SetText(text);
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "screen_info":
                {
                    var screen = Screen.PrimaryScreen;
                    float dpi;
                    using (var g = Graphics.FromHwnd(IntPtr.Zero)) { dpi = g.DpiX; }
                    double scale = Math.Round(dpi / 96.0, 2);
                    Console.WriteLine("{\\"ok\\":true,\\"width\\":" + screen.Bounds.Width + ",\\"height\\":" + screen.Bounds.Height + ",\\"scaleFactor\\":" + scale + "}");
                    break;
                }
                case "ax_tree":
                {
                    int pid = GetInt(req, "pid");
                    int maxDepth = GetInt(req, "maxDepth", 8);
                    var rolesObj = GetList(req, "roles");
                    var roles = rolesObj.Count > 0 ? rolesObj.Select(r => r.ToString().ToLower()).ToList() : null;

                    var root = FindAppRoot(pid);
                    axElementCount = 0;
                    var treeJson = WalkAXTree(root, 0, maxDepth, roles, "0");
                    Console.WriteLine("{\\"ok\\":true,\\"root\\":" + treeJson + ",\\"elementCount\\":" + axElementCount + "}");
                    break;
                }
                case "ax_action":
                {
                    var elementId = GetStr(req, "elementId");
                    var act = GetStr(req, "action_name");
                    int pid = GetInt(req, "pid");

                    var root = FindAppRoot(pid);
                    var el = NavigateToElement(root, elementId);

                    switch (act.ToLower())
                    {
                        case "invoke":
                        case "press":
                        case "click":
                            ((InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                            break;
                        case "toggle":
                            ((TogglePattern)el.GetCurrentPattern(TogglePattern.Pattern)).Toggle();
                            break;
                        case "expand":
                            ((ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand();
                            break;
                        case "collapse":
                            ((ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse();
                            break;
                        default:
                            if (act.StartsWith("setvalue:"))
                            {
                                var value = act.Substring(9);
                                ((ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);
                            }
                            else
                            {
                                throw new Exception("Unsupported action: " + act);
                            }
                            break;
                    }
                    Console.WriteLine("{\\"ok\\":true}");
                    break;
                }
                case "ax_search":
                {
                    var query = GetStr(req, "query");
                    var roleFilter = GetStr(req, "role", null);
                    int pid = GetInt(req, "pid");
                    int maxResults = GetInt(req, "maxResults", 20);

                    var root = FindAppRoot(pid);
                    var results = new List<string>();
                    SearchAXTree(root, query, roleFilter, maxResults, results, "0", 0, 20);
                    Console.WriteLine("{\\"ok\\":true,\\"elements\\":[" + string.Join(",", results) + "]}");
                    break;
                }
                default:
                    Console.WriteLine("{\\"ok\\":false,\\"error\\":" + JsonStr("Unknown action: " + action) + "}");
                    break;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\\"ok\\":false,\\"error\\":" + JsonStr(ex.Message) + "}");
        }
    }
}
`;

let compiled = false;

export async function ensureHelper(): Promise<string> {
  if (compiled && existsSync(HELPER_PATH)) return HELPER_PATH;

  if (existsSync(HELPER_PATH)) {
    compiled = true;
    return HELPER_PATH;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const srcPath = join(BIN_DIR, `desktop-helper-win-${HELPER_VERSION}.cs`);
  writeFileSync(srcPath, CSHARP_SOURCE);

  const cscPath = join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cscPath, [
      '/nologo',
      '/optimize+',
      `/out:${HELPER_PATH}`,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      '/r:UIAutomationClient.dll',
      '/r:UIAutomationTypes.dll',
      '/r:WindowsBase.dll',
      '/r:PresentationCore.dll',
      srcPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        compiled = true;
        resolve();
      } else {
        reject(new Error(`csc.exe failed (exit ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`csc.exe not found: ${err.message}. Ensure .NET Framework 4.x is installed.`));
    });
  });

  return HELPER_PATH;
}

export interface CSharpHelperRequest {
  action: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: string;
  clicks?: number;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
  keys?: string[];
  text?: string;
  name?: string;
  windowId?: number;
  width?: number;
  height?: number;
  pid?: number;
  maxDepth?: number;
  roles?: string[];
  elementId?: string;
  action_name?: string;
  query?: string;
  role?: string;
  maxResults?: number;
  value?: string;
}

export interface CSharpHelperResponse {
  ok: boolean;
  x?: number;
  y?: number;
  error?: string;
  image?: string;
  width?: number;
  height?: number;
  format?: string;
  windows?: any[];
  apps?: any[];
  text?: string;
  scaleFactor?: number;
  root?: any;
  elementCount?: number;
  elements?: any[];
}

export async function execHelper(request: CSharpHelperRequest): Promise<CSharpHelperResponse> {
  const helperPath = await ensureHelper();

  return new Promise((resolve, reject) => {
    const proc = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Helper failed (exit ${code}): ${stderr}`));
        return;
      }

      try {
        const response = JSON.parse(stdout.trim()) as CSharpHelperResponse;
        if (!response.ok && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      } catch {
        reject(new Error(`Invalid helper output: ${stdout}`));
      }
    });

    proc.on('error', reject);

    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}
