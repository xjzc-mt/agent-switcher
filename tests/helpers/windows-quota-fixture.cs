// Compiled only by the native Windows test, alongside its randomly named WinCred fixture.
public static partial class AntigravityCredential {
    public static bool WriteFixtureCredential() {
        var pin = GCHandle.Alloc(new byte[] { 42 }, GCHandleType.Pinned);
        try {
            var c = new Credential { Type = Generic, TargetName = Target, User = "fixture",
                Size = 1, Blob = pin.AddrOfPinnedObject(), Persist = 2 };
            return CredWriteW(ref c, 0);
        } finally { pin.Free(); }
    }
}

public static class FixtureQuotaCli {
    static void CheckPrivate(string file) {
        try { File.ReadAllBytes(file); throw new InvalidOperationException("cross-profile read"); }
        catch (UnauthorizedAccessException) { }
        try { using (File.Open(file, FileMode.Open, FileAccess.Write)) { } throw new InvalidOperationException("cross-profile write"); }
        catch (UnauthorizedAccessException) { }
    }
    static void QueryLocalProxy() {
        var proxy = new Uri(Environment.GetEnvironmentVariable("HTTPS_PROXY"));
        if (proxy.Host != "127.0.0.1") throw new InvalidOperationException("fixture proxy required");
        using (var socket = new System.Net.Sockets.TcpClient(proxy.Host, proxy.Port)) {
            var stream = socket.GetStream(); stream.ReadTimeout = 5000;
            byte[] request = Encoding.ASCII.GetBytes("GET http://ags-fixture.invalid/quota HTTP/1.0\r\n\r\n");
            stream.Write(request, 0, request.Length);
            if (!new StreamReader(stream).ReadToEnd().EndsWith("fixture-quota", StringComparison.Ordinal))
                throw new InvalidOperationException("unexpected proxy response");
        }
    }
    public static int Main(string[] args) {
        try { return Run(args); }
        catch (Exception e) { Console.Error.WriteLine("Synthetic quota fixture: " + e.Message); return 1; }
    }
    static int Run(string[] args) {
        string mode = args[0];
        if (mode == "create" || mode == "read" || mode == "replace") return AntigravityCredential.FixtureCommand(args);
        if (mode == "write-canary") return AntigravityCredential.WriteFixtureCredential() ? 0 : 1;
        if (mode == "image") {
            Console.WriteLine(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName); return 0;
        }
        if (mode == "acp") {
            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (home != Environment.CurrentDirectory || home != Environment.GetEnvironmentVariable("HOME") ||
                !Path.GetFullPath(Environment.GetEnvironmentVariable("TEMP")).StartsWith(home + Path.DirectorySeparatorChar) ||
                String.IsNullOrEmpty(Environment.GetEnvironmentVariable("SSH_CONNECTION"))) return 20;
            for (int i = 2; i < args.Length; i++) CheckPrivate(args[i]);
            if (args[1] == "check") {
                try { if (AntigravityCredential.Read()[0] != null) return 22; } catch (Win32Exception) { }
                if (AntigravityCredential.WriteFixtureCredential()) return 25;
            }
            QueryLocalProxy();
            string file = Path.Combine(home, "fixture-auth");
            if (File.ReadAllText(file) != "exported" || Console.ReadLine() != "{\"id\":1}") return 23;
            File.WriteAllText(file, "renewed");
            Console.WriteLine("{\"id\":1,\"result\":{}}"); return 0;
        }
        if (mode == "-p" && args[1] == "/usage") {
            if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("SSH_CONNECTION"))) return 24;
            Console.WriteLine("{\"status\":\"SUCCESS\",\"command\":{\"name\":\"usage\"}}"); return 0;
        }
        if (mode == "wait-stop") {
            Console.WriteLine("waiting"); Console.Out.Flush(); System.Threading.Thread.Sleep(30000); return 0;
        }
        if (mode == "worker") { System.Threading.Thread.Sleep(30000); return 0; }
        var start = new System.Diagnostics.ProcessStartInfo(
            System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName, "worker");
        start.UseShellExecute = false; start.CreateNoWindow = true;
        using (var worker = System.Diagnostics.Process.Start(start))
            Console.Error.WriteLine("fixture query failed with child " + worker.Id);
        return 5;
    }
}
