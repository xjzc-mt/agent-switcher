using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Compiled by the Windows .NET Framework C# compiler. No credential is passed to this helper.
internal static class QuotaProcess {
    [StructLayout(LayoutKind.Sequential)] struct SidAttr { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct GenericMapping { public uint Read, Write, Execute, All; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
        public uint ProcessLimit; public UIntPtr Affinity; public uint Priority, Schedule;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct JobAccounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint Faults, Processes, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int Size; public IntPtr Reserved, Desktop, Title; public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
        public ushort Show, Reserved2; public IntPtr Buffer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("shell32.dll", ExactSpelling=true)] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string path, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(SafeFileHandle token, int level, out SafeFileHandle impersonation);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AccessCheck(byte[] descriptor, SafeFileHandle token, uint access,
        ref GenericMapping mapping, IntPtr privileges, ref uint size, out uint granted, out bool allowed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(SafeFileHandle token, int kind, IntPtr data, int size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictedCount, IntPtr restricted, out SafeFileHandle result);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeFileHandle CreateJobObject(IntPtr security, IntPtr name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref JobLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out JobAccounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr process, IntPtr original, IntPtr target, out SafeFileHandle handle, uint access, bool inherit, int options);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processAcl, IntPtr threadAcl, bool inherit, uint flags, IntPtr env, string cwd, ref ExtendedStartup startup, out ProcessInfo info);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(SafeFileHandle token, string exe, StringBuilder command, IntPtr processAcl, IntPtr threadAcl, bool inherit, uint flags, IntPtr env, string cwd, ref ExtendedStartup startup, out ProcessInfo info);

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static int Size<T>() { return Marshal.SizeOf(typeof(T)); }

    sealed class Memory : IDisposable {
        readonly List<IntPtr> blocks = new List<IntPtr>();
        public IntPtr Alloc(int size) { IntPtr p = Marshal.AllocHGlobal(size); blocks.Add(p); return p; }
        public IntPtr Struct<T>(T value) { IntPtr p = Alloc(Size<T>()); Marshal.StructureToPtr(value, p, false); return p; }
        public IntPtr Sid(SecurityIdentifier value) {
            byte[] bytes = new byte[value.BinaryLength]; value.GetBinaryForm(bytes, 0);
            IntPtr p = Alloc(bytes.Length); Marshal.Copy(bytes, 0, p, bytes.Length); return p;
        }
        public IntPtr Handles(params IntPtr[] handles) {
            IntPtr p = Alloc(handles.Length * IntPtr.Size); Marshal.Copy(handles, 0, p, handles.Length); return p;
        }
        public void Dispose() { foreach (IntPtr p in blocks) Marshal.FreeHGlobal(p); }
    }
    static void Attribute(IntPtr list, int key, IntPtr value, int size) {
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(key), value, new IntPtr(size), IntPtr.Zero, IntPtr.Zero));
    }
    static SafeFileHandle DuplicateStandard(int kind) {
        IntPtr h = GetStdHandle(kind), self = new IntPtr(-1);
        using (SafeFileHandle nul = h == IntPtr.Zero || h == new IntPtr(-1)
            ? CreateFile("NUL", kind == -10 ? 0x80000000U : 0x40000000U, 3, IntPtr.Zero, 3, 0, IntPtr.Zero) : null) {
            if (nul != null) { Check(!nul.IsInvalid); h = nul.DangerousGetHandle(); }
            SafeFileHandle copy; Check(DuplicateHandle(self, h, self, out copy, 0, true, 2)); return copy;
        }
    }
    static void CollectHome(string path, List<string> entries) {
        FileAttributes flags = File.GetAttributes(path);
        if ((flags & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        entries.Add(path);
        if ((flags & FileAttributes.Directory) != 0)
            foreach (string child in Directory.EnumerateFileSystemEntries(path)) CollectHome(child, entries);
        else using (SafeFileHandle file = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
            FileInformation info; Check(!file.IsInvalid); Check(GetFileInformationByHandle(file, out info));
            if (info.Links != 1 || (info.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        }
    }
    static void AuthorizeHome(string dir, SecurityIdentifier logon, SecurityIdentifier sid) {
        // Medium-integrity, protected files may have been seeded by AGS before launch.
        // Give the low-integrity query both the enabled logon SID and its unique restricting SID.
        List<string> entries = new List<string>(); CollectHome(dir, entries);
        IntPtr descriptor; Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)", 1, out descriptor, IntPtr.Zero));
        try {
            IntPtr sacl; bool present, defaulted; Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) && present);
            foreach (string entry in entries) {
                bool directory = Directory.Exists(entry);
                FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(entry) : File.GetAccessControl(entry);
                InheritanceFlags inherit = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
                foreach (SecurityIdentifier who in new [] { logon, sid })
                    acl.AddAccessRule(new FileSystemAccessRule(who, FileSystemRights.Modify, inherit, PropagationFlags.None, AccessControlType.Allow));
                if (directory) Directory.SetAccessControl(entry, (DirectorySecurity)acl);
                else File.SetAccessControl(entry, (FileSecurity)acl);
                uint error = SetNamedSecurityInfo(entry, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl); // LABEL_SECURITY_INFORMATION
                if (error != 0) throw new Win32Exception((int)error);
            }
        } finally { LocalFree(descriptor); }
    }
    static IntPtr TokenInfo(IntPtr token, int kind, Memory mem) {
        int size; GetTokenInformation(token, kind, IntPtr.Zero, 0, out size);
        Check(size >= 2 * IntPtr.Size); IntPtr data = mem.Alloc(size);
        Check(GetTokenInformation(token, kind, data, size, out size)); return data;
    }
    static SecurityIdentifier LogonSid(WindowsIdentity identity, Memory mem) {
        IntPtr data = TokenInfo(identity.Token, 28, mem); // TokenLogonSid uses TOKEN_GROUPS.
        if (Marshal.ReadInt32(data) != 1) throw new InvalidOperationException("Missing logon SID");
        return new SecurityIdentifier(Marshal.ReadIntPtr(data, IntPtr.Size));
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public long Created, Access, Written, Changed; public uint Attributes; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int type, out BasicInfo info, int size);

    static string FinalPath(SafeFileHandle handle) {
        var path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        Check(length > 0 && length < path.Capacity);
        string full = path.ToString();
        if (full.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + full.Substring(8);
        if (full.StartsWith(@"\\?\", StringComparison.Ordinal) && full.Length > 6 && full[5] == ':') return full.Substring(4);
        throw new IOException("Unsupported filesystem path");
    }
    static string FileStamp(FileStream file, bool cache) {
        FileInformation id; BasicInfo times;
        Check(GetFileInformationByHandle(file.SafeFileHandle, out id));
        Check(GetFileInformationByHandleEx(file.SafeFileHandle, 0, out times, Size<BasicInfo>()));
        if (cache && id.Links != 1) throw new IOException("Unexpected cache file");
        if (times.Changed == 0 || (id.IndexHigh | id.IndexLow) == 0) return ""; // Unstable IDs require a fresh SHA comparison.
        return String.Join("-", id.Volume, id.IndexHigh, id.IndexLow, file.Length, times.Written, times.Changed);
    }
    static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", ""); }
    static bool CanExecute(string path, SafeFileHandle token) {
        using (WindowsIdentity.Impersonate(token.DangerousGetHandle()))
        using (var file = CreateFile(path, 0xA0000000, 1, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (!file.IsInvalid) return true;
            int error = Marshal.GetLastWin32Error();
            if (error != 5) throw new Win32Exception(error);
            return false;
        }
    }
    static string CacheDirectory(WindowsIdentity user, SafeFileHandle token, Memory mem) {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        using (var handle = CreateFile(local, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            Check(!handle.IsInvalid); local = FinalPath(handle);
        }
        SafeFileHandle impersonation; Check(DuplicateToken(token, 1, out impersonation));
        using (impersonation) new HostAccess(impersonation, mem).CheckPath(local, onlyMutation: true);
        string path = Path.Combine(local, "AgentSwitcher-QuotaCLI");
        var acl = new DirectorySecurity();
        acl.SetOwner(user.User); acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new [] { user.User, new SecurityIdentifier("S-1-5-11"), new SecurityIdentifier("S-1-15-2-1") })
            acl.AddAccessRule(new FileSystemAccessRule(sid, sid.Equals(user.User) ? FileSystemRights.FullControl : FileSystemRights.ReadAndExecute,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(path, acl);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException();
        var actual = Directory.GetAccessControl(path);
        if (!actual.AreAccessRulesProtected)
            throw new UnauthorizedAccessException("Untrusted executable cache");
        // Windows can canonicalize ACE order and control flags between creation and reading.
        // Only the host user may change the directory or any executable which inherits this ACL.
        CheckCacheAcl(actual, user.User);
        return path;
    }
    static void CheckCacheAcl(FileSystemSecurity acl, SecurityIdentifier owner) {
        if (!owner.Equals(acl.GetOwner(typeof(SecurityIdentifier)))) throw new UnauthorizedAccessException();
        var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (rules.Count == 0) throw new UnauthorizedAccessException("Missing executable cache ACL");
        foreach (FileSystemAccessRule rule in rules) {
            if (rule.AccessControlType == AccessControlType.Allow && !owner.Equals(rule.IdentityReference) &&
                (rule.FileSystemRights & ~(FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize)) != 0)
                throw new UnauthorizedAccessException("Untrusted executable cache permissions");
        }
    }
    static FileStream LockCache(string name) {
        var wait = Stopwatch.StartNew();
        for (;;) try { return File.Open(name, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException error) {
            if ((error.HResult & 0xffff) != 32 || wait.ElapsedMilliseconds > 15000) throw;
            Thread.Sleep(50);
        }
    }
    static FileStream OpenCached(string path, WindowsIdentity user) {
        var file = File.OpenRead(path);
        try {
            if (!String.Equals(FinalPath(file.SafeFileHandle), path, StringComparison.OrdinalIgnoreCase)) throw new IOException("Redirected cache file");
            CheckCacheAcl(file.GetAccessControl(), user.User);
            return file;
        } catch { file.Dispose(); throw; }
    }
    static string CachedImage(string prefix, string digest, WindowsIdentity user, bool create) {
        string dir = prefix + "." + digest;
        if (create) Directory.CreateDirectory(dir);
        if (Directory.Exists(dir)) {
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException();
            CheckCacheAcl(Directory.GetAccessControl(dir), user.User);
        }
        return Path.Combine(dir, "agy.exe"); // Preserve the official program name and reserve the directory for this image.
    }
    // Hold the chosen image open without write/delete sharing until the job has drained.
    static FileStream Executable(string source, SafeFileHandle token, WindowsIdentity user, Memory mem) {
        var input = File.OpenRead(source);
        try {
            string path = FinalPath(input.SafeFileHandle);
            if (CanExecute(path, token)) return input;
            string dir = CacheDirectory(user, token, mem), slot;
            using (var sha = SHA256.Create()) slot = Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToUpperInvariant())));
            string prefix = Path.Combine(dir, slot), index = prefix + ".index", stamp = FileStamp(input, false);
            // Serialize cold copies and index publication across simultaneous AGS processes.
            using (LockCache(prefix + ".lock")) {
                string[] record = new string[0];
                if (File.Exists(index)) using (var saved = OpenCached(index, user)) {
                    FileStamp(saved, true);
                    if (saved.Length < 1024) using (var reader = new StreamReader(saved)) record = reader.ReadToEnd().Split('\n');
                }
                bool valid = record.Length == 3 && System.Text.RegularExpressions.Regex.IsMatch(record[1], @"\A[A-F0-9]{64}\z");
                string previous = valid ? CachedImage(prefix, record[1], user, false) : null;
                if (valid && stamp.Length != 0 && record[2].Length != 0 && stamp == record[0] && File.Exists(previous)) {
                    var hit = OpenCached(previous, user);
                    try {
                        if (FileStamp(hit, true) == record[2] && CanExecute(previous, token)) { input.Dispose(); return hit; }
                    } catch { hit.Dispose(); throw; }
                    hit.Dispose();
                }
                string digest;
                using (var sha = SHA256.Create()) digest = Hex(sha.ComputeHash(input));
                string target = CachedImage(prefix, digest, user, true), partial = prefix + ".partial";
                bool ready = false;
                if (File.Exists(target)) using (var candidate = OpenCached(target, user))
                using (var sha = SHA256.Create()) {
                    FileStamp(candidate, true);
                    ready = Hex(sha.ComputeHash(candidate)) == digest;
                }
                if (!ready) {
                    File.Delete(partial); input.Position = 0;
                    try {
                        using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                            input.CopyTo(output); output.Flush(true);
                        }
                        File.Delete(target); File.Move(partial, target);
                    } finally { File.Delete(partial); }
                }
                var result = OpenCached(target, user);
                try {
                    if (!CanExecute(target, token)) throw new UnauthorizedAccessException("Cache not executable by quota token");
                    File.Delete(index);
                    using (var output = new FileStream(index, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    using (var writer = new StreamWriter(output)) writer.Write(stamp + "\n" + digest + "\n" + FileStamp(result, true));
                    if (previous != null && previous != target) try {
                        File.Delete(previous); Directory.Delete(Path.GetDirectoryName(previous));
                    } catch (IOException) { /* A previous version can still be running. */ }
                    catch (UnauthorizedAccessException) { /* A mapped image may reject deletion. */ }
                    input.Dispose(); return result;
                } catch { result.Dispose(); throw; }
            }
        } catch { input.Dispose(); throw; }
    }
    static string Quote(string value) {
        StringBuilder s = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') s.Append('\\', slashes + 1);
            s.Append('\\', slashes).Append(c); slashes = 0;
        }
        return s.Append('\\', slashes * 2).Append('"').ToString();
    }
    static SecurityIdentifier NewQuerySid() {
        byte[] id = Guid.NewGuid().ToByteArray();
        return new SecurityIdentifier(String.Format(System.Globalization.CultureInfo.InvariantCulture, "S-1-5-21-{0}-{1}-{2}-{3}",
            BitConverter.ToUInt32(id, 0), BitConverter.ToUInt32(id, 4), BitConverter.ToUInt32(id, 8), BitConverter.ToUInt32(id, 12)));
    }
    static SafeFileHandle QuotaToken(WindowsIdentity user, SecurityIdentifier querySid, Memory mem) {
        IntPtr deny = mem.Struct(new SidAttr { Sid = mem.Sid(user.User) });
        // The second access check permits our private workspace and public Windows runtime resources.
        // Do not include Everyone, Users or the shared logon SID in the list of restricting SIDs.
        int stride = Size<SidAttr>(); IntPtr allow = mem.Alloc(2 * stride);
        Marshal.StructureToPtr(new SidAttr { Sid = mem.Sid(querySid) }, allow, false);
        var runtime = new SecurityIdentifier("S-1-15-2-1");
        Marshal.StructureToPtr(new SidAttr { Sid = mem.Sid(runtime) }, IntPtr.Add(allow, stride), false);
        SafeFileHandle token; Check(CreateRestrictedToken(user.Token, 1, 1, deny, 0, IntPtr.Zero, 2, allow, out token));
        try {
            IntPtr primary = token.DangerousGetHandle(), userInfo = TokenInfo(primary, 1, mem);
            if ((Marshal.ReadInt32(userInfo, IntPtr.Size) & 0x10) == 0) throw new UnauthorizedAccessException();
            // An already restricted AGS may yield only the intersection. Verify the resulting token itself.
            IntPtr groups = TokenInfo(primary, 11, mem); // TokenRestrictedSids
            if (Marshal.ReadInt32(groups) != 2) throw new UnauthorizedAccessException();
            var expected = new HashSet<SecurityIdentifier> { querySid, runtime };
            for (int i = 0; i < 2; i++)
                if (!expected.Remove(new SecurityIdentifier(Marshal.ReadIntPtr(groups, IntPtr.Size + i * stride)))) throw new UnauthorizedAccessException();
            var low = new SecurityIdentifier("S-1-16-4096");
            IntPtr label = mem.Alloc(stride + low.BinaryLength), labelSid = IntPtr.Add(label, stride);
            byte[] bytes = new byte[low.BinaryLength]; low.GetBinaryForm(bytes, 0); Marshal.Copy(bytes, 0, labelSid, bytes.Length);
            Marshal.StructureToPtr(new SidAttr { Sid = labelSid, Attributes = 0x20 }, label, false);
            Check(SetTokenInformation(token, 25, label, stride + low.BinaryLength)); // TokenIntegrityLevel
            CheckHostBoundaries(token, mem);
            return token;
        } catch { token.Dispose(); throw; }
    }
    sealed class HostAccess {
        readonly SafeFileHandle token; readonly IntPtr privileges;
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Dictionary<string, uint> rights = new Dictionary<string, uint>();
        int visited;
        public HostAccess(SafeFileHandle token, Memory mem) { this.token = token; privileges = mem.Alloc(256); }
        void CheckBudget(int queued) {
            if (visited + queued > 100000 || clock.ElapsedMilliseconds > 12000) throw new InvalidDataException("Host ACL check incomplete");
        }
        uint Access(FileSystemSecurity acl) {
            byte[] descriptor = acl.GetSecurityDescriptorBinaryForm();
            string key = Convert.ToBase64String(descriptor); uint granted;
            if (rights.TryGetValue(key, out granted)) return granted;
            var mapping = new GenericMapping { Read = 0x120089, Write = 0x120116, Execute = 0x1200A0, All = 0x1F01FF };
            uint size = 256; bool allowed;
            Check(AccessCheck(descriptor, token, 0x02000000, ref mapping, privileges, ref size, out granted, out allowed));
            if (!allowed) granted = 0;
            if (rights.Count < 256) rights.Add(key, granted); // Share effective rights only for identical descriptors in this one query.
            return granted;
        }
        public void CheckPath(string path, bool tree = false, bool onlyMutation = false) {
            var paths = new Stack<string>(); paths.Push(path);
            while (paths.Count > 0) {
                CheckBudget(paths.Count); string current = paths.Pop(); visited++;
                FileAttributes attributes;
                try { attributes = File.GetAttributes(current); }
                catch (FileNotFoundException) { continue; } catch (DirectoryNotFoundException) { continue; }
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException();
                bool directory = (attributes & FileAttributes.Directory) != 0;
                var acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(current) : File.GetAccessControl(current);
                // FILE_READ_DATA/LIST_DIRECTORY, writes, delete, change permissions or ownership.
                const uint mutation = 0x02 | 0x04 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000;
                uint forbidden = onlyMutation ? mutation : mutation | (directory ? 1U : 0x21U); // For files also exclude execution.
                if ((Access(acl) & forbidden) != 0) throw new UnauthorizedAccessException();
                // Traversal privilege can reach children even when their parent cannot be listed by the child token.
                if (tree && directory) foreach (string item in Directory.EnumerateFileSystemEntries(current)) {
                    paths.Push(item); CheckBudget(paths.Count);
                }
            }
            CheckBudget(0);
        }
    }
    static HashSet<string> HostFolders(string variable, Guid folder, HostAccess access) {
        IntPtr pointer = IntPtr.Zero;
        try {
            Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref folder, 0x4000, IntPtr.Zero, out pointer)); // KF_FLAG_DONT_VERIFY
            var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string known = Marshal.PtrToStringUni(pointer);
            if (String.IsNullOrEmpty(known)) throw new UnauthorizedAccessException();
            foreach (string candidate in new [] { known, Environment.GetEnvironmentVariable(variable) }) {
                if (String.IsNullOrEmpty(candidate)) continue;
                if (!Path.IsPathRooted(candidate)) throw new UnauthorizedAccessException();
                string full = Path.GetFullPath(candidate);
                // Resolve normal Known Folder junctions via a directory handle. Missing subdirectories
                // must also have a protected existing parent so the quota process cannot create them.
                string ancestor = full;
                for (;;) {
                    using (var handle = CreateFile(ancestor, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
                        if (!handle.IsInvalid) {
                            string target = FinalPath(handle);
                            if (ancestor != full) access.CheckPath(target, onlyMutation: true);
                            roots.Add(Path.Combine(target, full.Substring(ancestor.Length).TrimStart(Path.DirectorySeparatorChar))); break;
                        }
                        int error = Marshal.GetLastWin32Error();
                        if (error != 2 && error != 3) throw new Win32Exception(error);
                    }
                    ancestor = Path.GetDirectoryName(ancestor);
                    if (String.IsNullOrEmpty(ancestor)) throw new DirectoryNotFoundException();
                }
            }
            return roots;
        } finally { Marshal.FreeCoTaskMem(pointer); }
    }
    static void CheckHostBoundaries(SafeFileHandle primary, Memory mem) {
        string owner = Environment.CurrentDirectory;
        SafeFileHandle impersonation; Check(DuplicateToken(primary, 1, out impersonation));
        using (impersonation) {
            var access = new HostAccess(impersonation, mem);
            access.CheckPath(owner);
            access.CheckPath(Path.Combine(owner, ".ags-temporary-owner.json"));
            foreach (string home in HostFolders("USERPROFILE", new Guid("5E6C858F-0E22-4760-9AFE-EA3317B67173"), access)) {
                access.CheckPath(home, onlyMutation: true); // A missing login directory must not be creatable.
                access.CheckPath(Path.Combine(home, ".agent-switcher"), tree: true);
                string gemini = Path.Combine(home, ".gemini");
                foreach (string dir in new [] { "", "cache", "antigravity-cli", "antigravity-cli/cache" })
                    access.CheckPath(Path.Combine(gemini, dir), onlyMutation: true);
                foreach (string file in new [] { "jetski-standalone-oauth-token", "antigravity-cli/antigravity-oauth-token",
                    "cache/antigravity-keyring-unavailable", "antigravity-cli/cache/antigravity-keyring-unavailable" })
                    access.CheckPath(Path.Combine(gemini, file));
                access.CheckPath(Path.Combine(home, ".codex"));
                access.CheckPath(Path.Combine(home, ".codex/auth.json"));
            }
            foreach (string roaming in HostFolders("APPDATA", new Guid("3EB685DB-65F9-4CF6-A03A-E3EF65729F3D"), access)) {
                access.CheckPath(roaming, onlyMutation: true);
                foreach (string name in new [] { "Antigravity", "Antigravity/User", "Antigravity/User/globalStorage",
                    "Antigravity/User/globalStorage/state.vscdb", "Antigravity/User/globalStorage/state.vscdb-wal" })
                    access.CheckPath(Path.Combine(roaming, name));
            }
        }
    }
    static int DrainJob(SafeFileHandle job, int result) {
        Check(TerminateJobObject(job, 125));
        Stopwatch wait = Stopwatch.StartNew(); JobAccounting state;
        do {
            Check(QueryInformationJobObject(job, 1, out state, Size<JobAccounting>(), IntPtr.Zero));
            if (state.Active == 0) return result;
            Thread.Sleep(10);
        } while (wait.ElapsedMilliseconds < 5000);
        return 125;
    }
    // 0/1 = official job drained, 124 = CLI never started, 125 = unconfirmed.
    static int Run(string[] args, Process parent, Memory mem, bool isolated, string cwd, ref bool started) {
        using (WindowsIdentity user = isolated ? WindowsIdentity.GetCurrent(TokenAccessLevels.Query | TokenAccessLevels.Duplicate |
            TokenAccessLevels.AssignPrimary | TokenAccessLevels.AdjustDefault) : null)
        using (SafeFileHandle job = CreateJobObject(IntPtr.Zero, IntPtr.Zero))
        using (SafeFileHandle input = DuplicateStandard(-10))
        using (SafeFileHandle output = DuplicateStandard(-11))
        using (SafeFileHandle error = DuplicateStandard(-12)) {
            Check(!job.IsInvalid);
            // The shared headless command renews through native storage. Its browser opener
            // launches rundll32; keep the CLI as the only process in this job.
            JobLimits limits = new JobLimits { Flags = isolated ? 0x2000U : 0x2008U, ProcessLimit = isolated ? 0U : 1U };
            Check(SetInformationJobObject(job, 9, ref limits, Size<JobLimits>()));
            string stopFile;
            using (Process self = Process.GetCurrentProcess())
                stopFile = Path.Combine(Environment.CurrentDirectory, ".ags-stop-" + self.Id);
            string exe = args[2];
            SecurityIdentifier sid = isolated ? NewQuerySid() : null;
            using (SafeFileHandle restricted = isolated ? QuotaToken(user, sid, mem) : null)
            using (FileStream image = isolated ? Executable(exe, restricted, user, mem) : null) {
                if (isolated) {
                    SecurityIdentifier logon = LogonSid(user, mem);
                    Directory.CreateDirectory(cwd); AuthorizeHome(cwd, logon, sid);
                    exe = FinalPath(image.SafeFileHandle);
                    string temp = Path.Combine(cwd, "tmp"), local = Path.Combine(cwd, "AppData", "Local"), roaming = Path.Combine(cwd, "AppData", "Roaming");
                    foreach (string dir in new [] { temp, local, roaming }) Directory.CreateDirectory(dir);
                    string cache = Path.Combine(cwd, ".gemini", "antigravity-cli", "cache"); Directory.CreateDirectory(cache);
                    File.WriteAllBytes(Path.Combine(cache, "antigravity-keyring-unavailable"), new byte[0]);
                    foreach (string name in new [] { "HOME", "USERPROFILE" }) Environment.SetEnvironmentVariable(name, cwd);
                    foreach (string name in new [] { "TMP", "TEMP" }) Environment.SetEnvironmentVariable(name, temp);
                    Environment.SetEnvironmentVariable("APPDATA", roaming); Environment.SetEnvironmentVariable("LOCALAPPDATA", local);
                }
                const int count = 2; IntPtr length = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref length);
                Check(length != IntPtr.Zero); IntPtr attrs = mem.Alloc(length.ToInt32());
                Check(InitializeProcThreadAttributeList(attrs, count, 0, ref length));
                ProcessInfo info;
                try {
                    IntPtr stdin = input.DangerousGetHandle(), stdout = output.DangerousGetHandle(), stderr = error.DangerousGetHandle();
                    Attribute(attrs, 0x20002, mem.Handles(stdin, stdout, stderr), 3 * IntPtr.Size); // HANDLE_LIST
                    Attribute(attrs, 0x2000D, mem.Handles(job.DangerousGetHandle()), IntPtr.Size); // JOB_LIST, atomic at creation
                    ExtendedStartup start = new ExtendedStartup { Attributes = attrs, Info = new Startup { Size = Size<ExtendedStartup>(),
                        Flags = 0x100, Input = stdin, Output = stdout, Error = stderr } };
                    StringBuilder command = new StringBuilder(Quote(exe));
                    for (int i = 3; i < args.Length; i++) command.Append(' ').Append(Quote(args[i]));
                    if (parent.HasExited || File.Exists(stopFile)) return 124;
                    const uint flags = 0x08080000; // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT
                    if (isolated) started = CreateProcessAsUser(restricted, exe, command, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref start, out info);
                    else started = CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref start, out info);
                    Check(started);
                } finally { DeleteProcThreadAttributeList(attrs); }
                try {
                    IntPtr[] handles = new [] { parent.Handle, info.Process };
                    uint ended;
                    do {
                        ended = WaitForMultipleObjects(2, handles, false, 100);
                    } while (ended == 258 && !File.Exists(stopFile)); // WAIT_TIMEOUT
                    Check(ended <= 1 || ended == 258); uint exit = 125;
                    if (ended == 1) {
                        Check(GetExitCodeProcess(info.Process, out exit));
                        if (exit >= 0xC0000000U) Console.Error.WriteLine("Windows CLI exited ({0:X8})", exit);
                    }
                    return DrainJob(job, ended == 1 && exit == 0 ? 0 : 1);
                } finally { CloseHandle(info.Thread); CloseHandle(info.Process); }
            }
        }
    }
    static int Launch(string[] args) {
        bool started = false;
        try {
            if (args.Length < 3 || !Path.IsPathRooted(args[2])) return 124;
            bool isolated = args[0] == "isolated";
            if (!isolated && args[0] != "shared") return 124;
            using (Process parent = Process.GetProcessById(int.Parse(args[1])))
            using (Process self = Process.GetCurrentProcess())
            using (Memory mem = new Memory()) {
                // Keep a handle to the original AGS instance across PID reuse.
                if (parent.Handle == IntPtr.Zero || parent.StartTime > self.StartTime || parent.HasExited) return 124;
                string cwd = isolated ? Path.Combine(Environment.CurrentDirectory, "cli-home") : Environment.CurrentDirectory;
                return Run(args, parent, mem, isolated, cwd, ref started);
            }
        } catch (Exception e) {
            var native = e as Win32Exception;
            Console.Error.WriteLine("Windows CLI launch failed ({0:X8})", native == null ? e.HResult : native.NativeErrorCode);
            return started ? 125 : 124;
        }
    }
    public static int Main(string[] args) {
        int result = Launch(args);
        if (args.Length == 0 || args[0] != "isolated" || result == 125) return result;
        // A killed Windows process may also exit with 1. Only the unrestricted launcher
        // can create a receipt in this directory outside the CLI's writable home.
        try {
            using (Process self = Process.GetCurrentProcess()) {
                string file = Path.Combine(Environment.CurrentDirectory, ".ags-win-drained-" + self.Id);
                byte[] bytes = Encoding.ASCII.GetBytes(result.ToString(System.Globalization.CultureInfo.InvariantCulture));
                using (FileStream output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    output.Write(bytes, 0, bytes.Length); output.Flush(true);
                }
            }
            return result;
        } catch { return 125; }
    }
}
