using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class AntigravityCredential {
    const string Target = "gemini:antigravity";
    const int Generic = 1, NotFound = 1168;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Credential {
        public int Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int Size;
        public IntPtr Blob;
        public int Persist, Count;
        public IntPtr Attributes;
        public string Alias, User;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool CredReadW(string name, int type, int flags, out IntPtr result);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool CredWriteW(ref Credential credential, int flags);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool CredDeleteW(string name, int type, int flags);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr result);
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);

    [StructLayout(LayoutKind.Sequential)]
    struct Blob { public int Size; public IntPtr Data; }
    const int CryptProtectUiForbidden = 1;
    [DllImport("crypt32.dll", ExactSpelling=true, SetLastError=true)]
    static extern bool CryptProtectData(ref Blob input, IntPtr description, ref Blob entropy,
        IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", ExactSpelling=true, SetLastError=true)]
    static extern bool CryptUnprotectData(ref Blob input, IntPtr description, ref Blob entropy,
        IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll", ExactSpelling=true)]
    static extern IntPtr LocalFree(IntPtr memory);

    // Binary pipes keep the master key out of command lines and immutable strings.
    static void Dpapi(bool protect, string service) {
        byte[] input = new byte[protect ? 32 : 65536], entropy = Encoding.UTF8.GetBytes(service);
        byte[] output = null;
        GCHandle inputPin = default(GCHandle), entropyPin = default(GCHandle);
        Blob result = new Blob();
        try {
            int count = 0;
            using (Stream source = Console.OpenStandardInput()) {
                int n;
                while (count < input.Length && (n = source.Read(input, count, input.Length - count)) > 0) count += n;
                if (count == 0 || (protect && count != 32) || source.ReadByte() != -1) throw new InvalidDataException();
            }
            inputPin = GCHandle.Alloc(input, GCHandleType.Pinned);
            entropyPin = GCHandle.Alloc(entropy, GCHandleType.Pinned);
            Blob data = new Blob { Size = count, Data = inputPin.AddrOfPinnedObject() };
            Blob extra = new Blob { Size = entropy.Length, Data = entropyPin.AddrOfPinnedObject() };
            bool ok = protect
                ? CryptProtectData(ref data, IntPtr.Zero, ref extra, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out result)
                : CryptUnprotectData(ref data, IntPtr.Zero, ref extra, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out result);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (result.Size <= 0 || result.Size > 65536 || (!protect && result.Size != 32)) throw new InvalidDataException();
            output = new byte[result.Size];
            Marshal.Copy(result.Data, output, 0, result.Size);
            using (Stream pipe = Console.OpenStandardOutput()) pipe.Write(output, 0, output.Length);
        } finally {
            Array.Clear(input, 0, input.Length);
            if (inputPin.IsAllocated) inputPin.Free();
            if (entropyPin.IsAllocated) entropyPin.Free();
            if (output != null) Array.Clear(output, 0, output.Length);
            if (result.Data != IntPtr.Zero) {
                for (int i = 0; i < result.Size; i++) Marshal.WriteByte(result.Data, i, 0);
                LocalFree(result.Data);
            }
        }
    }
    public static string[] Read(bool includeBlob = true) {
        IntPtr pointer;
        if (!CredReadW(Target, Generic, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return new string[] { null, null };
            throw new Win32Exception(error);
        }
        try {
            Credential c = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            string revision = c.LastWritten.dwHighDateTime.ToString("X8") + c.LastWritten.dwLowDateTime.ToString("X8");
            if (!includeBlob) return new string[] { null, revision };
            if (c.Size < 0 || c.Size > 2560) throw new InvalidOperationException();
            byte[] bytes = new byte[c.Size];
            if (bytes.Length != 0) Marshal.Copy(c.Blob, bytes, 0, bytes.Length);
            return new string[] { Convert.ToBase64String(bytes), revision };
        } finally { CredFree(pointer); }
    }
    public static void Replace(string expected, string revision, string next) {
        if (expected == "-") expected = null;
        if (revision == "-") revision = null;
        if (next == "-") next = null;
        string[] old = Read();
        if (old[0] != expected || old[1] != revision) throw new InvalidOperationException("changed");
        if (expected == next) return;
        if (next == null) {
            if (!CredDeleteW(Target, Generic, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return;
        }
        byte[] bytes = Convert.FromBase64String(next);
        if (bytes.Length > 2560) throw new InvalidOperationException();
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            Credential c = new Credential { Type = Generic, TargetName = Target, User = "antigravity",
                Size = bytes.Length, Blob = pinned.AddrOfPinnedObject(), Persist = 2 };
            if (!CredWriteW(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { pinned.Free(); Array.Clear(bytes, 0, bytes.Length); }
    }
    static bool TrustedAcl(FileSystemSecurity acl, bool directory) {
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
        if (owner != sid.Value && owner != "S-1-5-18" && owner != "S-1-5-32-544") return false;
        AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (rules.Count == 0) return false;
        const FileSystemRights directoryChanges = FileSystemRights.Write | FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in rules) {
            string user = rule.IdentityReference.Value;
            if (rule.AccessControlType != AccessControlType.Allow || user == sid.Value ||
                user == "S-1-5-18" || user == "S-1-5-32-544") continue;
            if (directory && ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0 ||
                (rule.FileSystemRights & directoryChanges) == 0)) continue;
            return false;
        }
        return true;
    }
    static bool TrustedQuotaDirectory(DirectoryInfo directory, bool checkDirectory) {
        try {
            if (checkDirectory && ((directory.Attributes & FileAttributes.ReparsePoint) != 0 || !TrustedAcl(directory.GetAccessControl(), false))) return false;
            foreach (var parent in new [] { directory.Parent, directory.Parent.Parent }) {
                if ((parent.Attributes & FileAttributes.ReparsePoint) != 0 || !TrustedAcl(parent.GetAccessControl(), true)) return false;
            }
            return true;
        } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
    }
    static bool TrustedCodexQuota(DirectoryInfo dir) {
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        if (!TrustedQuotaDirectory(dir, true) || !dir.GetAccessControl().GetOwner(typeof(SecurityIdentifier)).Equals(sid)) return false;
        foreach (string name in new [] { ".ags-temporary-owner.json", "auth.json" }) {
            var file = new FileInfo(Path.Combine(dir.FullName, name));
            if (!file.Exists) { if (name == "auth.json") continue; return false; }
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0) return false;
            var acl = file.GetAccessControl();
            if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(sid) || !TrustedAcl(acl, false)) return false;
        }
        return true;
    }
    static void NewPrivateDirectory(string path) {
        if (!TrustedQuotaDirectory(new DirectoryInfo(path), false)) throw new UnauthorizedAccessException();
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        DirectorySecurity acl = new DirectorySecurity();
        acl.SetOwner(sid);
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            InheritanceFlags.ObjectInherit | InheritanceFlags.ContainerInherit, PropagationFlags.None, AccessControlType.Allow));
        GCHandle descriptor = GCHandle.Alloc(acl.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
        try {
            SecurityAttributes attributes = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)),
                Descriptor = descriptor.AddrOfPinnedObject() };
            if (!CreateDirectoryW(path, ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { descriptor.Free(); }
    }
    static void NewPrivateFile(string file, byte[] bytes) {
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        FileSecurity acl = new FileSecurity();
        acl.SetOwner(sid);
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        using (FileStream stream = new FileStream(file, FileMode.CreateNew, FileSystemRights.FullControl,
                FileShare.None, 4096, FileOptions.None, acl)) {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
    }
    public static int Main(string[] args) {
        try {
            switch (args[0]) {
                case "dpapi-protect": case "dpapi-unprotect": Dpapi(args[0] == "dpapi-protect", args[1]); return 0;
                case "present": Console.Write(Read(false)[1] == null ? "0" : "1"); return 0;
                case "read":
                    string[] value = Read();
                    Console.Write((value[1] ?? "-") + ":" + (value[0] ?? "-")); return 0;
                case "replace": Replace(Console.ReadLine(), Console.ReadLine(), Console.ReadLine()); return 0;
                case "private": Console.Write(TrustedAcl(File.GetAccessControl(ReadPath()), false) ? "1" : "0"); return 0;
                case "directory": NewPrivateDirectory(ReadPath()); return 0;
                case "codex-quota": Console.Write(TrustedCodexQuota(new DirectoryInfo(ReadPath())) ? "1" : "0"); return 0;
                case "owned-directory": Console.Write(TrustedQuotaDirectory(new DirectoryInfo(ReadPath()), true) ? "1" : "0"); return 0;
                case "create": NewPrivateFile(ReadPath(), Convert.FromBase64String(Console.ReadLine())); return 0;
                default: return 2;
            }
        } catch (InvalidOperationException error) { return error.Message == "changed" ? 3 : 1; }
          catch { return 1; }
    }
    static string ReadPath() { return Encoding.UTF8.GetString(Convert.FromBase64String(Console.ReadLine())); }
}
