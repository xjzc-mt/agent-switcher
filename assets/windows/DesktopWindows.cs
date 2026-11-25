using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
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
                    if (born / 10 == expected / 10) return handle; // CIM reports microseconds.
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
            if (args.Length < 2) return 1;
            for (int i = 1; i < args.Length; i++) {
                string[] parts = args[i].Split(':');
                bool window = parts[0] == "window"; int pid; long created;
                if (parts.Length != 3 || (!window && parts[0] != "wait") || !Int32.TryParse(parts[1], out pid) ||
                    pid <= 0 || !Int64.TryParse(parts[2], out created) || created <= 0) return 1;
                SafeWaitHandle handle;
                try { handle = Pin(pid, created); }
                catch (Win32Exception e) {
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
            if (!EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
                int pid; GetWindowThreadProcessId(hwnd, out pid);
                if (roots.Contains(pid) && WaitForSingleObject(pinned[pid], 0) == 258 && GetWindow(hwnd, 4) == IntPtr.Zero) {
                    var name = new StringBuilder(80); GetClassName(hwnd, name, name.Capacity);
                    if (name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal) &&
                        PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero)) sent++;
                }
                return true;
            }, IntPtr.Zero)) return sent > 0 ? 3 : 2;
            if (sent == 0) return 4;
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
