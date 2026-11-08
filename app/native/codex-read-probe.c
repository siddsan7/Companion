#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* No CRT, Crypto, shell, network, configuration or credential access.
 * Exit 73 means CreateFileW/ReadFile returned Win32 ERROR_ACCESS_DENIED.
 * Child startup failures have distinct exits and cannot certify a denied read.
 * Arguments are absolute file paths; Windows file names cannot contain quotes.
 */
static WCHAR arguments[3][32768];
static WCHAR executable[32768];
static WCHAR childCommand[32768];
static STARTUPINFOW startup;
static PROCESS_INFORMATION child;

static void output(const char *bytes, DWORD length) {
    DWORD written;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, length, &written, 0) || written != length) ExitProcess(75);
}

static void readFailure(DWORD error) {
    if (error == ERROR_ACCESS_DENIED) {
        const char denied[] = "COMPANION_OS_DENIED";
        output(denied, sizeof(denied) - 1);
        ExitProcess(73);
    }
    ExitProcess(74);
}

static BOOL argument(WCHAR **cursor, WCHAR *destination) {
    WCHAR *source = *cursor;
    DWORD length = 0;
    BOOL quoted;
    while (*source == L' ' || *source == L'\t') ++source;
    if (!*source) return FALSE;
    quoted = *source == L'"';
    if (quoted) ++source;
    while (*source && (quoted ? *source != L'"' : (*source != L' ' && *source != L'\t'))) {
        if (length >= 32767 || *source == L'"') ExitProcess(64);
        destination[length++] = *source++;
    }
    if (quoted) {
        if (*source != L'"') ExitProcess(64);
        ++source;
        if (*source && *source != L' ' && *source != L'\t') ExitProcess(64);
    }
    destination[length] = 0;
    *cursor = source;
    return length != 0;
}

static BOOL childFlag(const WCHAR *value) {
    const WCHAR expected[] = L"--child";
    DWORD index = 0;
    while (expected[index] && value[index] == expected[index]) ++index;
    return !expected[index] && !value[index];
}

static void runChild(const WCHAR *target) {
    DWORD count = GetModuleFileNameW(0, executable, 32768);
    DWORD position = 0, index = 0, exitCode;
    if (!count || count >= 32768) ExitProcess(77);
    childCommand[position++] = L'"';
    while (executable[index]) {
        if (position >= 32760) ExitProcess(64);
        childCommand[position++] = executable[index++];
    }
    childCommand[position++] = L'"'; childCommand[position++] = L' '; childCommand[position++] = L'"';
    index = 0;
    while (target[index]) {
        if (position >= 32765) ExitProcess(64);
        childCommand[position++] = target[index++];
    }
    childCommand[position++] = L'"'; childCommand[position] = 0;
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(executable, childCommand, 0, 0, TRUE, 0, 0, 0, &startup, &child)) ExitProcess(77);
    if (WaitForSingleObject(child.hProcess, 10000) != WAIT_OBJECT_0) {
        TerminateProcess(child.hProcess, 78);
        CloseHandle(child.hThread); CloseHandle(child.hProcess);
        ExitProcess(78);
    }
    if (!GetExitCodeProcess(child.hProcess, &exitCode)) ExitProcess(79);
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
    ExitProcess(exitCode);
}

void WINAPI mainCRTStartup(void) {
    WCHAR *cursor = GetCommandLineW();
    WCHAR *target;
    DWORD count, total = 0;
    HANDLE file;
    char buffer[1024];
    if (!argument(&cursor, arguments[0]) || !argument(&cursor, arguments[1])) ExitProcess(64);
    if (childFlag(arguments[1])) {
        if (!argument(&cursor, arguments[2])) ExitProcess(64);
        target = arguments[2];
    } else target = arguments[1];
    while (*cursor == L' ' || *cursor == L'\t') ++cursor;
    if (*cursor || !(target[0] && ((target[1] == L':' && (target[2] == L'\\' || target[2] == L'/')) || (target[0] == L'\\' && target[1] == L'\\')))) ExitProcess(64);
    if (childFlag(arguments[1])) runChild(target);
    file = CreateFileW(target, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
    if (file == INVALID_HANDLE_VALUE) readFailure(GetLastError());
    for (;;) {
        if (!ReadFile(file, buffer, sizeof(buffer), &count, 0)) { DWORD error = GetLastError(); CloseHandle(file); readFailure(error); }
        if (!count) break;
        total += count;
        if (total > 4096) { CloseHandle(file); ExitProcess(76); }
        output(buffer, count);
    }
    CloseHandle(file);
    ExitProcess(0);
}
