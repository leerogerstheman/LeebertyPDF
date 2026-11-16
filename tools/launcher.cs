// LeebertyPDF - launcher.
//
// Compiled to `LeebertyPDF.exe` and used for both layouts:
//
//   portable / installed           development checkout
//   ---------------------           --------------------
//   LeebertyPDF.exe                    LeebertyPDF.exe          <- this launcher
//   electron.exe                    _vendor\electron\electron.exe
//   resources\app\...               src\...  package.json
//
// Starting the Electron runtime directly would name the process "electron",
// inherit developer-only environment switches, and show whatever console the
// parent happened to have, so this stub resolves the runtime, fixes the
// environment, hides everything and forwards file arguments so Windows file
// associations land in the running instance (the app is single-instance and
// opens dropped files as new tabs).
//
// It calls CreateProcessW itself rather than going through Process.Start:
//
//   * ProcessStartInfo.EnvironmentVariables cannot be used here. Its getter
//     builds a case-insensitive dictionary from the (case-sensitive) process
//     environment block and throws ArgumentException as soon as one variable
//     exists under two spellings -- NO_PROXY and no_proxy are both set on any
//     machine behind a proxy, and the launcher then died before creating a
//     window, which looks exactly like "double-click does nothing".
//   * The obvious workaround, `cmd.exe /c set NAME= & electron`, works but puts
//     a visible console window on screen and makes the reader a child of that
//     console: closing the window kills the app. A direct CreateProcessW has
//     neither problem -- no console is created, and there is no intermediate
//     process to cascade through.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

internal static class LumenLauncher
{
    private const string AppTitle = "LeebertyPDF";

    /// <summary>The environment block handed to CreateProcessW is Unicode.</summary>
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [STAThread]
    private static int Main(string[] args)
    {
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        // NOTE: compiled by the .NET Framework 4.0 csc.exe that ships with
        // Windows, which predates C# 7 — no inline `out var` declarations here.
        string runtime;
        string appDir;
        string problem;
        if (!Resolve(baseDir, out runtime, out appDir, out problem))
        {
            ShowError(problem);
            return 2;
        }

        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(QuoteArgument(runtime));
        commandLine.Append(' ').Append(QuoteArgument(appDir));
        foreach (string a in args)
        {
            commandLine.Append(' ').Append(QuoteArgument(a));
        }

        IntPtr environmentBlock = Marshal.StringToHGlobalUni(BuildEnvironmentBlock());
        try
        {
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION process;
            bool started = CreateProcess(
                runtime,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_UNICODE_ENVIRONMENT,
                environmentBlock,
                baseDir,
                ref startup,
                out process);
            if (!started)
            {
                int code = Marshal.GetLastWin32Error();
                ShowError(
                    "启动失败 / Could not start:\n" +
                    new Win32Exception(code).Message +
                    "\n\n" + runtime);
                return 1;
            }
            // The launcher's job ends here: dropping the handles leaves the app
            // entirely independent, so nothing that happens to this process can
            // take the reader down with it.
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return 0;
        }
        catch (Exception ex)
        {
            ShowError("启动失败 / Could not start:\n" + ex.Message);
            return 1;
        }
        finally
        {
            Marshal.FreeHGlobal(environmentBlock);
        }
    }

    /// <summary>
    /// Builds the UTF-16 environment block passed to CreateProcessW: a sequence
    /// of "NAME=VALUE" strings, each NUL-terminated, followed by a final NUL.
    ///
    /// Sorted case-insensitively and de-duplicated by name, because Windows
    /// treats environment names case-insensitively while the block this process
    /// inherited can legitimately hold both spellings. Kernel32 looks names up
    /// with a binary search, so the block has to be in the order it expects.
    /// </summary>
    private static string BuildEnvironmentBlock()
    {
        SortedDictionary<string, string> variables =
            new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string key = (string)entry.Key;
            if (string.IsNullOrEmpty(key)) continue;
            // Developer-only switches would turn the runtime into a plain
            // Node.js process, or start the app in a test mode.
            if (IsBlocked(key)) continue;
            string value = entry.Value as string;
            variables[key] = value ?? string.Empty;
        }
        variables["LUMEN_LAUNCHER"] = "1";

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> pair in variables)
        {
            block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        }
        block.Append('\0');
        return block.ToString();
    }

    /// <summary>Variables the runtime must never inherit.</summary>
    private static bool IsBlocked(string key)
    {
        string name = key.ToUpperInvariant();
        switch (name)
        {
            case "ELECTRON_RUN_AS_NODE":
            case "NODE_OPTIONS":
            case "LUMEN_SELFTEST":
            case "LUMEN_TOOL":
            case "LUMEN_FEATURETEST":
            case "LUMEN_IMGTEST":
            case "LUMEN_BLANKPROBE":
            case "LUMEN_FEATUREPROBE":
            case "LUMEN_MEMPROBE":
            case "LUMEN_SHOTS":
            case "LUMEN_LAUNCHER":
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Quotes one argument the way CommandLineToArgvW parses it back.
    ///
    /// The rule that matters is the backslash run before a quote: a quote has to
    /// be preceded by 2N+1 backslashes to survive, and a run of backslashes at
    /// the very end of the argument has to be doubled so it does not swallow the
    /// closing quote. Paths such as C:\Users\Some Name\... need this, and so do
    /// file arguments.
    /// </summary>
    private static string QuoteArgument(string value)
    {
        if (value == null) return "\"\"";
        bool needsQuotes = value.Length == 0;
        if (!needsQuotes)
        {
            foreach (char c in value)
            {
                if (c == ' ' || c == '\t' || c == '"')
                {
                    needsQuotes = true;
                    break;
                }
            }
        }
        if (!needsQuotes) return value;

        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                sb.Append('\\', backslashes);
                backslashes = 0;
            }
            sb.Append(c);
        }
        // trailing backslashes would escape the closing quote
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    /// <summary>
    /// Locates the Electron runtime and the application directory for either the
    /// packaged layout or a development checkout.
    /// </summary>
    private static bool Resolve(string baseDir, out string runtime, out string appDir, out string problem)
    {
        runtime = null;
        appDir = null;
        problem = null;

        // 1. packaged layout: runtime next to this launcher
        string packagedApp = Path.Combine(baseDir, "resources", "app");
        string packagedRuntime = Path.Combine(baseDir, "electron.exe");
        if (File.Exists(packagedRuntime) && File.Exists(Path.Combine(packagedApp, "package.json")))
        {
            runtime = packagedRuntime;
            appDir = packagedApp;
            return true;
        }

        // 2. development layout: the checkout root with a vendored runtime
        string devRuntime = Path.Combine(baseDir, "_vendor", "electron", "electron.exe");
        if (File.Exists(devRuntime) && File.Exists(Path.Combine(baseDir, "package.json")))
        {
            runtime = devRuntime;
            appDir = baseDir;
            return true;
        }

        // 3. last resort: sibling dist folder (launcher copied elsewhere)
        string distRuntime = Path.Combine(baseDir, "dist", "electron.exe");
        string distApp = Path.Combine(baseDir, "dist", "resources", "app");
        if (File.Exists(distRuntime) && File.Exists(Path.Combine(distApp, "package.json")))
        {
            runtime = distRuntime;
            appDir = distApp;
            return true;
        }

        StringBuilder detail = new StringBuilder();
        detail.Append("找不到 LeebertyPDF 的运行环境。\n");
        detail.Append("Could not find the LeebertyPDF runtime.\n\n");
        detail.Append("已检查 / looked for:\n");
        detail.Append("  ").Append(packagedRuntime).Append('\n');
        detail.Append("  ").Append(devRuntime).Append('\n');
        detail.Append("  ").Append(distRuntime).Append('\n');
        detail.Append("\n请把 LeebertyPDF.exe 放回程序目录，或重新运行 tools\\build.ps1。\n");
        detail.Append("Put LeebertyPDF.exe back in the program folder, or re-run tools\\build.ps1.");
        problem = detail.ToString();
        return false;
    }

    private static void ShowError(string message)
    {
        try
        {
            // two-argument overload: OK button, no icon (always available)
            System.Windows.Forms.MessageBox.Show(message, AppTitle);
        }
        catch
        {
            Console.Error.WriteLine(message);
        }
    }
}
