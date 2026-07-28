using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace Dcli.Native;

class Program
{
    // ── Win32 constants ────────────────────────────────────────────────────
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint NORMAL_PRIORITY_CLASS = 0x00000020;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int ERROR_BROKEN_PIPE = 109;
    private const int ERROR_NO_DATA = 232;
    private const uint PIPE_DEFAULT_SIZE = 4096;
    private const uint STD_INPUT_HANDLE = unchecked((uint)-10);
    private const uint STD_OUTPUT_HANDLE = unchecked((uint)-11);
    private const uint STD_ERROR_HANDLE = unchecked((uint)-12);
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    // ── Win32 structs ──────────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public IntPtr lpReserved; public string? lpDesktop; public IntPtr lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
        public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
        public uint dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; public DateTime ToDateTime() { long ft = ((long)dwHighDateTime << 32) | dwLowDateTime; return DateTime.FromFileTimeUtc(ft); } }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public IntPtr MinimumWorkingSetSize; public IntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public long Affinity; public uint PriorityClass; public uint SchedulingClass; }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public IntPtr ProcessMemoryLimit; public IntPtr JobMemoryLimit; public IntPtr PeakProcessMemoryUsed; public IntPtr PeakJobMemoryUsed; }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }

    // ── Win32 imports ──────────────────────────────────────────────────────
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string? lpApplicationName, string? lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr hProcess, out FILETIME lpCreationTime, out FILETIME lpExitTime, out FILETIME lpKernelTime, out FILETIME lpUserTime);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool PeekNamedPipe(IntPtr hNamedPipe, byte[]? lpBuffer, uint nBufferSize, out uint lpBytesRead, out uint lpTotalBytesAvail, out uint lpBytesLeftThisMessage);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(uint nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    // ── State ──────────────────────────────────────────────────────────────
    private static IntPtr _jobHandle = IntPtr.Zero;
    private static IntPtr _childProcessHandle = IntPtr.Zero;
    private static IntPtr _childThreadHandle = IntPtr.Zero;
    private static uint _childPid = 0;
    private static string? _executionToken;
    private static readonly object _stdoutLock = new();
    private static readonly ManualResetEvent _childExited = new(false);
    private static uint _childExitCode = 0;
    private static bool _terminating = false;

    private static readonly JsonSerializerOptions _jsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, WriteIndented = false };

    // ── Entry point ─────────────────────────────────────────────────────────
    static int Main(string[] args)
    {
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        var reader = new StreamReader(stdin, Encoding.UTF8, leaveOpen: true);

        try
        {
            while (true)
            {
                var line = reader.ReadLine();
                if (line == null) break;

                if (string.IsNullOrWhiteSpace(line)) continue;

                JsonDocument doc;
                try { doc = JsonDocument.Parse(line); }
                catch { WriteJson(stdout, new { type = "error", error = "invalid json" }); continue; }

                var root = doc.RootElement;

                if (!root.TryGetProperty("type", out var typeProp))
                { WriteJson(stdout, new { type = "error", error = "missing type field" }); continue; }

                var type = typeProp.GetString();

                if (type == "command")
                {
                    if (!root.TryGetProperty("command", out var cmdProp))
                    { WriteJson(stdout, new { type = "error", error = "missing command field" }); continue; }

                    switch (cmdProp.GetString())
                    {
                        case "spawn": HandleSpawn(root, stdout); break;
                        case "terminate": HandleTerminate(root, stdout); break;
                        default: WriteJson(stdout, new { type = "error", error = $"unknown command: {cmdProp.GetString()}" }); break;
                    }
                }
                // ignore other types (e.g., stdin data for child)
            }
        }
        catch (Exception ex) { WriteJson(stdout, new { type = "error", error = ex.Message }); return 1; }
        finally { Cleanup(); }

        return 0;
    }

    // ── Spawn ────────────────────────────────────────────────────────────────
    static void HandleSpawn(JsonElement root, Stream stdout)
    {
        if (_jobHandle != IntPtr.Zero)
        { WriteJson(stdout, new { type = "error", error = "already spawned" }); return; }

        var args = new List<string>();
        if (root.TryGetProperty("args", out var argsElem))
            foreach (var a in argsElem.EnumerateArray()) args.Add(a.GetString() ?? "");
        if (args.Count == 0)
        { WriteJson(stdout, new { type = "error", error = "args array is required" }); return; }

        var cwd = root.TryGetProperty("cwd", out var cwdElem) ? cwdElem.GetString() : null;
        var env = new Dictionary<string, string>();
        if (root.TryGetProperty("env", out var envElem))
            foreach (var prop in envElem.EnumerateObject()) env[prop.Name] = prop.Value.GetString() ?? "";
        var stdioMode = "null";
        if (root.TryGetProperty("stdio", out var stdioElem)) stdioMode = stdioElem.GetString() ?? "null";

        var cmdLine = BuildCommandLine(args);

        // Create Job Object with kill-on-close
        var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), bInheritHandle = 1 };
        var saPtr = Marshal.AllocHGlobal(Marshal.SizeOf<SECURITY_ATTRIBUTES>());
        Marshal.StructureToPtr(sa, saPtr, false);
        _jobHandle = CreateJobObjectW(saPtr, null);
        Marshal.FreeHGlobal(saPtr);
        if (_jobHandle == IntPtr.Zero)
        { WriteJson(stdout, new { type = "error", error = $"CreateJobObjectW failed: {Marshal.GetLastWin32Error()}" }); return; }

        // Set kill-on-close, disallow breakaway (do NOT set JOB_OBJECT_LIMIT_BREAKAWAY_OK)
        var limitInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        { BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
        if (!SetInformationJobObject(_jobHandle, 9, ref limitInfo, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
        { var err = Marshal.GetLastWin32Error(); CloseHandle(_jobHandle); _jobHandle = IntPtr.Zero; WriteJson(stdout, new { type = "error", error = $"SetInformationJobObject failed: {err}" }); return; }

        // Setup pipes
        IntPtr cStdinR = IntPtr.Zero, cStdinW = IntPtr.Zero, cStdoutR = IntPtr.Zero, cStdoutW = IntPtr.Zero, cStderrR = IntPtr.Zero, cStderrW = IntPtr.Zero;
        var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
        uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | NORMAL_PRIORITY_CLASS;
        if (env.Count > 0) flags |= CREATE_UNICODE_ENVIRONMENT;
        bool inheritHandles = false;

        if (stdioMode == "pipe")
        {
            var psa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), bInheritHandle = 1 };
            var psaPtr = Marshal.AllocHGlobal(Marshal.SizeOf<SECURITY_ATTRIBUTES>());
            Marshal.StructureToPtr(psa, psaPtr, false);

            if (!CreatePipe(out cStdinR, out cStdinW, psaPtr, PIPE_DEFAULT_SIZE)) { Marshal.FreeHGlobal(psaPtr); Cleanup(); WriteJson(stdout, new { type = "error", error = $"CreatePipe stdin: {Marshal.GetLastWin32Error()}" }); return; }
            SetHandleInformation(cStdinW, HANDLE_FLAG_INHERIT, 0);
            if (!CreatePipe(out cStdoutR, out cStdoutW, psaPtr, PIPE_DEFAULT_SIZE)) { Marshal.FreeHGlobal(psaPtr); Cleanup(); WriteJson(stdout, new { type = "error", error = $"CreatePipe stdout: {Marshal.GetLastWin32Error()}" }); return; }
            SetHandleInformation(cStdoutR, HANDLE_FLAG_INHERIT, 0);
            if (!CreatePipe(out cStderrR, out cStderrW, psaPtr, PIPE_DEFAULT_SIZE)) { Marshal.FreeHGlobal(psaPtr); Cleanup(); WriteJson(stdout, new { type = "error", error = $"CreatePipe stderr: {Marshal.GetLastWin32Error()}" }); return; }
            SetHandleInformation(cStderrR, HANDLE_FLAG_INHERIT, 0);
            Marshal.FreeHGlobal(psaPtr);

            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = cStdinR; si.hStdOutput = cStdoutW; si.hStdError = cStderrW;
            inheritHandles = true;
        }
        else if (stdioMode == "inherit")
        {
            var hStdin = GetStdHandle(STD_INPUT_HANDLE);
            var hStdout = GetStdHandle(STD_OUTPUT_HANDLE);
            var hStderr = GetStdHandle(STD_ERROR_HANDLE);
            if (hStdin != IntPtr.Zero && hStdin != INVALID_HANDLE_VALUE)
            { si.dwFlags |= STARTF_USESTDHANDLES; si.hStdInput = hStdin; si.hStdOutput = hStdout; si.hStdError = hStderr; inheritHandles = true; }
        }

        // Build env block
        IntPtr envBlock = IntPtr.Zero;
        if (env.Count > 0)
        {
            var sb = new StringBuilder();
            foreach (DictionaryEntry kv in Environment.GetEnvironmentVariables()) { sb.Append(kv.Key); sb.Append('='); sb.Append(kv.Value); sb.Append('\0'); }
            foreach (var kv in env) { sb.Append(kv.Key); sb.Append('='); sb.Append(kv.Value); sb.Append('\0'); }
            sb.Append('\0');
            envBlock = Marshal.StringToCoTaskMemUni(sb.ToString());
        }

        if (!CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero, inheritHandles, flags, envBlock, cwd, ref si, out var pi))
        { var err = Marshal.GetLastWin32Error(); if (envBlock != IntPtr.Zero) Marshal.FreeCoTaskMem(envBlock); Cleanup(); WriteJson(stdout, new { type = "error", error = $"CreateProcessW failed: {err}" }); return; }
        if (envBlock != IntPtr.Zero) Marshal.FreeCoTaskMem(envBlock);

        if (stdioMode == "pipe") { CloseHandle(cStdinR); CloseHandle(cStdoutW); CloseHandle(cStderrW); }

        // Assign to job BEFORE resuming
        if (!AssignProcessToJobObject(_jobHandle, pi.hProcess))
        { var err = Marshal.GetLastWin32Error(); TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); Cleanup(); WriteJson(stdout, new { type = "error", error = $"AssignProcessToJobObject failed: {err}" }); return; }

        string creationTime;
        if (GetProcessTimes(pi.hProcess, out var ftCreate, out _, out _, out _)) creationTime = ftCreate.ToDateTime().ToString("o");
        else creationTime = DateTime.UtcNow.ToString("o");

        _executionToken = Guid.NewGuid().ToString("N");
        _childProcessHandle = pi.hProcess;
        _childThreadHandle = pi.hThread;
        _childPid = pi.dwProcessId;
        _childExited.Reset();

        ResumeThread(pi.hThread);

        WriteJson(stdout, new { type = "started", pid = (int)pi.dwProcessId, execution_token = _executionToken, creation_time = creationTime });

        // Handle pipe stdio forwarding (background threads)
        if (stdioMode == "pipe" && cStdoutR != IntPtr.Zero && cStderrR != IntPtr.Zero)
        {
            var done = new ManualResetEvent(false);
            var tOut = new Thread(() => PipeCopyLoop(cStdoutR, "stdout", stdout, done)) { IsBackground = true };
            var tErr = new Thread(() => PipeCopyLoop(cStderrR, "stderr", stdout, done)) { IsBackground = true };
            tOut.Start(); tErr.Start();

            // Store pipe handles in a local capture so they can be closed
            // when the child exits (via ChildWaitThread which also runs the pipe cleanup)
            new Thread(() =>
            {
                _childExited.WaitOne();
                done.Set();
                tOut.Join(3000); tErr.Join(3000);
                CloseHandle(cStdoutR); CloseHandle(cStderrR);
                if (cStdinW != IntPtr.Zero) CloseHandle(cStdinW);
            }) { IsBackground = true }.Start();
        }

        // Start background thread to wait for child exit
        new Thread(ChildWaitThread) { IsBackground = true }.Start();
    }

    // ── Background wait for child ──────────────────────────────────────────
    static void ChildWaitThread()
    {
        if (_childProcessHandle != IntPtr.Zero)
        {
            WaitForSingleObject(_childProcessHandle, INFINITE);
            GetExitCodeProcess(_childProcessHandle, out _childExitCode);
        }
        _childExited.Set();

        // Only send exited if we weren't explicitly terminated
        if (!_terminating)
            WriteJson(Console.OpenStandardOutput(), new { type = "exited", pid = (int)_childPid, exit_code = (int)_childExitCode });
    }

    // ── Terminate ───────────────────────────────────────────────────────────
    static void HandleTerminate(JsonElement root, Stream stdout)
    {
        if (_jobHandle == IntPtr.Zero)
        { WriteJson(stdout, new { type = "error", error = "no active job" }); return; }

        if (root.TryGetProperty("execution_token", out var tokenElem))
        {
            var t = tokenElem.GetString();
            if (t != null && t != _executionToken)
            { WriteJson(stdout, new { type = "error", error = "execution_token mismatch" }); return; }
        }

        uint graceMs = 5000;
        if (root.TryGetProperty("grace_ms", out var graceElem)) graceMs = (uint)Math.Max(0, graceElem.GetInt32());

        _terminating = true;

        if (graceMs > 0 && _childProcessHandle != IntPtr.Zero)
        {
            if (WaitForSingleObject(_childProcessHandle, Math.Min(graceMs, 30000)) == WAIT_OBJECT_0)
            { WriteJson(stdout, new { type = "terminated", terminated = true, survivors = Array.Empty<int>() }); return; }
        }

        if (TerminateJobObject(_jobHandle, 1))
        {
            if (_childProcessHandle != IntPtr.Zero) WaitForSingleObject(_childProcessHandle, 5000);
            WriteJson(stdout, new { type = "terminated", terminated = true, survivors = Array.Empty<int>() });
        }
        else
        { WriteJson(stdout, new { type = "terminated", terminated = false, error = $"TerminateJobObject failed: {Marshal.GetLastWin32Error()}" }); }
    }

    // ── Pipe copy loop ─────────────────────────────────────────────────────
    static void PipeCopyLoop(IntPtr pipe, string name, Stream parentStdout, ManualResetEvent done)
    {
        var buf = new byte[65536];
        while (!done.WaitOne(0))
        {
            if (!PeekNamedPipe(pipe, null, 0, out _, out var avail, out _)) break;
            if (avail == 0) { Thread.Sleep(50); continue; }
            var toRead = Math.Min(avail, (uint)buf.Length);
            if (!ReadFile(pipe, buf, toRead, out var read, IntPtr.Zero)) break;
            if (read > 0) WriteJson(parentStdout, new { type = name, data = Convert.ToBase64String(buf, 0, (int)read) });
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    static string BuildCommandLine(List<string> args)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < args.Count; i++)
        {
            if (i > 0) sb.Append(' ');
            var a = args[i];
            if (a.Contains(' ') || a.Contains('\t') || a.Contains('"') || a.Length == 0)
            { sb.Append('"'); sb.Append(a.Replace("\"", "\\\"")); sb.Append('"'); }
            else sb.Append(a);
        }
        return sb.ToString();
    }

    static void WriteJson(Stream stream, object value)
    {
        var json = JsonSerializer.Serialize(value, _jsonOpts) + "\n";
        var bytes = Encoding.UTF8.GetBytes(json);
        lock (_stdoutLock) { stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
    }

    static void Cleanup()
    {
        if (_jobHandle != IntPtr.Zero) { TerminateJobObject(_jobHandle, 1); CloseHandle(_jobHandle); _jobHandle = IntPtr.Zero; }
        if (_childProcessHandle != IntPtr.Zero) { CloseHandle(_childProcessHandle); _childProcessHandle = IntPtr.Zero; }
        if (_childThreadHandle != IntPtr.Zero) { CloseHandle(_childThreadHandle); _childThreadHandle = IntPtr.Zero; }
    }
}
