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
// Starting the Electron runtime directly would leave a console window, name the
// process "electron" and inherit developer-only environment switches, so this
// stub finds the runtime, points it at the app directory, hides everything and
// forwards file arguments so Windows file associations land in the running
// instance (the app is single-instance and opens dropped files as new tabs).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

internal static class LumenLauncher
{
    private const string AppTitle = "LeebertyPDF";

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

        StringBuilder argLine = new StringBuilder();
        argLine.Append('"').Append(appDir).Append('"');
        foreach (string a in args)
        {
            argLine.Append(' ');
            argLine.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
        }

        string command = BuildLaunchCommand(runtime, argLine.ToString());
        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", command);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = baseDir;

        // psi.EnvironmentVariables is deliberately never touched. On .NET
        // Framework its getter builds a case-insensitive StringDictionary from
        // the (case-sensitive) process environment block, and throws
        // ArgumentException when one variable exists under two spellings --
        // NO_PROXY and no_proxy are both set on machines behind a proxy, and
        // that made the launcher exit silently before the runtime ever started.
        //
        // Electron is launched through a small cmd wrapper instead, which can
        // filter the environment without that landmine.

        try
        {
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            ShowError("启动失败 / Could not start:\n" + ex.Message);
            return 1;
        }
    }

    /// <summary>
    /// Builds the `cmd.exe /c set ... &amp; electron` line that launches the
    /// runtime with a filtered environment.
    ///
    /// `set "NAME="` unsets a variable regardless of how it was spelled, which is
    /// something ProcessStartInfo cannot do safely here: its environment
    /// dictionary is case-insensitive while the process block it is built from is
    /// not, so it throws as soon as a name appears twice in different cases.
    /// </summary>
    private static string BuildLaunchCommand(string runtime, string arguments)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("/c \"");
        string[] blocked = new string[]
        {
            "ELECTRON_RUN_AS_NODE",
            "NODE_OPTIONS",
            "LUMEN_SELFTEST",
            "LUMEN_TOOL",
            "LUMEN_FEATURETEST",
            "LUMEN_IMGTEST",
            "LUMEN_BLANKPROBE",
            "LUMEN_FEATUREPROBE",
            "LUMEN_MEMPROBE",
        };
        foreach (string name in blocked)
        {
            sb.Append("set \"").Append(name).Append("=\" & ");
        }
        sb.Append("set \"LUMEN_LAUNCHER=1\" & ");
        sb.Append('"').Append(runtime).Append('"');
        if (!string.IsNullOrEmpty(arguments))
        {
            sb.Append(' ').Append(arguments);
        }
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
