// dsh standalone launcher.
//
// This is the .exe entry point of the portable DeepSeek Harness distribution.
// It locates the bundled Node runtime and the bundled CLI next to itself and
// forwards every argument to them, so the target machine needs no Node, pnpm,
// or Python installed.
//
// It also owns the self-update path. Update commands are answered here, before
// anything under app\ is read, so an install whose payload is broken or only
// half-extracted can still repair itself from the release feed. See updater.cs.
//
// Compiled with the C# compiler that ships in Windows
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe), so it targets
// .NET Framework 4.x, which is present on every supported Windows install.
// Written to C# 5 so that compiler accepts it.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

internal static class DshLauncher
{
    // Paths to the CLI entry, relative to the distribution root, most likely first.
    private static readonly string[] CliCandidates = new string[]
    {
        Path.Combine("app", "lib", "bin.js"),
        Path.Combine("app", "apps", "cli", "lib", "bin.js"),
        Path.Combine("lib", "bin.js"),
        Path.Combine("apps", "cli", "lib", "bin.js"),
    };

    private static readonly string[] NodeCandidates = new string[]
    {
        Path.Combine("runtime", "node.exe"),
        Path.Combine("node", "node.exe"),
        "node.exe",
    };

    private static int Fail(string message)
    {
        Console.Error.WriteLine("dsh: " + message);
        return 127;
    }

    // Walk upward from start looking for a relative path; returns null when absent.
    private static string FindUp(string start, string relative)
    {
        DirectoryInfo dir = new DirectoryInfo(start);
        while (dir != null)
        {
            string candidate = Path.Combine(dir.FullName, relative);
            if (File.Exists(candidate))
            {
                return candidate;
            }
            dir = dir.Parent;
        }
        return null;
    }

    private static string FirstExisting(string root, string[] relatives)
    {
        foreach (string rel in relatives)
        {
            string hit = FindUp(root, rel);
            if (hit != null)
            {
                return hit;
            }
        }
        return null;
    }

    // Quote one argument for the Windows command line (CommandLineToArgvW rules).
    private static string Quote(string value)
    {
        if (value == null)
        {
            return "\"\"";
        }
        if (value.Length > 0
            && value.IndexOf(' ') < 0
            && value.IndexOf('\t') < 0
            && value.IndexOf('"') < 0)
        {
            return value;
        }

        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                backslashes++;
                sb.Append(c);
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                backslashes = 0;
                sb.Append(c);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        // Must run before any System.IO member: the runtime freezes its
        // legacy-path-handling decision the first time one executes, and a
        // deep install needs long paths enabled for the update to extract.
        DshUpdater.EnableLongPaths();

        string exePath = Assembly.GetExecutingAssembly().Location;
        if (exePath == null || exePath.Length == 0)
        {
            exePath = Process.GetCurrentProcess().MainModule.FileName;
        }

        string root = Path.GetDirectoryName(exePath);
        if (root == null || root.Length == 0)
        {
            root = Directory.GetCurrentDirectory();
        }

        // An explicit override wins, so a caller can point the launcher at a payload.
        string appOverride = Environment.GetEnvironmentVariable("DSH_LAUNCH_APP");
        if (appOverride != null && appOverride.Length > 0)
        {
            root = appOverride;
        }

        // Resolve the harness home once, at process scope, so this process and the
        // harness it starts agree on where sessions and update state live.
        string dshHome = Environment.GetEnvironmentVariable("DSH_HOME");
        if (dshHome == null || dshHome.Length == 0)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            dshHome = Path.Combine(local, "dsh-standalone");
            Environment.SetEnvironmentVariable("DSH_HOME", dshHome);
        }
        Environment.SetEnvironmentVariable("DSH_STANDALONE_ROOT", root);

        // An update command is answered here and never reaches the harness. This
        // ordering is the point: it is what lets a broken payload repair itself.
        int handled = DshUpdater.TryHandle(args, root);
        if (handled >= 0)
        {
            return handled;
        }

        // Hands the routine update check to a detached copy of this executable so
        // a launch is never delayed by the network. It records its own rate limit
        // and returns immediately.
        DshUpdater.MaybeAutoUpdate(root);

        string node = FirstExisting(root, NodeCandidates);
        string cli = FirstExisting(root, CliCandidates);

        if (node == null)
        {
            return Fail("bundled Node runtime not found (expected runtime\\node.exe beside this executable)");
        }
        if (cli == null)
        {
            return Fail("bundled dsh CLI not found (expected app\\lib\\bin.js beside this executable)");
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Directory.GetCurrentDirectory();

        StringBuilder arguments = new StringBuilder();
        arguments.Append(Quote(cli));
        for (int i = 0; i < args.Length; i++)
        {
            arguments.Append(' ');
            arguments.Append(Quote(args[i]));
        }
        psi.Arguments = arguments.ToString();

        psi.EnvironmentVariables["DSH_HOME"] = dshHome;
        psi.EnvironmentVariables["DSH_STANDALONE_ROOT"] = root;

        try
        {
            Process child = Process.Start(psi);
            child.WaitForExit();
            return child.ExitCode;
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }
}
