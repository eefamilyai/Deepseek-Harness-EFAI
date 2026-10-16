// dsh standalone self-update.
//
// The launcher dispatches here before it reads anything out of app\, so an
// install whose payload is broken or half-extracted can still repair itself.
// Everything here is .NET Framework only -- JavaScriptSerializer for the
// release JSON, HttpWebRequest for the download, ZipArchive for extraction --
// so updating needs no Node runtime and no external tool.
//
// Flow: read manifest.json for the local distribution version, ask the release
// source for the newest published release, compare, then download the asset and
// check its SHA-256 against the digest the release advertises. Nothing on disk
// changes until that check passes: the archive is expanded into a staging
// folder beside the install, and a generated batch script swaps the two
// directories once this process has exited. A running dsh.exe cannot be
// overwritten in place, so the swap is deliberately delegated to a detached
// process that can outlive it and roll back if the move fails.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class DshUpdater
{
    internal const string DefaultRepo = "eefamilyai/Deepseek-Harness-EFAI";
    internal const string DefaultApiBase = "https://api.github.com";
    internal const string AssetName = "dsh-standalone.zip";
    internal const string KernelAssetName = "dsh-standalone-kernel.zip";

    private const string UserAgent = "dsh-standalone-updater";

    // GitHub serves HTTPS over TLS 1.2 and refuses older protocols outright,
    // while .NET Framework 4.x still negotiates SSL3/TLS1.0 by default unless
    // an application opts in. The numeric value is used rather than
    // SecurityProtocolType.Tls12 because that member does not exist when the
    // compiler's reference assembly predates .NET 4.5.
    private const int Tls12 = 3072;

    private static bool tlsReady;

    // Long-path support is off by default on .NET Framework. While legacy path
    // handling is active the runtime validates an extended-length path and
    // rejects it as containing illegal characters, so the prefix cannot be used
    // at all. Clearing the switches lifts that, but the runtime freezes the
    // decision the first time any System.IO member runs, so this must be the
    // first thing an entry point does -- before a manifest is read or a
    // directory is probed.
    internal static void EnableLongPaths()
    {
        try
        {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        }
        catch
        {
            // A runtime that cannot name the switches keeps legacy behaviour;
            // long paths then simply stay unsupported.
        }
    }

    private static void EnsureTls()
    {
        if (tlsReady) return;
        tlsReady = true;

        try
        {
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)Tls12;
        }
        catch
        {
            // An older runtime that cannot name the value still gets its default.
        }
        ServicePointManager.DefaultConnectionLimit = 8;
    }
    // ----------------------------------------------------------------- config

    internal sealed class Settings
    {
        public string Repo = DefaultRepo;
        public string ApiBase = DefaultApiBase;
        public string ManifestUrl;
        public bool Prerelease;
        public bool AutoCheck = true;
        public bool AutoUpdate = true;
        public int CheckIntervalHours = 24;
    }

    internal sealed class Release
    {
        public string Tag;
        public string Version;
        public string Notes;
        public string HtmlUrl;
        public bool Prerelease;
        public bool Draft;
        public string AssetName;
        public string AssetUrl;
        public long AssetSize;
        public string AssetSha256;
    }

    // -------------------------------------------------------------- settings

    private static string HomeDir()
    {
        string home = Environment.GetEnvironmentVariable("DSH_HOME");
        if (home == null || home.Length == 0)
        {
            home = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-standalone");
        }
        return home;
    }

    private static Dictionary<string, object> ReadJsonObject(string path)
    {
        if (path == null || !File.Exists(path)) return null;
        try
        {
            object parsed = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path));
            return parsed as Dictionary<string, object>;
        }
        catch
        {
            return null;
        }
    }

    private static bool Bool(Dictionary<string, object> d, string key, bool fallback)
    {
        if (d == null || !d.ContainsKey(key)) return fallback;
        object v = d[key];
        if (v is bool) return (bool)v;
        if (v is string) return string.Equals((string)v, "true", StringComparison.OrdinalIgnoreCase);
        return fallback;
    }

    private static string Str(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.ContainsKey(key)) return null;
        object v = d[key];
        return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    // Reads <root>\update.json, then manifest.json, then the environment. The
    // environment wins so an operator can redirect a single run without editing
    // the install.
    internal static Settings LoadSettings(string root)
    {
        Settings s = new Settings();

        Dictionary<string, object> manifest = ReadJsonObject(Path.Combine(root, "manifest.json"));
        Dictionary<string, object> file = ReadJsonObject(Path.Combine(root, "update.json"));
        if (file == null) file = manifest;

        string repo = Str(file, "updateRepo");
        if (repo == null) repo = Str(file, "repo");
        if (repo != null) s.Repo = repo;

        string api = Str(file, "apiBase");
        if (api != null) s.ApiBase = api;

        s.ManifestUrl = Str(file, "manifestUrl");
        s.Prerelease = Bool(file, "prerelease", s.Prerelease);
        s.AutoCheck = Bool(file, "autoCheck", s.AutoCheck);
        s.AutoUpdate = Bool(file, "autoUpdate", s.AutoUpdate);

        string hours = Str(file, "checkIntervalHours");
        int parsedHours;
        if (hours != null && int.TryParse(hours, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedHours))
        {
            s.CheckIntervalHours = parsedHours;
        }

        string envRepo = Environment.GetEnvironmentVariable("DSH_UPDATE_REPO");
        if (envRepo != null && envRepo.Length > 0) s.Repo = envRepo;

        string envApi = Environment.GetEnvironmentVariable("DSH_UPDATE_API");
        if (envApi != null && envApi.Length > 0) s.ApiBase = envApi;

        string envUrl = Environment.GetEnvironmentVariable("DSH_UPDATE_URL");
        if (envUrl != null && envUrl.Length > 0) s.ManifestUrl = envUrl;

        string envAuto = Environment.GetEnvironmentVariable("DSH_AUTO_UPDATE");
        if (envAuto != null && envAuto.Length > 0) s.AutoUpdate = envAuto != "0";

        return s;
    }

    private static int[] LocalVersion(string root)
    {
        Dictionary<string, object> manifest = ReadJsonObject(Path.Combine(root, "manifest.json"));
        string text = Str(manifest, "standaloneVersion");
        if (text == null) text = Str(manifest, "version");
        return ParseVersion(text);
    }

    // --------------------------------------------------------------- versions
    // The distribution has its own version line, independent of the harness
    // version it packages, so that a rebuild of the same harness still counts as
    // a new distribution. Only the leading dotted triple is compared; a channel
    // suffix such as "-standalone" is not an ordering signal.

    internal static int[] ParseVersion(string text)
    {
        if (text != null)
        {
            Match m = Regex.Match(text, @"(\d+)\.(\d+)(?:\.(\d+))?");
            if (m.Success)
            {
                int major = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                int minor = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                int patch = m.Groups[3].Success
                    ? int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture)
                    : 0;
                return new int[] { major, minor, patch };
            }
        }
        return new int[] { 0, 0, 0 };
    }

    private static int CompareVersion(int[] a, int[] b)
    {
        for (int i = 0; i < 3; i++)
        {
            if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
        }
        return 0;
    }

    private static string VersionText(int[] v)
    {
        return v[0].ToString(CultureInfo.InvariantCulture)
            + "." + v[1].ToString(CultureInfo.InvariantCulture)
            + "." + v[2].ToString(CultureInfo.InvariantCulture);
    }

    // ------------------------------------------------------------- HTTP layer

    // Send this process's output to a file, so a detached run leaves a record
    // without holding onto whatever handles its parent happened to own.
    private static void RedirectToLog()
    {
        try
        {
            string dir = HomeDir();
            Directory.CreateDirectory(dir);
            StreamWriter writer = new StreamWriter(
                new FileStream(Path.Combine(dir, "update.log"),
                               FileMode.Append, FileAccess.Write, FileShare.Read),
                new UTF8Encoding(false));
            writer.AutoFlush = true;
            Console.SetOut(writer);
            Console.SetError(writer);
        }
        catch
        {
            // Without a log the run still proceeds; only the record is lost.
        }
    }

    private static string HttpGet(string url, string accept)
    {
        EnsureTls();
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.UserAgent = UserAgent;
        request.Accept = accept;
        request.AllowAutoRedirect = true;
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (Stream stream = response.GetResponseStream())
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    // ---------------------------------------------------------- release feed

    private static Release ParseRelease(Dictionary<string, object> item, Settings s, string root)
    {
        Release r = new Release();
        r.Tag = Str(item, "tag_name");
        if (r.Tag == null) r.Tag = Str(item, "version");
        r.Version = Str(item, "version");
        r.Notes = Str(item, "body");
        if (r.Notes == null) r.Notes = Str(item, "notes");
        r.HtmlUrl = Str(item, "html_url");
        r.Prerelease = Bool(item, "prerelease", false);
        r.Draft = Bool(item, "draft", false);

        string size = Str(item, "size");
        long parsedSize;
        if (size != null && long.TryParse(size, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedSize))
        {
            r.AssetSize = parsedSize;
        }

        // A single-release descriptor (the manifestUrl shape) carries the asset
        // fields at the top level.
        string direct = Str(item, "url");
        if (direct != null)
        {
            r.AssetName = AssetName;
            r.AssetUrl = direct;
            r.AssetSha256 = NormaliseSha(Str(item, "sha256"));
        }

        object[] assets = null;
        if (item.ContainsKey("assets")) assets = item["assets"] as object[];
        if (assets != null)
        {
            // A kernel install carries the vendored Python runtime; it must take
            // the kernel asset when one is published, or the update would silently
            // drop it. When no kernel asset is published the plain asset is used.
            bool hasKernel = root != null && Directory.Exists(Path.Combine(root, "app", "python"));
            string preferred = hasKernel ? KernelAssetName : AssetName;
            Dictionary<string, object> chosen = null;
            foreach (object o in assets)
            {
                Dictionary<string, object> a = o as Dictionary<string, object>;
                if (a == null) continue;
                string name = Str(a, "name");
                if (name == null) continue;
                if (chosen == null && name == preferred) chosen = a;
                if (chosen == null && name == AssetName) chosen = a;
            }
            if (chosen != null)
            {
                r.AssetName = Str(chosen, "name");
                r.AssetUrl = Str(chosen, "browser_download_url");
                if (r.AssetUrl == null) r.AssetUrl = Str(chosen, "url");
                r.AssetSha256 = NormaliseSha(Str(chosen, "digest"));
                string asize = Str(chosen, "size");
                if (asize != null && long.TryParse(asize, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedSize))
                {
                    r.AssetSize = parsedSize;
                }
            }
        }

        // Some releases carry the hash only in the notes; accept that too.
        if (r.AssetSha256 == null && r.Notes != null)
        {
            Match m = Regex.Match(r.Notes, @"sha256[:\s]+([0-9a-fA-F]{64})");
            if (m.Success) r.AssetSha256 = m.Groups[1].Value.ToLowerInvariant();
        }

        if (r.Version == null) r.Version = r.Tag;
        return r;
    }

    private static string NormaliseSha(string value)
    {
        if (value == null) return null;
        value = value.Trim().ToLowerInvariant();
        if (value.StartsWith("sha256:", StringComparison.Ordinal)) value = value.Substring(7);
        if (value.Length != 64) return null;
        return Regex.IsMatch(value, "^[0-9a-f]{64}$") ? value : null;
    }

    internal static List<Release> FetchReleases(Settings s, string root)
    {
        List<Release> releases = new List<Release>();

        if (s.ManifestUrl != null && s.ManifestUrl.Length > 0)
        {
            object parsed = new JavaScriptSerializer().DeserializeObject(HttpGet(s.ManifestUrl, "application/json"));
            object[] array = parsed as object[];
            if (array != null)
            {
                foreach (object o in array)
                {
                    Dictionary<string, object> d = o as Dictionary<string, object>;
                    if (d != null) releases.Add(ParseRelease(d, s, root));
                }
            }
            else
            {
                Dictionary<string, object> d = parsed as Dictionary<string, object>;
                if (d == null) throw new InvalidOperationException("release manifest did not parse");
                releases.Add(ParseRelease(d, s, root));
            }
            return releases;
        }

        string url = s.ApiBase.TrimEnd('/') + "/repos/" + s.Repo + "/releases?per_page=30";
        object feed = new JavaScriptSerializer().DeserializeObject(HttpGet(url, "application/vnd.github+json"));
        object[] items = feed as object[];
        if (items == null)
        {
            throw new InvalidOperationException("release feed at " + url + " did not return a list");
        }
        foreach (object o in items)
        {
            Dictionary<string, object> d = o as Dictionary<string, object>;
            if (d != null) releases.Add(ParseRelease(d, s, root));
        }
        return releases;
    }

    // Highest published version that actually carries a downloadable asset.
    internal static Release PickNewest(List<Release> releases, Settings s, int[] local, bool force)
    {
        Release best = null;
        int[] bestVersion = null;
        foreach (Release r in releases)
        {
            if (r.Draft) continue;
            if (r.Prerelease && !s.Prerelease) continue;
            if (r.AssetUrl == null || r.AssetUrl.Length == 0) continue;

            int[] v = ParseVersion(r.Version);
            if (best == null)
            {
                best = r;
                bestVersion = v;
                continue;
            }
            int cmp = CompareVersion(v, bestVersion);
            if (cmp > 0 || (cmp == 0 && best.Prerelease && !r.Prerelease))
            {
                best = r;
                bestVersion = v;
            }
        }

        // Without --force the release must actually be newer than what is here.
        if (best != null && !force && CompareVersion(bestVersion, local) <= 0) return null;
        return best;
    }

    // --------------------------------------------------------------- download

    private static void Download(string url, string destPath, bool quiet)
    {
        EnsureTls();
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.UserAgent = UserAgent;
        request.AllowAutoRedirect = true;
        request.Timeout = 60000;
        request.ReadWriteTimeout = 300000;

        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (Stream remote = response.GetResponseStream())
        using (FileStream local = new FileStream(LongPath(Path.GetFullPath(destPath)), FileMode.Create, FileAccess.Write, FileShare.None))
        {
            byte[] buffer = new byte[1 << 20];
            long total = 0;
            long expected = response.ContentLength;
            int lastPercent = -1;
            int read;
            while ((read = remote.Read(buffer, 0, buffer.Length)) > 0)
            {
                local.Write(buffer, 0, read);
                total += read;
                if (quiet || expected <= 0) continue;
                int percent = (int)(total * 100 / expected);
                if (percent >= lastPercent + 5)
                {
                    lastPercent = percent;
                    Console.Error.Write("\rdsh: downloading {0}% ({1:N1} MB)", percent, total / 1048576.0);
                }
            }
            if (!quiet && expected > 0) Console.Error.Write("\r");
            if (!quiet) Console.Error.WriteLine("dsh: downloaded {0:N1} MB", total / 1048576.0);
        }
    }

    private static string Sha256File(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream fs = new FileStream(LongPath(Path.GetFullPath(path)), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            byte[] hash = sha.ComputeHash(fs);
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }

    // -------------------------------------------------------------- extraction

    // A staged entry sits at roughly the same depth as the final one, so a deep
    // install can push it past MAX_PATH. Such a path must carry the extended
    // prefix, which the convenience helpers cannot emit, so entries are expanded
    // here rather than through ZipFile.ExtractToDirectory.
    private static string LongPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        // Only a path that actually needs the extended form gets the prefix. A
        // short path works either way, and leaving it unprefixed keeps the
        // operation valid even on a runtime where the switches did not apply.
        if (path.Length < 248) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static void ExtractZip(string zipPath, string destDir)
    {
        Directory.CreateDirectory(LongPath(Path.GetFullPath(destDir)));
        int files = 0;
        using (ZipArchive archive = ZipFile.OpenRead(zipPath))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                // A tar-written archive prefixes every member with "./"; strip it
                // so either writer produces the same layout.
                string name = entry.FullName.Replace('\\', '/');
                while (name.StartsWith("./", StringComparison.Ordinal)) name = name.Substring(2);
                if (name.Length == 0) continue;
                if (name.IndexOf("..", StringComparison.Ordinal) >= 0) continue;

                string target = Path.Combine(destDir, name.Replace('/', Path.DirectorySeparatorChar));

                if (entry.Name.Length == 0)
                {
                    Directory.CreateDirectory(LongPath(Path.GetFullPath(target)));
                    continue;
                }

                string parent = Path.GetDirectoryName(target);
                if (parent != null && parent.Length > 0)
                {
                    Directory.CreateDirectory(LongPath(Path.GetFullPath(parent)));
                }
                using (Stream source = entry.Open())
                using (FileStream target2 = new FileStream(LongPath(Path.GetFullPath(target)), FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    source.CopyTo(target2);
                }
                files++;
            }
        }
        Console.Error.WriteLine("dsh: expanded {0:N0} files", files);
    }

    // ------------------------------------------------------------- the swap
    // The swap is a batch script rather than code in this process because the
    // install directory cannot be renamed while dsh.exe inside it is running.
    // The script waits for this process and the launching process to exit, then
    // renames the old tree aside, moves the staged tree into place, and puts the
    // old tree back if that move fails.

    private static string WriteApplyScript(string parentDir, int selfPid, int launchPid, string root, string staging, bool relaunch)
    {
        string oldDir = root + ".old-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        string script = Path.Combine(parentDir, "_dsh-apply-" + selfPid.ToString(CultureInfo.InvariantCulture) + ".cmd");
        string log = Path.Combine(parentDir, "_dsh-apply-" + selfPid.ToString(CultureInfo.InvariantCulture) + ".log");

        StringBuilder sb = new StringBuilder();
        sb.AppendLine("@echo off");
        sb.AppendLine("setlocal enableextensions");
        sb.AppendLine("set \"ROOT=" + root + "\"");
        sb.AppendLine("set \"NEW=" + staging + "\"");
        sb.AppendLine("set \"OLD=" + oldDir + "\"");
        sb.AppendLine("set \"LOG=" + log + "\"");
        sb.AppendLine("call :wait " + selfPid.ToString(CultureInfo.InvariantCulture));
        if (launchPid > 0) sb.AppendLine("call :wait " + launchPid.ToString(CultureInfo.InvariantCulture));
        sb.AppendLine("move \"%ROOT%\" \"%OLD%\" >>\"%LOG%\" 2>&1");
        sb.AppendLine("if errorlevel 1 exit /b 1");
        sb.AppendLine("move \"%NEW%\" \"%ROOT%\" >>\"%LOG%\" 2>&1");
        sb.AppendLine("if errorlevel 1 (");
        sb.AppendLine("  move \"%OLD%\" \"%ROOT%\" >>\"%LOG%\" 2>&1");
        sb.AppendLine("  exit /b 1");
        sb.AppendLine(")");
        sb.AppendLine("rmdir /s /q \"%OLD%\" >nul 2>&1");
        if (relaunch) sb.AppendLine("start \"\" \"%ROOT%\\dsh.exe\"");
        sb.AppendLine("exit /b 0");
        sb.AppendLine(":wait");
        sb.AppendLine("setlocal");
        sb.AppendLine("set \"P=%~1\"");
        sb.AppendLine(":spin");
        sb.AppendLine("tasklist /FI \"PID eq %P%\" /NH 2>nul | findstr /C:\"%P%\" >nul");
        sb.AppendLine("if not errorlevel 1 (");
        sb.AppendLine("  ping -n 2 127.0.0.1 >nul");
        sb.AppendLine("  goto spin");
        sb.AppendLine(")");
        sb.AppendLine("endlocal");
        sb.AppendLine("exit /b 0");

        File.WriteAllText(script, sb.ToString(), new UTF8Encoding(false));
        return script;
    }

    private static void LaunchDetached(string script, string arguments, string workDir)
    {
        System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo();
        psi.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        psi.Arguments = "/c \"\"" + script + "\" " + arguments + "\"";
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = workDir;
        System.Diagnostics.Process.Start(psi);
    }

    // ---------------------------------------------------------------- staging

    // Staging lives beside the install so the final move is a rename on the same
    // volume, and so the staged entries sit at the same path depth as the ones
    // they replace. A staging folder in %TEMP% would add depth and could push an
    // entry past MAX_PATH.
    internal static int StageAndSwap(string root, string zipPath, int launchPid, bool relaunch, bool quiet)
    {
        string parent = Path.GetDirectoryName(root.TrimEnd(Path.DirectorySeparatorChar));
        if (parent == null || parent.Length == 0)
        {
            Console.Error.WriteLine("dsh: cannot determine the install parent directory");
            return 2;
        }

        string staging = Path.Combine(parent, "_dsh-new");
        if (Directory.Exists(staging))
        {
            try { Directory.Delete(staging, true); }
            catch (Exception ex)
            {
                Console.Error.WriteLine("dsh: stale staging folder could not be removed: " + ex.Message);
                return 2;
            }
        }

        try
        {
            ExtractZip(zipPath, staging);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("dsh: could not expand the update: " + ex.Message);
            return 2;
        }

        // A staged tree that cannot even report its version is not installed over
        // a working one.
        string stagedExe = Path.Combine(staging, "dsh.exe");
        if (!File.Exists(stagedExe))
        {
            Console.Error.WriteLine("dsh: the downloaded archive does not contain dsh.exe");
            return 2;
        }

        int selfPid = System.Diagnostics.Process.GetCurrentProcess().Id;
        string script = WriteApplyScript(parent, selfPid, launchPid, root, staging, relaunch);
        LaunchDetached(script, "", parent);

        if (!quiet)
        {
            Console.Error.WriteLine("dsh: staged at " + staging);
            Console.Error.WriteLine("dsh: the swap runs once this process exits; the log is beside the install");
        }
        return 0;
    }

    // ---------------------------------------------------------------- state

    private static Dictionary<string, object> ReadState()
    {
        return ReadJsonObject(Path.Combine(HomeDir(), "update-state.json"));
    }

    private static void WriteState(string lastCheckUtc, string offered)
    {
        try
        {
            string dir = HomeDir();
            Directory.CreateDirectory(dir);
            Dictionary<string, object> state = new Dictionary<string, object>();
            state["lastCheckUtc"] = lastCheckUtc;
            state["offeredVersion"] = offered;
            File.WriteAllText(
                Path.Combine(dir, "update-state.json"),
                new JavaScriptSerializer().Serialize(state),
                new UTF8Encoding(false));
        }
        catch
        {
            // State is an optimisation; failing to record it must not matter.
        }
    }

    private static bool RateLimited(Settings s)
    {
        if (s.CheckIntervalHours <= 0) return false;
        Dictionary<string, object> state = ReadState();
        string last = Str(state, "lastCheckUtc");
        if (last == null) return false;
        DateTime parsed;
        if (!DateTime.TryParse(last, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out parsed))
        {
            return false;
        }
        return DateTime.UtcNow - parsed < TimeSpan.FromHours(s.CheckIntervalHours);
    }

    // ------------------------------------------------------------- commands

    // Returns -1 when this is an ordinary launch, otherwise the process exit code.
    internal static int TryHandle(string[] args, string root)
    {
        bool check = false;
        bool apply = false;
        bool list = false;
        bool json = false;
        bool force = false;
        bool prerelease = false;
        bool relaunch = false;
        bool quiet = false;
        bool noVerify = false;
        bool auto = false;
        int launchPid = 0;

        // The detached worker is started without inherited handles so that a
        // caller capturing this process's output is not held open by a child
        // that is still working. It therefore writes its own log instead.
        foreach (string a in args)
        {
            if (a == "--auto-check") { RedirectToLog(); break; }
        }

        foreach (string a in args)
        {
            switch (a)
            {
                case "--check-update":
                case "--check-updates": check = true; break;
                case "--auto-check": auto = true; break;
                case "--self-update":
                case "--update-now": apply = true; break;
                case "--update-list":
                case "--list-updates": list = true; break;
                case "--json": json = true; break;
                case "--force": force = true; break;
                case "--prerelease": prerelease = true; break;
                case "--relaunch": relaunch = true; break;
                case "--quiet": quiet = true; break;
                case "--no-verify": noVerify = true; break;
                case "--yes": break;
                default:
                    if (a.StartsWith("--wait-pid=", StringComparison.Ordinal))
                    {
                        int.TryParse(a.Substring(11), NumberStyles.Integer, CultureInfo.InvariantCulture, out launchPid);
                    }
                    break;
            }
        }

        if (!check && !apply && !list && !auto) return -1;

        Settings s = LoadSettings(root);
        if (prerelease) s.Prerelease = true;
        int[] local = LocalVersion(root);

        try
        {
            List<Release> releases = FetchReleases(s, root);

            if (list)
            {
                foreach (Release r in releases)
                {
                    if (r.Draft) continue;
                    Console.WriteLine("{0,-24} {1,-10} {2}",
                        r.Version,
                        r.Prerelease ? "prerelease" : "release",
                        r.AssetName == null ? "(no asset)" : r.AssetName);
                }
                return 0;
            }

            Release latest = PickNewest(releases, s, local, force);

            if (check)
            {
                if (json)
                {
                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["installed"] = VersionText(local);
                    payload["updateAvailable"] = latest != null;
                    payload["latest"] = latest == null ? null : latest.Version;
                    payload["asset"] = latest == null ? null : latest.AssetName;
                    payload["size"] = latest == null ? 0L : latest.AssetSize;
                    payload["sha256"] = latest == null ? null : latest.AssetSha256;
                    payload["url"] = latest == null ? null : latest.HtmlUrl;
                    Console.WriteLine(new JavaScriptSerializer().Serialize(payload));
                }
                else if (latest == null)
                {
                    Console.WriteLine("dsh {0} is up to date.", VersionText(local));
                }
                else
                {
                    Console.WriteLine("dsh {0} is installed; {1} is available.", VersionText(local), latest.Version);
                    if (latest.AssetSize > 0)
                    {
                        Console.WriteLine("  asset : {0} ({1:N1} MB)", latest.AssetName, latest.AssetSize / 1048576.0);
                    }
                    if (latest.HtmlUrl != null) Console.WriteLine("  notes : {0}", latest.HtmlUrl);
                    Console.WriteLine("  run `dsh.exe --self-update` to install it.");
                }
                // The check completed, so the exit status is success either way;
                // `updateAvailable` in the JSON is the machine-readable signal.
                return 0;
            }

            // --auto-check: the detached worker. It re-runs the decision the
            // launch path only scheduled, then installs the release when the
            // operator has left automatic updates on.
            if (auto)
            {
                WriteState(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                           latest == null ? null : latest.Version);
                if (latest == null || !s.AutoUpdate) return 0;
            }

            // --self-update
            if (latest == null)
            {
                if (!quiet) Console.Error.WriteLine("dsh {0} is already up to date.", VersionText(local));
                return 1;
            }

            if (!quiet)
            {
                Console.Error.WriteLine("dsh: updating {0} -> {1}", VersionText(local), latest.Version);
            }

            string temp = Path.Combine(Path.GetTempPath(), "dsh-download-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture));
            Directory.CreateDirectory(temp);
            string zipPath = Path.Combine(temp, latest.AssetName == null ? AssetName : latest.AssetName);

            try
            {
                Download(latest.AssetUrl, zipPath, quiet);

                if (!noVerify)
                {
                    if (latest.AssetSha256 == null)
                    {
                        Console.Error.WriteLine("dsh: the release publishes no sha256 for this asset; refusing to install it.");
                        Console.Error.WriteLine("dsh: re-run with --no-verify to accept the download unverified.");
                        return 2;
                    }
                    string actual = Sha256File(zipPath);
                    if (!string.Equals(actual, latest.AssetSha256, StringComparison.OrdinalIgnoreCase))
                    {
                        Console.Error.WriteLine("dsh: sha256 mismatch, nothing was changed.");
                        Console.Error.WriteLine("dsh:   expected {0}", latest.AssetSha256);
                        Console.Error.WriteLine("dsh:   actual   {0}", actual);
                        return 2;
                    }
                    if (!quiet) Console.Error.WriteLine("dsh: sha256 verified");
                }

                return StageAndSwap(root, zipPath, launchPid, relaunch, quiet);
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch { }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("dsh: update failed: " + ex.Message);
            return 2;
        }
    }

    // ------------------------------------------------- automatic check on launch
    // Called before the harness starts. It must never delay or break a launch, so
    // every failure is swallowed and the network work is bounded by the request
    // timeouts above. When an update is available and autoUpdate is on, the actual
    // work is handed to a detached process so this run is not held up.

    internal static void MaybeAutoUpdate(string root)
    {
        try
        {
            string off = Environment.GetEnvironmentVariable("DSH_NO_UPDATE_CHECK");
            if (off != null && off.Length > 0 && off != "0") return;

            Settings s = LoadSettings(root);
            if (!s.AutoCheck) return;
            if (RateLimited(s)) return;

            // A manifest that cannot be read leaves nothing to compare against.
            // Treating it as version zero would make every published release
            // look like an upgrade, so this install is left alone.
            if (ReadJsonObject(Path.Combine(root, "manifest.json")) == null) return;

            // The decision to look is made here because it costs one file read;
            // the look itself is handed to a detached child. A launch must never
            // wait on the network, and this call sits on the launch path.
            string exe = Path.Combine(root, "dsh.exe");
            if (!File.Exists(exe)) return;

            // UseShellExecute puts the worker on its own console. With it
            // false the child would inherit this process's standard handles,
            // and a caller that captured our output keeps reading until every
            // writer closes -- so a worker still running its check would make
            // the launch look hung. The worker logs to a file of its own.
            System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = "--auto-check --yes --quiet --wait-pid="
                + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            psi.UseShellExecute = true;
            psi.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
            psi.WorkingDirectory = root;
            System.Diagnostics.Process.Start(psi);
        }
        catch
        {
            // An update check is never allowed to be the reason a launch fails.
        }
    }
}
