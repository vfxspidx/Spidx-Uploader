/* ========================================================================
 *  Spidx Uploader - global shortcut ("send frame from the active program")
 *
 *  A tiny background program (no window, no tray icon) started and watched by
 *  the Spidx tray app. It registers two system-wide shortcuts:
 *      send     (default Ctrl+Alt+U)        -> "Upload" in the program in front
 *      sendPs   (default Ctrl+Alt+Shift+U)  -> "Photoshop + Upload"
 *  and, when one is pressed, finds out WHICH program is in the foreground
 *  (After Effects / Premiere Pro / Photoshop / VEGAS Pro) and writes
 *      <incoming>\.capture-request.json   {"id","time","app","route"}
 *  The Spidx panel inside that program picks the file up within ~1.5 s, does
 *  exactly what its Upload button does and answers in
 *      <incoming>\.capture-ack.json       {"id","app","ok","message"}
 *  If nobody answers (the panel isn't open in that program) or it refuses, a
 *  balloon tells you why. Its own state is in <incoming>\.hotkey-status.json
 *  (e.g. "this shortcut is already used by another program").
 *

 *  NOTE: keep this file C# 5 compatible - the csc.exe that ships with Windows (.NET Framework 4.x)
 *  does not understand newer syntax (out variables, string interpolation, ?. ...).
 *
 *  BUILD: App\hotkey.js compiles this with csc.exe (ships with Windows) the first
 *  time it is needed - no Visual Studio. Run:  SpidxHotkey.exe --incoming <dir>
 *      [--send "Ctrl+Alt+U"] [--send-ps "Ctrl+Alt+Shift+U"] [--parent-pid N] [--ack-wait-ms 4000]
 * ==================================================================== */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

/// <summary>The pure parts - no Windows calls - so they can be tested on their own.</summary>
public static class HotkeyLogic
{
    public const uint MOD_ALT = 0x0001, MOD_CONTROL = 0x0002, MOD_SHIFT = 0x0004, MOD_WIN = 0x0008, MOD_NOREPEAT = 0x4000;

    static readonly Dictionary<string, uint> NamedKeys = new Dictionary<string, uint>(StringComparer.OrdinalIgnoreCase)
    {
        { "Space", 0x20 }, { "Tab", 0x09 }, { "Enter", 0x0D }, { "Insert", 0x2D }, { "Delete", 0x2E },
        { "Home", 0x24 }, { "End", 0x23 }, { "PageUp", 0x21 }, { "PageDown", 0x22 },
        { "Left", 0x25 }, { "Up", 0x26 }, { "Right", 0x27 }, { "Down", 0x28 }, { "PrintScreen", 0x2C }
    };

    /// <summary>"Ctrl+Alt+U" -> modifiers + virtual-key. At least one modifier and exactly one key are required.</summary>
    public static bool TryParseCombo(string text, out uint modifiers, out uint vk)
    {
        modifiers = 0; vk = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;

        bool haveKey = false;
        foreach (string raw in text.Split('+'))
        {
            string part = raw.Trim();
            if (part.Length == 0) return false;
            switch (part.ToLowerInvariant())
            {
                case "ctrl": case "control": modifiers |= MOD_CONTROL; continue;
                case "alt": modifiers |= MOD_ALT; continue;
                case "shift": modifiers |= MOD_SHIFT; continue;
                case "win": case "windows": case "meta": modifiers |= MOD_WIN; continue;
            }
            if (haveKey) return false;            // two keys: not a shortcut
            uint key;
            int f;                                // (declared here: csc.exe on Windows is a C# 5 compiler - no "out int f")
            if (part.Length == 1 && char.IsLetter(part[0]) && part[0] < 128) key = (uint)char.ToUpperInvariant(part[0]);
            else if (part.Length == 1 && char.IsDigit(part[0]) && part[0] < 128) key = (uint)part[0];
            else if ((part[0] == 'F' || part[0] == 'f') && part.Length <= 3 && int.TryParse(part.Substring(1), NumberStyles.None, CultureInfo.InvariantCulture, out f) && f >= 1 && f <= 24) key = (uint)(0x70 + f - 1);
            else if (!NamedKeys.TryGetValue(part, out key)) return false;
            vk = key; haveKey = true;
        }
        return haveKey && modifiers != 0;          // a bare key would hijack normal typing
    }

    /// <summary>Foreground process name -> the app id the panels use ("ae", "ppro", "ps", "vegas") or null.</summary>
    public static string AppForProcess(string processName)
    {
        if (string.IsNullOrEmpty(processName)) return null;
        string n = processName.Trim().ToLowerInvariant();
        if (n == "afterfx") return "ae";
        if (n == "adobe premiere pro" || n == "premiere pro" || n == "premierepro") return "ppro";
        if (n == "photoshop") return "ps";
        if (n.StartsWith("vegas")) return "vegas";    // vegas220, vegas230, "vegas pro"...
        return null;
    }

    public static string AppLabel(string app)
    {
        switch (app) { case "ae": return "After Effects"; case "ppro": return "Premiere Pro"; case "ps": return "Photoshop"; case "vegas": return "VEGAS Pro"; default: return app; }
    }

    public static string JsonEscape(string s)
    {
        StringBuilder b = new StringBuilder();
        foreach (char c in s ?? "")
        {
            if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
            else if (c == '\n') b.Append("\\n"); else if (c == '\r') b.Append("\\r"); else if (c == '\t') b.Append("\\t");
            else if (c < 32) b.Append("\\u" + ((int)c).ToString("x4")); else b.Append(c);
        }
        return b.ToString();
    }

    public static string RequestJson(string id, long timeMs, string app, string route)
    {
        return "{\"id\":\"" + JsonEscape(id) + "\",\"time\":" + timeMs.ToString(CultureInfo.InvariantCulture) +
               ",\"app\":\"" + JsonEscape(app) + "\",\"route\":\"" + JsonEscape(route) + "\"}";
    }

    /// <summary>Reads {"id":..,"ok":..,"message":..} without a JSON library. Returns false when it isn't about <paramref name="id"/>.</summary>
    public static bool TryParseAck(string json, string id, out bool ok, out string message)
    {
        ok = false; message = "";
        if (string.IsNullOrEmpty(json)) return false;
        Match mId = Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]*)\"");
        if (!mId.Success || mId.Groups[1].Value != id) return false;
        ok = Regex.IsMatch(json, "\"ok\"\\s*:\\s*true");
        Match mMsg = Regex.Match(json, "\"message\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (mMsg.Success) message = Regex.Unescape(mMsg.Groups[1].Value);
        return true;
    }

    public static string StatusJson(int pid, string sendCombo, bool sendOk, string sendPsCombo, bool sendPsOk, string error, long updatedMs)
    {
        return "{\"pid\":" + pid + ",\"send\":{\"combo\":\"" + JsonEscape(sendCombo) + "\",\"registered\":" + (sendOk ? "true" : "false") +
               "},\"sendPs\":{\"combo\":\"" + JsonEscape(sendPsCombo) + "\",\"registered\":" + (sendPsOk ? "true" : "false") +
               "},\"error\":" + (error == null ? "null" : "\"" + JsonEscape(error) + "\"") +
               ",\"updatedAt\":" + updatedMs.ToString(CultureInfo.InvariantCulture) + "}";
    }
}

sealed class HotkeyForm : Form
{
    const int WM_HOTKEY = 0x0312;
    const int IdSend = 1, IdSendPs = 2;

    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    // Test seams: null in the real program (the Windows calls above are used). Tests replace them.
    internal static Func<IntPtr, int, uint, uint, bool> RegisterHook;
    internal static Action<IntPtr, int> UnregisterHook;
    internal static Func<string> ForegroundProcessHook;   // tests: name of the "program in front"
    static bool NativeRegister(IntPtr h, int id, uint mods, uint vk) { return RegisterHook != null ? RegisterHook(h, id, mods, vk) : RegisterHotKey(h, id, mods, vk); }
    static void NativeUnregister(IntPtr h, int id) { if (UnregisterHook != null) UnregisterHook(h, id); else UnregisterHotKey(h, id); }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    readonly string incoming, sendCombo, sendPsCombo;
    readonly int ackWaitMs;
    readonly int parentPid;
    bool sendOk, sendPsOk;
    string error;
    readonly NotifyIcon balloon = new NotifyIcon();
    readonly Timer heartbeat = new Timer { Interval = 5000 };
    readonly Timer hideBalloon = new Timer { Interval = 5000 };

    public HotkeyForm(string incoming, string sendCombo, string sendPsCombo, int parentPid, int ackWaitMs)
    {
        this.incoming = incoming; this.sendCombo = sendCombo; this.sendPsCombo = sendPsCombo; this.parentPid = parentPid; this.ackWaitMs = ackWaitMs;
        ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None; Opacity = 0; Size = new Size(1, 1); StartPosition = FormStartPosition.Manual; Location = new Point(-32000, -32000);
        balloon.Icon = SystemIcons.Information; balloon.Text = "Spidx Uploader";
        hideBalloon.Tick += (s, e) => { hideBalloon.Stop(); balloon.Visible = false; };
        heartbeat.Tick += (s, e) => { WriteStatus(); if (parentPid > 0 && !ParentAlive()) Application.Exit(); };

        // A form that is never shown is NOT given a window handle by WinForms - and the shortcuts are
        // registered on that handle (OnHandleCreated). So create it explicitly, right now.
        IntPtr handle = Handle;
    }

    // Never visible. But the window must still EXIST (handle + message loop), so make sure it does.
    protected override void SetVisibleCore(bool value)
    {
        if (!IsHandleCreated) CreateHandle();
        base.SetVisibleCore(false);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        sendOk = Register(IdSend, sendCombo, "Upload");
        sendPsOk = Register(IdSendPs, sendPsCombo, "Photoshop + Upload");
        WriteStatus();
        heartbeat.Start();
    }

    bool Register(int id, string combo, string what)
    {
        uint mods, vk;
        if (!HotkeyLogic.TryParseCombo(combo, out mods, out vk)) { Append("\"" + combo + "\" is not a valid shortcut (" + what + ")."); return false; }
        if (!NativeRegister(Handle, id, mods | HotkeyLogic.MOD_NOREPEAT, vk)) { Append("\"" + combo + "\" is already used by another program (" + what + ")."); return false; }
        return true;
    }

    void Append(string text) { error = error == null ? text : error + " " + text; }

    bool ParentAlive()
    {
        try { Process p = Process.GetProcessById(parentPid); return !p.HasExited; } catch { return false; }
    }

    void WriteStatus()
    {
        try
        {
            string json = HotkeyLogic.StatusJson(Process.GetCurrentProcess().Id, sendCombo, sendOk, sendPsCombo, sendPsOk, error, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            WriteAtomic(Path.Combine(incoming, ".hotkey-status.json"), json);
        }
        catch { }
    }

    static void WriteAtomic(string path, string text)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        if (File.Exists(path)) File.Delete(path);
        File.Move(tmp, path);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY) { OnHotkey(m.WParam.ToInt32() == IdSendPs ? "ps" : "normal"); return; }
        base.WndProc(ref m);
    }

    string ForegroundApp(out string processName)
    {
        processName = null;
        if (ForegroundProcessHook != null) { processName = ForegroundProcessHook(); return HotkeyLogic.AppForProcess(processName); }
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            processName = Process.GetProcessById((int)pid).ProcessName;
            return HotkeyLogic.AppForProcess(processName);
        }
        catch { return null; }
    }

    void OnHotkey(string route)
    {
        string processName;
        string app = ForegroundApp(out processName);
        if (app == null) { Say("Spidx Uploader", "Nothing to send from \"" + (processName ?? "this window") + "\" - use it inside After Effects, Premiere Pro, Photoshop or VEGAS Pro."); return; }

        string id = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) + "-" + new Random().Next(1000, 9999);
        try
        {
            Directory.CreateDirectory(incoming);
            WriteAtomic(Path.Combine(incoming, ".capture-request.json"), HotkeyLogic.RequestJson(id, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), app, route));
        }
        catch (Exception ex) { Say("Spidx Uploader", "Could not reach the incoming folder: " + ex.Message); return; }

        WaitForAck(id, app);
    }

    // Polls for the panel's answer without blocking the message loop.
    void WaitForAck(string id, string app)
    {
        Timer t = new Timer { Interval = 150 };
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(ackWaitMs);
        t.Tick += (s, e) =>
        {
            string json = null;
            try { json = File.ReadAllText(Path.Combine(incoming, ".capture-ack.json")); } catch { }
            bool ok; string message;
            if (HotkeyLogic.TryParseAck(json, id, out ok, out message))
            {
                t.Stop(); t.Dispose();
                if (!ok) Say("Spidx Uploader - " + HotkeyLogic.AppLabel(app), string.IsNullOrEmpty(message) ? "The panel could not send it." : message);
                return;                                    // success: the panel's own card + the upload notification say the rest
            }
            if (DateTime.UtcNow > deadline)
            {
                t.Stop(); t.Dispose();
                Say("Spidx Uploader - " + HotkeyLogic.AppLabel(app), "No answer from the Spidx panel. Open the Spidx Uploader panel in " + HotkeyLogic.AppLabel(app) + " (Window > Extensions) and try again.");
            }
        };
        t.Start();
    }

    void Say(string title, string text)
    {
        balloon.Visible = true;
        balloon.ShowBalloonTip(4000, title, text, ToolTipIcon.Info);
        hideBalloon.Stop(); hideBalloon.Start();
    }

    // Runs when the program ends (the message loop has no main form, so there is no FormClosed): release the shortcuts.
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (IsHandleCreated) { NativeUnregister(Handle, IdSend); NativeUnregister(Handle, IdSendPs); }
            heartbeat.Stop(); hideBalloon.Stop();
            balloon.Visible = false; balloon.Dispose();
        }
        base.Dispose(disposing);
    }
}

static class Program
{
    static string Arg(string[] args, string name, string fallback)
    {
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        return fallback;
    }

    [STAThread]
    static int Main(string[] args)
    {
        string incoming = Arg(args, "--incoming", null);
        if (string.IsNullOrEmpty(incoming)) { return 2; }
        int parentPid; int.TryParse(Arg(args, "--parent-pid", "0"), out parentPid);
        int ackWait; if (!int.TryParse(Arg(args, "--ack-wait-ms", "4000"), out ackWait)) ackWait = 4000;

        // one copy only
        bool createdNew;
        using (System.Threading.Mutex mutex = new System.Threading.Mutex(true, "Spidx.Hotkey." + incoming.ToLowerInvariant().GetHashCode(), out createdNew))
        {
            if (!createdNew) return 3;
            Application.EnableVisualStyles();
            // The window only exists to own the shortcuts (its handle is created in the constructor). The message loop is
            // started WITHOUT a main form, so it never depends on that window being visible; Application.Exit() ends it.
            HotkeyForm form = new HotkeyForm(incoming, Arg(args, "--send", "Ctrl+Alt+U"), Arg(args, "--send-ps", "Ctrl+Alt+Shift+U"), parentPid, ackWait);
            Application.Run(new ApplicationContext());
            form.Dispose();
        }
        return 0;
    }
}
