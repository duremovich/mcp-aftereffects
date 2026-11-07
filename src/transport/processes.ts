// Which After Effects processes are running, and how were they launched?
//
// The push path (`AfterFX.exe -r dispatcher.jsx`) only reaches an instance
// that registered as THE running AE. When none did — AE is not running at
// all, or every running one was started with `-m` — the launched AfterFX.exe
// boots a whole new instance of its own (seconds of splash screen, gigabytes
// of RAM) before the phantom detector notices and kills it. Asking Windows
// first lets the transport refuse up front, without launching anything.
//
// Windows only: process command lines come from Win32_Process. Elsewhere the
// answer is `null` ("unknown") and the caller proceeds as before.

import { execFile } from "node:child_process";

export interface AeProcess {
  pid: number;
  commandLine: string;
  /** Started with `-m` (multi-instance): never receives `-r` scripts. */
  multiInstance: boolean;
}

export type AeProcessLister = () => Promise<AeProcess[] | null>;

const LIST_TIMEOUT_MS = 8000;

const PS_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  "@(Get-CimInstance Win32_Process -Filter \"Name='AfterFX.exe'\" | " +
  "ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; cmd = [string]$_.CommandLine } }) | " +
  "ConvertTo-Json -Compress";

/** `-m` as its own argument (not inside a quoted path). */
export function isMultiInstanceCommandLine(commandLine: string): boolean {
  // Drop the quoted executable path first so a folder named "-m" cannot match.
  // Windows can report an unterminated trailing quote (a truncated file argument) — strip that too.
  const rest = commandLine
    .replace(/^\s*"[^"]*"/, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/"[^"]*$/, " ");
  return /(^|\s)-m(\s|$)/i.test(rest);
}

export function parseProcessJson(stdout: string): AeProcess[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  const raw: unknown = JSON.parse(text);
  const rows = Array.isArray(raw) ? raw : [raw];
  const out: AeProcess[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as { pid?: unknown; cmd?: unknown };
    const pid = typeof r.pid === "number" ? r.pid : Number(r.pid);
    const commandLine = typeof r.cmd === "string" ? r.cmd : "";
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, commandLine, multiInstance: isMultiInstanceCommandLine(commandLine) });
  }
  return out;
}

/** Running AfterFX.exe processes on Windows; `null` when unknown (other OS, or the query failed). */
export const listAeProcesses: AeProcessLister = () => {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
      { timeout: LIST_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(parseProcessJson(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
};
