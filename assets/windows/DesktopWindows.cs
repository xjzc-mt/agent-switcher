using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Xml;
using Microsoft.Win32.SafeHandles;

// Only verified desktop roots receive WM_CLOSE. Descendants are wait-only.
internal static class DesktopWindows {
    private delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern SafeWaitHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(SafeWaitHandle handle, out long created, out long ended, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool QueryFullProcessImageName(SafeWaitHandle handle, uint flags, StringBuilder file, ref int capacity);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct ProcessEntry {
        public int Size, Usage, Pid;
        public IntPtr Heap;
        public int Module, Threads, Parent, Priority, Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
    }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern SafeWaitHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool Process32FirstW(SafeWaitHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool Process32NextW(SafeWaitHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool ProcessIdToSessionId(int pid, out int session);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(SafeWaitHandle process, uint access, out SafeWaitHandle token);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool GetTokenInformation(SafeWaitHandle token, int type, IntPtr data, int size, out int written);

    private static long CreationTime(SafeWaitHandle process) {
        long born, ended, kernel, user;
        return !process.IsInvalid && GetProcessTimes(process, out born, out ended, out kernel, out user) ? born : 0;
    }

    // Some sandbox children and the System process deny OpenProcess. A kernel snapshot
    // still supplies their session and exact creation time, without granting access.
    [StructLayout(LayoutKind.Sequential)]
    private struct SystemProcess {
        public int Next, Threads;
        public long PrivatePages, FaultsAndThreads, Cycles, Created, UserTime, KernelTime;
        public ushort NameLength, NameCapacity;
        public IntPtr Name;
        public int Priority;
        public IntPtr Pid, Parent;
        public int Handles, Session;
    }
    [DllImport("ntdll.dll")] private static extern uint NtQuerySystemInformation(int kind, IntPtr data, int size, out int used);
    private static Dictionary<int, SystemProcess> KernelTimes() {
        int header = Marshal.SizeOf(typeof(SystemProcess));
        for (int size = 256 * 1024; size <= 64 * 1024 * 1024;) {
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                int used;
                uint status = NtQuerySystemInformation(5, data, size, out used); // SystemProcessInformation
                if (status == 0xc0000004) { size = checked(Math.Max(size * 2, used)); continue; }
                if (status != 0 || used < header || used > size) throw new InvalidOperationException();
                var result = new Dictionary<int, SystemProcess>();
                for (int offset = 0;;) {
                    var row = (SystemProcess)Marshal.PtrToStructure(IntPtr.Add(data, offset), typeof(SystemProcess));
                    result.Add(row.Pid.ToInt32(), row);
                    if (row.Next == 0) break;
                    if (row.Next < header || row.Next > used - header - offset) throw new InvalidOperationException();
                    offset += row.Next;
                }
                // Confirm the ABI against the public API before trusting any otherwise inaccessible time.
                using (Process self = Process.GetCurrentProcess())
                using (var own = OpenProcess(0x1000, false, self.Id)) {
                    SystemProcess row;
                    if (!result.TryGetValue(self.Id, out row) || row.Created <= 0 || row.Created != CreationTime(own))
                        throw new InvalidOperationException();
                }
                return result;
            } finally { Marshal.FreeHGlobal(data); }
        }
        throw new InvalidOperationException();
    }
    private static SecurityIdentifier Owner(SafeWaitHandle process, IntPtr buffer, int size) {
        SafeWaitHandle token;
        if (!OpenProcessToken(process, 8, out token)) return null; // TOKEN_QUERY
        using (token) {
            int used;
            return GetTokenInformation(token, 1, buffer, size, out used)
                ? new SecurityIdentifier(Marshal.ReadIntPtr(buffer)) : null;
        }
    }
    private static string JsonString(string value) {
        if (value == null) return "null";
        var text = new StringBuilder("\"");
        foreach (char ch in value) {
            if (ch < 32) text.Append("\\u").Append(((int)ch).ToString("x4"));
            else {
                if (ch == '\\' || ch == '\"') text.Append('\\');
                text.Append(ch);
            }
        }
        return text.Append('"').ToString();
    }
    private static void Processes(string[] args) {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < args.Length; i++) names.Add(args[i]);
        var rows = new List<string>();
        Dictionary<int, SystemProcess> restricted = null;
        using (var self = Process.GetCurrentProcess())
        using (var user = WindowsIdentity.GetCurrent())
        using (var snapshot = CreateToolhelp32Snapshot(2, 0)) { // TH32CS_SNAPPROCESS
            int session;
            if (snapshot.IsInvalid || !ProcessIdToSessionId(self.Id, out session)) throw new Win32Exception();
            var sid = user.User;
            if (sid == null) throw new InvalidOperationException();
            int size = 2 * IntPtr.Size + SecurityIdentifier.MaxBinaryLength;
            IntPtr tokenUser = Marshal.AllocHGlobal(size);
            try {
                var entry = new ProcessEntry { Size = Marshal.SizeOf(typeof(ProcessEntry)) };
                var file = new StringBuilder(32768);
                if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
                do {
                    if (entry.Pid <= 4 || (names.Count != 0 && !names.Contains(entry.Name))) continue;
                    int targetSession;
                    bool hasSession = ProcessIdToSessionId(entry.Pid, out targetSession);
                    if (hasSession && session != targetSession) continue;
                    using (var handle = OpenProcess(0x1000, false, entry.Pid)) {
                        if (handle.IsInvalid && Marshal.GetLastWin32Error() == 87) continue; // exited
                        long born = CreationTime(handle);
                        if (!hasSession || born == 0) {
                            if (restricted == null) restricted = KernelTimes();
                            SystemProcess peer;
                            if (!restricted.TryGetValue(entry.Pid, out peer)) continue; // exited since Toolhelp snapshot
                            if (peer.Session != session || peer.Parent.ToInt64() != entry.Parent || (born != 0 && born != peer.Created)) continue;
                            born = peer.Created;
                        }
                        var owner = handle.IsInvalid ? null : Owner(handle, tokenUser, size);
                        if (owner != null && !sid.Equals(owner)) continue;
                        int capacity = file.Capacity;
                        file.Length = 0;
                        string full = !handle.IsInvalid && QueryFullProcessImageName(handle, 0, file, ref capacity) ? file.ToString() : null;
                        if (full != null && !String.Equals(entry.Name, Path.GetFileName(full), StringComparison.OrdinalIgnoreCase)) continue;
                        rows.Add(String.Format(CultureInfo.InvariantCulture,
                            "{{\"pid\":{0},\"parent\":{1},\"name\":{2},\"file\":{3},\"created\":\"{4}\",\"ownerKnown\":{5}}}",
                            entry.Pid, entry.Parent, JsonString(entry.Name), JsonString(full),
                            born > 0 ? born.ToString(CultureInfo.InvariantCulture) : "", owner != null ? "true" : "false"));
                    }
                } while (Process32NextW(snapshot, ref entry));
                if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception(); // ERROR_NO_MORE_FILES
            } finally { Marshal.FreeHGlobal(tokenUser); }
        }
        Console.Write("[" + String.Join(",", rows) + "]");
    }
    private static void Boot() {
        using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters"))
        using (var system = OpenProcess(0x1000, false, 4)) {
            object id = key == null ? null : key.GetValue("BootId");
            if (!(id is int) || (int)id == 0) return;
            long born = CreationTime(system);
            SystemProcess row;
            if (born == 0 && KernelTimes().TryGetValue(4, out row) && row.Session == 0) born = row.Created;
            if (born > 0) Console.Write(String.Format(CultureInfo.InvariantCulture, "{0}:{1}", unchecked((uint)(int)id), born));
        }
    }

    [DllImport("kernel32.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
    private static extern int GetPackagePathByFullName(string name, ref int length, StringBuilder output);
    private static int Manifest(string file) {
        string root = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(file)));
        int length = 32768;
        var installed = new StringBuilder(length);
        try {
            int registration = GetPackagePathByFullName(Path.GetFileName(root), ref length, installed);
            // Missing/invalid package identity is conclusive. Only an unavailable registry lookup permits fallback.
            if (registration == 2 || registration == 3 || registration == 87 || registration == 1168 ||
                registration == 15601 || registration == 15700) return 0;
            if (registration != 0) return 3;
            if (!String.Equals(root, installed.ToString(), StringComparison.OrdinalIgnoreCase)) return 0;
            var document = new XmlDocument { XmlResolver = null };
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4 * 1024 * 1024 };
            using (var stream = File.OpenRead(Path.Combine(root, "AppxManifest.xml")))
            using (var reader = XmlReader.Create(stream, settings)) document.Load(reader);
            var prefixes = new XmlNamespaceManager(document.NameTable);
            prefixes.AddNamespace("p", "http://schemas.microsoft.com/appx/manifest/foundation/windows10");
            var apps = document.SelectNodes("/p:Package/p:Applications/p:Application", prefixes);
            XmlElement match = null;
            foreach (XmlElement app in apps) {
                string executable = app.GetAttribute("Executable");
                if (executable.Length == 0 || Path.IsPathRooted(executable) ||
                    !String.Equals(Path.GetFullPath(Path.Combine(root, executable)), file, StringComparison.OrdinalIgnoreCase)) continue;
                if (match != null) return 0;
                match = app;
            }
            if (match == null && apps.Count == 1) match = (XmlElement)apps[0]; // Some packages launch Electron via a bootstrapper.
            if (match != null) Console.Write(match.GetAttribute("Id"));
            return 0;
        } catch (XmlException) { return 0; }
        catch (IOException) { return 3; }
        catch (UnauthorizedAccessException) { return 3; }
        catch (EntryPointNotFoundException) { return 3; }
    }

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct TrustFile {
        public int Size; public string Path; public IntPtr Handle, Subject;
    }
    [StructLayout(LayoutKind.Sequential)] private struct TrustData {
        public int Size; public IntPtr Policy, Sip;
        public int Ui, Revoke, Choice; public IntPtr File;
        public int Action; public IntPtr State, Url; public int Flags, Context; public IntPtr SignatureSettings;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProviderCert { public int Size; public IntPtr Certificate; }
    [DllImport("wintrust.dll", ExactSpelling=true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", ExactSpelling=true)] private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll", ExactSpelling=true)] private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data, int index, bool counterSigner, int counterIndex);
    [DllImport("wintrust.dll", ExactSpelling=true)] private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, int index);
    private static void Publisher(string path) {
        Guid policy = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
        var file = new TrustFile { Size = Marshal.SizeOf(typeof(TrustFile)), Path = path };
        IntPtr buffer = Marshal.AllocHGlobal(file.Size);
        Marshal.StructureToPtr(file, buffer, false);
        var trust = new TrustData { Size = Marshal.SizeOf(typeof(TrustData)), Ui = 2, Revoke = 1, Choice = 1, File = buffer, Action = 1 };
        try {
            if (WinVerifyTrust(new IntPtr(-1), ref policy, ref trust) != 0) return;
            IntPtr data = WTHelperProvDataFromStateData(trust.State);
            IntPtr signer = data == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(data, 0, false, 0);
            IntPtr cert = signer == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer, 0);
            if (cert == IntPtr.Zero) return;
            var leaf = (ProviderCert)Marshal.PtrToStructure(cert, typeof(ProviderCert));
            if (leaf.Certificate == IntPtr.Zero) return;
            using (var verified = new X509Certificate2(leaf.Certificate)) Console.Write(verified.GetNameInfo(X509NameType.SimpleName, false));
        } finally {
            trust.Action = 2; // WTD_STATEACTION_CLOSE releases the provider chain.
            WinVerifyTrust(new IntPtr(-1), ref policy, ref trust);
            Marshal.DestroyStructure(buffer, typeof(TrustFile));
            Marshal.FreeHGlobal(buffer);
        }
    }

    // A missing PID or a new occupant means the original process has finished.
    private static SafeWaitHandle Pin(int pid, long expected) {
        SafeWaitHandle handle = OpenProcess(0x00101000, false, pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        try {
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                if (error != 87) throw new Win32Exception(error);
            } else if (WaitForSingleObject(handle, 0) != 0) {
                long born, ended, kernel, user;
                if (GetProcessTimes(handle, out born, out ended, out kernel, out user)) {
                    if (born == expected) return handle;
                } else {
                    int error = Marshal.GetLastWin32Error();
                    if (WaitForSingleObject(handle, 0) != 0) throw new Win32Exception(error);
                }
            }
        } catch { handle.Dispose(); throw; }
        handle.Dispose();
        return null;
    }

    public static int Main(string[] args) {
        var pinned = new Dictionary<int, SafeWaitHandle>();
        var roots = new HashSet<int>();
        var protectedChildren = new Dictionary<int, long>();
        try {
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length >= 1 && args[0] == "processes") { Processes(args); return 0; }
            if (args.Length == 1 && args[0] == "boot") { Boot(); return 0; }
            if (args.Length == 2 && args[0] == "publisher") { Publisher(args[1]); return 0; }
            if (args.Length == 2 && args[0] == "manifest") return Manifest(args[1]);
            if (args.Length == 2 && args[0] == "version") {
                Console.Write(FileVersionInfo.GetVersionInfo(args[1]).ProductVersion);
                return 0;
            }
            if (args.Length < 2) return 1;
            for (int i = 1; i < args.Length; i++) {
                string[] parts = args[i].Split(':');
                bool window = parts[0] == "window"; int pid; long created;
                if (parts.Length != 3 || (!window && parts[0] != "wait") || !Int32.TryParse(parts[1], out pid) ||
                    pid <= 0 || !Int64.TryParse(parts[2], out created) || created <= 0) return 1;
                SafeWaitHandle handle;
                try { handle = Pin(pid, created); }
                catch (Win32Exception e) {
                    if (window && e.NativeErrorCode == 5) return 5;
                    if (window || e.NativeErrorCode != 5) return 2;
                    protectedChildren.Add(pid, created); continue;
                }
                if (handle == null) continue;
                pinned.Add(pid, handle);
                if (window) {
                    int size = 32768; var file = new StringBuilder(size);
                    if (!QueryFullProcessImageName(handle, 0, file, ref size)) {
                        if (WaitForSingleObject(handle, 0) == 0) continue;
                        return 2;
                    }
                    if (!String.Equals(file.ToString(), args[0], StringComparison.OrdinalIgnoreCase)) return 2;
                    roots.Add(pid);
                }
            }
            if (roots.Count == 0) return 4;
            int sent = 0;
            bool denied = false;
            if (!EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
                int pid; GetWindowThreadProcessId(hwnd, out pid);
                if (roots.Contains(pid) && WaitForSingleObject(pinned[pid], 0) == 258 && GetWindow(hwnd, 4) == IntPtr.Zero) {
                    var name = new StringBuilder(80); GetClassName(hwnd, name, name.Capacity);
                    if (name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) {
                        if (PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero)) sent++;
                        else if (Marshal.GetLastWin32Error() == 5) denied = true;
                    }
                }
                return true;
            }, IntPtr.Zero)) return sent > 0 ? 3 : 2;
            if (sent == 0) return denied ? 5 : 4;
            var watch = Stopwatch.StartNew();
            foreach (var handle in pinned.Values)
                if (WaitForSingleObject(handle, (uint)Math.Max(0, 8000 - watch.ElapsedMilliseconds)) != 0) return 3;
            // A sandbox may temporarily deny even the minimum handle. Its parent
            // has been closed; only confirm exit/PID replacement, never signal it.
            foreach (var child in protectedChildren) {
                for (;;) {
                    try {
                        using (var handle = Pin(child.Key, child.Value)) {
                            if (handle == null || WaitForSingleObject(handle, (uint)Math.Max(0, 8000 - watch.ElapsedMilliseconds)) == 0) break;
                        }
                    } catch (Win32Exception e) { if (e.NativeErrorCode != 5) return 3; }
                    if (watch.ElapsedMilliseconds >= 8000) return 3;
                    Thread.Sleep(50);
                }
            }
            return 0;
        } catch { return 1; }
        finally { foreach (var handle in pinned.Values) handle.Dispose(); }
    }
}
