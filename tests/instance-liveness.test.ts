// Instance liveness decided by the After Effects PROCESS, not the heartbeat
// alone: stalled instances stay addressable, a stalled agent is re-armed
// through `-r`, instance.stop waits for the process to exit, and nothing is
// ever pushed into an After Effects that shows a modal dialog. Processes,
// dialogs and the launcher are all fakes; instance directories live under the
// real mailbox (the transport and the operations resolve ids there) with
// unique names, and are removed afterwards.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BUSY_LOCK_PATH,
  HEARTBEAT_FILENAME,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  RUNTIME_DIR,
  instanceDirFor,
} from "../src/config.js";
import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";
import {
  FileIpcTransport,
  type LaunchedProcess,
  type SpawnFn,
  exeFromCommandLine,
} from "../src/transport/FileIpcTransport.js";
import {
  type AeDialog,
  setOsascriptRunner,
  setPowerShellRunner,
} from "../src/transport/dialogs.js";
import { setInstanceProcessSource } from "../src/transport/instances.js";
import type { AeProcess } from "../src/transport/processes.js";

let restore: Array<() => void> = [];
beforeAll(() => {
  restore = [setPowerShellRunner(async () => "[]"), setOsascriptRunner(async () => "[]")];
});
afterAll(() => restore.forEach((r) => r()));

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  await fs.unlink(BUSY_LOCK_PATH).catch(() => {});
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function proc(pid: number, startedAt: number, multiInstance = false): AeProcess {
  return {
    pid,
    commandLine: `"C:\\Fake AE\\AfterFX.exe"${multiInstance ? " -m" : ""}`,
    multiInstance,
    startedAt,
  };
}

async function writeHeartbeat(id: string, body: Record<string, unknown>): Promise<string> {
  const dir = instanceDirFor(id);
  await fs.mkdir(dir, { recursive: true });
  if (!created.includes(dir)) created.push(dir);
  await fs.writeFile(
    path.join(dir, HEARTBEAT_FILENAME),
    JSON.stringify({ id, project: null, projectName: null, busy: false, ...body }),
    "utf8",
  );
  return dir;
}

async function listMail(dir: string, prefix: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((e) => e.startsWith(prefix) && e.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Answer every pending request in `dir` with `result`. */
async function answerAll(dir: string, result: unknown): Promise<number> {
  let n = 0;
  for (const name of await listMail(dir, REQUEST_PREFIX)) {
    const id = name.slice(REQUEST_PREFIX.length, -".json".length);
    await fs.unlink(path.join(dir, name)).catch(() => {});
    await fs.writeFile(
      path.join(dir, `${RESPONSE_PREFIX}${id}.json`),
      JSON.stringify({
        id,
        ok: true,
        phase: "execute",
        result,
        error: null,
        stack: null,
        logs: [],
      }),
      "utf8",
    );
    n++;
  }
  return n;
}

class FakeChild extends EventEmitter implements LaunchedProcess {
  pid = 4242;
  stderr = null;
  kill(): void {
    this.emit("exit", null);
  }
  unref(): void {}
}

describe("exeFromCommandLine", () => {
  it("takes the quoted or bare executable", () => {
    expect(
      exeFromCommandLine({
        commandLine: '"C:\\Program Files\\Adobe\\AE 2027\\Support Files\\AfterFX.exe" -m',
      }),
    ).toBe("C:\\Program Files\\Adobe\\AE 2027\\Support Files\\AfterFX.exe");
    expect(exeFromCommandLine({ commandLine: "C:\\AE\\AfterFX.exe -r x.jsx" })).toBe(
      "C:\\AE\\AfterFX.exe",
    );
    expect(exeFromCommandLine({ commandLine: "" })).toBeNull();
  });
});

describe("pull to a stalled instance", () => {
  it("queues the request instead of discarding it, and says why it could not re-arm a -m instance", async () => {
    const id = `t-stall-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const dir = await writeHeartbeat(id, { startedAt: now - 60_000, ts: now - 25_000 });
    const launches: string[] = [];
    const transport = new FileIpcTransport({
      instance: id,
      spawn: (command) => {
        launches.push(command);
        return new FakeChild();
      },
      listAeProcesses: async () => [proc(999, now - 65_000, true)],
      scanDialogs: async () => [],
    });
    const call = transport.execute({ code: "return 1;", label: "stalled_pull", timeoutMs: 8_000 });
    // Still waiting after the liveness checks: a stalled instance is not dead.
    await sleep(1_800);
    expect(await listMail(dir, REQUEST_PREFIX)).toHaveLength(1);
    // The agent comes back and serves it.
    expect(await answerAll(dir, "served late")).toBe(1);
    const res = await call;
    expect(res.ok, res.error ?? "").toBe(true);
    expect(res.result).toBe("served late");
    expect(res.logs[0]).toContain(`re-arm of agent '${id}'`);
    expect(res.logs[0]).toContain("started with -m");
    expect(launches).toEqual([]);
  }, 15_000);

  it("fails with DIALOG_OPEN and sends nothing when that process shows a dialog", async () => {
    const id = `t-modal-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const dir = await writeHeartbeat(id, { startedAt: now - 60_000, ts: now - 25_000 });
    const dialog: AeDialog = {
      pid: 999,
      id: "77",
      text: "Cached Preview needs 2 or more frames to play back.",
      width: 400,
      height: 200,
      window: "Adobe After Effects 2027",
    };
    const launches: string[] = [];
    const transport = new FileIpcTransport({
      instance: id,
      spawn: (command) => {
        launches.push(command);
        return new FakeChild();
      },
      listAeProcesses: async () => [proc(999, now - 65_000)],
      scanDialogs: async () => [dialog],
    });
    const res = await transport.execute({ code: "return 1;", label: "modal", timeoutMs: 5_000 });
    expect(res.errorCode).toBe("DIALOG_OPEN");
    expect(res.error).toContain("Cached Preview");
    expect(res.error).toContain("stalled");
    expect(await listMail(dir, REQUEST_PREFIX)).toEqual([]);
    // Neither the call nor a re-arm went through -r.
    expect(launches).toEqual([]);
  });

  it("re-arms the agent through -r when that process is the push target", async () => {
    const id = `t-rearm-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const dir = await writeHeartbeat(id, {
      startedAt: now - 60_000,
      ts: now - 25_000,
      agentVersion: 2,
    });
    let pushed: Record<string, unknown> | null = null;
    const spawn: SpawnFn = (command, args) => {
      const child = new FakeChild();
      setTimeout(() => child.emit("exit", 0), 20);
      // Play the dispatcher: serve the shared-mailbox request, then the
      // re-armed agent's first heartbeat.
      setTimeout(async () => {
        for (const name of await listMail(RUNTIME_DIR, REQUEST_PREFIX)) {
          const full = path.join(RUNTIME_DIR, name);
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(await fs.readFile(full, "utf8"));
          } catch {
            continue;
          }
          if (body.label !== "agent.rearm") continue;
          pushed = { ...body, command, args };
          await fs.unlink(full).catch(() => {});
          const rid = name.slice(REQUEST_PREFIX.length, -".json".length);
          await fs.writeFile(
            path.join(RUNTIME_DIR, `${RESPONSE_PREFIX}${rid}.json`),
            JSON.stringify({
              id: rid,
              ok: true,
              phase: "execute",
              result: { agent: true, via: "rearm", detail: { taskId: 2 } },
              error: null,
              stack: null,
              logs: [],
            }),
            "utf8",
          );
          await writeHeartbeat(id, { startedAt: now - 60_000, ts: Date.now(), rearms: 1 });
        }
      }, 60);
      return child;
    };
    const transport = new FileIpcTransport({
      instance: id,
      spawn,
      listAeProcesses: async () => [proc(1234, now - 65_000)],
      scanDialogs: async () => [],
    });
    const call = transport.execute({ code: "return 2;", label: "after_rearm", timeoutMs: 15_000 });
    // Serve the real request once the agent is back.
    const serve = (async () => {
      for (let i = 0; i < 100; i++) {
        if ((await answerAll(dir, "ticking again")) > 0) return;
        await sleep(100);
      }
    })();
    const res = await call;
    await serve;
    expect(res.ok, res.error ?? "").toBe(true);
    expect(pushed).not.toBeNull();
    expect(pushed!.command).toBe("C:\\Fake AE\\AfterFX.exe");
    expect(String(pushed!.code)).toContain("AE_MCP_AGENT");
    expect(pushed!.undoGroup).toBe(false);
    expect(res.logs[0]).toContain("re-armed via rearm()");
    expect(res.logs[0]).toContain("ticking again");
  }, 25_000);
});

describe("push path never launches into a dialog", () => {
  it("refuses with DIALOG_OPEN before launching, stale agents or not", async () => {
    const saved = process.env.AE_MCP_EXE;
    process.env.AE_MCP_EXE =
      process.platform === "win32" ? "C:/Windows/System32/cmd.exe" : "/usr/bin/true";
    try {
      let launches = 0;
      const transport = new FileIpcTransport({
        instance: null,
        spawn: () => {
          launches++;
          return new FakeChild();
        },
        scanDialogs: async () => [
          {
            pid: 5,
            id: "1",
            text: "Cached Preview needs 2 or more frames to play back.",
            width: 1,
            height: 1,
            window: "",
          },
        ],
      });
      const res = await transport.execute({ code: "return 1;", label: "push", timeoutMs: 5_000 });
      expect(res.errorCode).toBe("DIALOG_OPEN");
      expect(res.error).toContain("nothing was sent");
      expect(launches).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.AE_MCP_EXE;
      else process.env.AE_MCP_EXE = saved;
    }
  });
});

function quitTransport(onQuit: () => void): AeTransport {
  return {
    async execute(_req: EvalRequest): Promise<EvalResult> {
      onQuit();
      return {
        ok: true,
        result: { ok: true, file: null, saved: false },
        error: null,
        errorCode: null,
        stack: null,
        logs: [],
        durationMs: 0,
      };
    },
  };
}

async function stop(args: Record<string, unknown>, transport: AeTransport) {
  return (await getOp("instance.stop")!.run!(args, transport)) as Record<string, unknown>;
}

describe("instance.stop by process", () => {
  it("stops a stalled instance and reports stopped only once its process has exited", async () => {
    const id = `t-stop-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const dir = await writeHeartbeat(id, { startedAt: now - 30_000, ts: now - 25_000 });
    let quit = false;
    const undo = setInstanceProcessSource(async () => (quit ? [] : [proc(31337, now - 35_000)]));
    try {
      const res = await stop(
        { name: id, timeoutMs: 5_000 },
        quitTransport(() => {
          quit = true;
        }),
      );
      expect(res.ok, String(res.error)).toBe(true);
      expect(res.stopped).toBe(true);
      expect(res.pid).toBe(31337);
      expect(res.verifiedBy).toBe("process");
      await expect(fs.access(dir)).rejects.toThrow();
    } finally {
      undo();
    }
  });

  it("reports a process that keeps running after the quit, and keeps its directory", async () => {
    const id = `t-stuck-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const dir = await writeHeartbeat(id, { startedAt: now - 30_000, ts: now });
    const undo = setInstanceProcessSource(async () => [proc(31338, now - 35_000)]);
    try {
      const res = await stop(
        { name: id, timeoutMs: 1_200 },
        quitTransport(() => {}),
      );
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("pid 31338");
      expect(String(res.error)).toContain("still running");
      expect(String(res.hint)).toContain("instance.dialogs");
      await expect(fs.access(dir)).resolves.toBeUndefined();
    } finally {
      undo();
    }
  });

  it("refuses an instance whose process is gone, even with a busy heartbeat", async () => {
    const id = `t-gone-${randomUUID().slice(0, 6)}`;
    const now = Date.now();
    await writeHeartbeat(id, { startedAt: now - 30_000, ts: now - 20_000, busy: true });
    const undo = setInstanceProcessSource(async () => []);
    try {
      let called = false;
      const res = await stop(
        { name: id },
        quitTransport(() => {
          called = true;
        }),
      );
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("NO_INSTANCE");
      expect(String(res.error)).toContain("dead: After Effects process gone");
      expect(called).toBe(false);
    } finally {
      undo();
    }
  });
});
