// Delete only objects pinned and checked by handle. Directory removal is always nonrecursive.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public sealed class TraceEntry {
    public string Relative;
    public string Volume;
    public string Index;
    public string Born;
    public string Digest;
    public bool Directory;
}
public static class CompanionTraceRetirement {
    [StructLayout(LayoutKind.Sequential)]
    private struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref byte value, uint length);

    public static void Remove(string root, TraceEntry[] entries) {
        string staging = Path.GetDirectoryName(root);
        if (root != Path.GetFullPath(root) ||
            !String.Equals(Path.GetDirectoryName(staging), Path.GetTempPath().TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
            !Regex.IsMatch(Path.GetFileName(staging), @"^companion-live-chat-[a-zA-Z0-9]+$") ||
            !Regex.IsMatch(Path.GetFileName(root), @"^synthetic-trace-[a-zA-Z0-9]+$") ||
            entries.Length == 0 || entries[0].Relative != "" || !entries[0].Directory) throw new IOException();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries) {
            string rel = entry.Relative;
            const string bundle = @"trace-[0-9a-f-]{36}-[0-9a-f-]{36}";
            string pattern = entry.Directory ? "^" + bundle + @"(\\payloads)?$" :
                "^" + bundle + @"\\(manifest\.json|trace\.jsonl|payloads\\[1-9][0-9]*\.json)$";
            if (!names.Add(rel) || (rel != "" && !Regex.IsMatch(rel, pattern))) throw new IOException();
        }
        var handles = new List<SafeFileHandle>();
        try {
            // Entries are parent-first. Omit FILE_SHARE_DELETE so held ancestors cannot move.
            foreach (var entry in entries) {
                string path = entry.Relative == "" ? root : Path.Combine(root, entry.Relative);
                var handle = CreateFile(path, 0x80010000, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                handles.Add(handle);
                Info info;
                if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info)) throw new IOException();
                ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
                long born = ((long)info.Created.dwHighDateTime << 32) | (uint)info.Created.dwLowDateTime;
                if ((info.Attributes & 1024) != 0 || ((info.Attributes & 16) != 0) != entry.Directory ||
                    info.Volume.ToString(CultureInfo.InvariantCulture) != entry.Volume ||
                    index.ToString(CultureInfo.InvariantCulture) != entry.Index ||
                    born.ToString(CultureInfo.InvariantCulture) != entry.Born) throw new IOException();
                if (!entry.Directory) {
                    if (info.Links != 1) throw new IOException();
                    // The borrowed handle keeps the verified object open through deletion.
                    using (var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), false))
                    using (var reader = new FileStream(borrowed, FileAccess.Read))
                    using (var sha = SHA256.Create()) {
                        if (!String.Equals(BitConverter.ToString(sha.ComputeHash(reader)).Replace("-", ""), entry.Digest,
                                StringComparison.OrdinalIgnoreCase)) throw new IOException();
                    }
                }
            }
            foreach (var dir in entries.Where(e => e.Directory)) {
                var directory = Path.Combine(root, dir.Relative);
                var expected = new HashSet<string>(entries.Where(e => e.Relative != "" &&
                    (Path.GetDirectoryName(e.Relative) ?? "") == dir.Relative).Select(e => Path.GetFileName(e.Relative)), StringComparer.Ordinal);
                if (!expected.SetEquals(Directory.EnumerateFileSystemEntries(directory).Select(Path.GetFileName))) throw new IOException();
            }
            for (int i = handles.Count - 1; i >= 0; --i) {
                byte remove = 1;
                // Windows refuses to retire a nonempty directory, including late foreign entries.
                if (!SetFileInformationByHandle(handles[i], 4, ref remove, 1)) throw new Win32Exception();
                handles[i].Dispose();
            }
        } finally { foreach (var handle in handles) handle.Dispose(); }
    }
}
