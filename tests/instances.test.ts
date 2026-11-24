// Instance discovery and target selection for the pull path. Pure filesystem:
// heartbeats are written by hand into a temp directory standing in for
// <runtime>/instances/, so nothing here needs After Effects or the agent.

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  HEARTBEAT_BUSY_STALE_MS,
  HEARTBEAT_FILENAME,
  HEARTBEAT_STALE_MS,
  INSTANCE_DIR_SWEEP_MS,
  INSTANCE_ID_MAX_LENGTH,
  sanitizeInstanceId,
} from "../src/config.js";
import {
  classifyInstance,
  describeInstance,
  instanceLabel,
  isAlive,
  listInstances,
  matchInstancesToProcesses,
  matchesTarget,
  readInstance,
  resolveTarget,
  setInstanceProcessSource,
  sweepDeadInstanceDirs,
} from "../src/transport/instances.js";
import type { AeProcess } from "../src/transport/processes.js";

let root: string;

// Nothing here may ask Windows which After Effects are running: the default
// lookups get no process information (heartbeat rules), and the tests that
// need processes pass their own list.
let restoreSource: () => void = () => {};
beforeAll(() => {
  restoreSource = setInstanceProcessSource(null);
});
afterAll(() => restoreSource());

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-instances-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function writeHeartbeat(
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  const heartbeat = {
    id,
    idSource: "env",
    agentVersion: 1,
    aeVersion: "26.3x87",
    project: null,
    projectName: null,
    busy: false,
    ts: Date.now(),
    ...overrides,
  };
  await fs.writeFile(path.join(dir, HEARTBEAT_FILENAME), JSON.stringify(heartbeat), "utf8");
  return dir;
}

describe("sanitizeInstanceId", () => {
  it("keeps plain ids and project-file-like names", () => {
    expect(sanitizeInstanceId("shotA")).toBe("shotA");
    expect(sanitizeInstanceId("shotA.aep")).toBe("shotA.aep");
    expect(sanitizeInstanceId("ep01_cut-03")).toBe("ep01_cut-03");
  });

  it("turns anything that cannot be a directory name into a dash", () => {
    // Both sides derive the mailbox directory from this — jsx/agent.jsx
    // applies the identical rule, so a value with spaces or slashes must map
    // to the same name on both.
    expect(sanitizeInstanceId(" shot A/1 ")).toBe("shot-A-1");
    expect(sanitizeInstanceId("a::b")).toBe("a-b");
  });

  it("rejects empty, whitespace, and dot-only values", () => {
    expect(sanitizeInstanceId("")).toBeNull();
    expect(sanitizeInstanceId("   ")).toBeNull();
    expect(sanitizeInstanceId("...")).toBeNull();
    expect(sanitizeInstanceId(undefined)).toBeNull();
  });

  it("caps the length", () => {
    expect(sanitizeInstanceId("x".repeat(200))).toHaveLength(INSTANCE_ID_MAX_LENGTH);
  });
});

describe("liveness", () => {
  it("is a fresh heartbeat, or a busy one within the long window", () => {
    const now = Date.now();
    expect(isAlive({ id: "a", project: null, projectName: null, ts: now - 1000 }, now)).toBe(true);
    expect(
      isAlive({ id: "a", project: null, projectName: null, ts: now - HEARTBEAT_STALE_MS - 1 }, now),
    ).toBe(false);
    // Ticks do not fire while a script runs: a heartbeat that said `busy`
    // stays believable for as long as the longest built-in call.
    expect(
      isAlive(
        { id: "a", project: null, projectName: null, busy: true, ts: now - HEARTBEAT_STALE_MS - 1 },
        now,
      ),
    ).toBe(true);
    expect(
      isAlive(
        {
          id: "a",
          project: null,
          projectName: null,
          busy: true,
          ts: now - HEARTBEAT_BUSY_STALE_MS - 1,
        },
        now,
      ),
    ).toBe(false);
    expect(isAlive(null, now)).toBe(false);
  });

  it("reads a directory without a heartbeat as dead, not as an error", async () => {
    const dir = path.join(root, "silent");
    await fs.mkdir(dir);
    const info = await readInstance(dir);
    expect(info.id).toBe("silent");
    expect(info.heartbeat).toBeNull();
    expect(info.alive).toBe(false);
  });

  it("lists every instance directory sorted by id, with liveness", async () => {
    await writeHeartbeat("b-live");
    await writeHeartbeat("a-stale", { ts: Date.now() - HEARTBEAT_STALE_MS * 2 });
    await fs.writeFile(path.join(root, "not-a-dir.txt"), "x", "utf8");
    const list = await listInstances(root);
    expect(list.map((i) => i.id)).toEqual(["a-stale", "b-live"]);
    expect(list.map((i) => i.alive)).toEqual([false, true]);
  });
});

describe("matchesTarget", () => {
  it("matches the id exactly or after sanitizing", async () => {
    const info = await readInstance(await writeHeartbeat("shot-A"));
    expect(matchesTarget(info, "shot-A")).toBe(true);
    expect(matchesTarget(info, "shot A")).toBe(true);
    expect(matchesTarget(info, "shot-B")).toBe(false);
  });

  it("matches the open project by file stem, case-insensitively, with or without extension or path", async () => {
    const info = await readInstance(
      await writeHeartbeat("ae-x1y2z3", {
        project: "C:/work/ep01/ShotA.aep",
        projectName: "ShotA.aep",
      }),
    );
    expect(matchesTarget(info, "shota")).toBe(true);
    expect(matchesTarget(info, "ShotA.aep")).toBe(true);
    expect(matchesTarget(info, "ShotB")).toBe(false);
    expect(matchesTarget(info, "")).toBe(false);
  });

  it("matches a path target on the whole path, so same-named projects in different folders stay apart", async () => {
    const info = await readInstance(
      await writeHeartbeat("ae-path", {
        project: "C:/work/ep01/ShotA.aep",
        projectName: "ShotA.aep",
      }),
    );
    expect(matchesTarget(info, "C:/work/ep01/ShotA.aep")).toBe(true);
    expect(matchesTarget(info, "c:\\work\\ep01\\shota.aep")).toBe(true);
    expect(matchesTarget(info, "D:/elsewhere/ShotA.aep")).toBe(false);
    expect(matchesTarget(info, "ep01/ShotA.aep")).toBe(false);
  });

  it("labels an instance project-first, id in brackets", async () => {
    const named = await readInstance(
      await writeHeartbeat("ae-t6s4fl", { projectName: "TECHC_LogoMark.aep" }),
    );
    expect(instanceLabel(named)).toBe("TECHC_LogoMark.aep [ae-t6s4fl]");
    expect(describeInstance(named)).toMatch(
      /^TECHC_LogoMark\.aep \[ae-t6s4fl\] \(live, seen \d+s ago\)$/,
    );
    const untitled = await readInstance(await writeHeartbeat("ae-9k2p1q"));
    expect(instanceLabel(untitled)).toBe("untitled [ae-9k2p1q]");
  });

  it("never matches an untitled project by name", async () => {
    const info = await readInstance(await writeHeartbeat("ae-untitled"));
    expect(matchesTarget(info, "untitled")).toBe(false);
  });
});

describe("resolveTarget", () => {
  it("pushes when nothing is named and no agent is live (the pre-agent behaviour)", async () => {
    expect(await resolveTarget(null, root)).toEqual({ mode: "push" });
    await writeHeartbeat("gone", { ts: Date.now() - HEARTBEAT_STALE_MS * 3 });
    expect(await resolveTarget(null, root)).toEqual({ mode: "push" });
  });

  it("pulls to the single live agent when nothing is named", async () => {
    await writeHeartbeat("only");
    const r = await resolveTarget(null, root);
    expect(r.mode).toBe("pull");
    if (r.mode === "pull") expect(r.instance.id).toBe("only");
  });

  it("refuses to guess between several live agents", async () => {
    await writeHeartbeat("shotA");
    await writeHeartbeat("shotB");
    const r = await resolveTarget(null, root);
    expect(r.mode).toBe("error");
    if (r.mode === "error") {
      expect(r.message).toContain("2 After Effects instances are live");
      expect(r.message).toContain("shotA");
      expect(r.message).toContain("shotB");
      expect(r.hint).toContain("AE_MCP_INSTANCE");
    }
  });

  it("pulls to the named live instance, by id or by project", async () => {
    await writeHeartbeat("shotA", { projectName: "ShotA_v3.aep", project: "C:/w/ShotA_v3.aep" });
    await writeHeartbeat("shotB");
    const byId = await resolveTarget("shotB", root);
    expect(byId.mode === "pull" && byId.instance.id).toBe("shotB");
    const byProject = await resolveTarget("shota_v3", root);
    expect(byProject.mode === "pull" && byProject.instance.id).toBe("shotA");
  });

  it("explains a named instance that has stopped ticking", async () => {
    await writeHeartbeat("shotA", { ts: Date.now() - 60_000 });
    const r = await resolveTarget("shotA", root);
    expect(r.mode).toBe("error");
    if (r.mode === "error") {
      expect(r.message).toContain("no live After Effects instance matches 'shotA'");
      expect(r.message).toContain("last seen");
      expect(r.message).toContain("stopped ticking");
    }
  });

  it("points at the agent install when nothing matches at all", async () => {
    await writeHeartbeat("other");
    const r = await resolveTarget("shotA", root);
    expect(r.mode).toBe("error");
    if (r.mode === "error") {
      expect(r.message).toContain("live instances: untitled [other]");
      expect(r.hint).toContain("install-agent");
    }
  });

  it("refuses a name that fits two live instances", async () => {
    // Two instances with the same project open (a copy in another instance,
    // say) — guessing would drive one of them blind.
    await writeHeartbeat("ae-aaa", { projectName: "Shot.aep" });
    await writeHeartbeat("ae-bbb", { projectName: "Shot.aep" });
    const r = await resolveTarget("Shot", root);
    expect(r.mode).toBe("error");
    if (r.mode === "error") expect(r.message).toContain("matches 2 live");
  });
});

describe("sweepDeadInstanceDirs", () => {
  it("removes directories whose heartbeat is long dead and keeps the rest", async () => {
    const dead = await writeHeartbeat("dead", { ts: Date.now() - INSTANCE_DIR_SWEEP_MS - 1000 });
    const live = await writeHeartbeat("live");
    const recentlyStale = await writeHeartbeat("stale", {
      ts: Date.now() - HEARTBEAT_STALE_MS * 2,
    });
    const removed = await sweepDeadInstanceDirs(root);
    expect(removed).toEqual(["dead"]);
    await expect(fs.access(dead)).rejects.toThrow();
    await expect(fs.access(live)).resolves.toBeUndefined();
    // Stale but recent: the instance may be mid-modal and back in a minute.
    await expect(fs.access(recentlyStale)).resolves.toBeUndefined();
  });

  it("removes an old directory that never got a heartbeat", async () => {
    const dir = path.join(root, "never");
    await fs.mkdir(dir);
    const old = new Date(Date.now() - INSTANCE_DIR_SWEEP_MS - 60_000);
    await fs.utimes(dir, old, old);
    const fresh = path.join(root, "just-created");
    await fs.mkdir(fresh);
    expect(await sweepDeadInstanceDirs(root)).toEqual(["never"]);
    await expect(fs.access(fresh)).resolves.toBeUndefined();
  });
});

// --- Process-aware liveness -------------------------------------------------

function proc(pid: number, startedAt: number | null, multiInstance = false): AeProcess {
  return {
    pid,
    commandLine: `"C:\\AE\\AfterFX.exe"${multiInstance ? " -m" : ""}`,
    multiInstance,
    startedAt,
  };
}

describe("classifyInstance", () => {
  const now = 1_000_000_000;
  const hb = (ageMs: number, busy = false) => ({
    id: "a",
    project: null,
    projectName: null,
    busy,
    ts: now - ageMs,
  });

  it("calls a fresh heartbeat live (or busy), whatever the processes say", () => {
    expect(classifyInstance(hb(1000), now, false)).toBe("live");
    expect(classifyInstance(hb(1000, true), now, null)).toBe("busy");
  });

  it("decides a stale heartbeat by its process", () => {
    expect(classifyInstance(hb(60_000), now, true)).toBe("stalled");
    expect(classifyInstance(hb(60_000, true), now, true)).toBe("busy");
    // The force-killed-while-busy case: the heartbeat says busy forever.
    expect(classifyInstance(hb(60_000, true), now, false)).toBe("dead");
    expect(classifyInstance(hb(60_000), now, false)).toBe("dead");
    // A busy instance whose process runs stays busy past the heartbeat window.
    expect(classifyInstance(hb(HEARTBEAT_BUSY_STALE_MS + 1, true), now, true)).toBe("busy");
  });

  it("falls back to the heartbeat rules without process information", () => {
    expect(classifyInstance(hb(60_000), now, null)).toBe("dead");
    expect(classifyInstance(hb(60_000, true), now, null)).toBe("busy");
    expect(classifyInstance(hb(HEARTBEAT_BUSY_STALE_MS + 1, true), now, null)).toBe("dead");
    expect(classifyInstance(null, now, true)).toBe("dead");
  });
});

describe("matchInstancesToProcesses", () => {
  it("gives each instance the latest process that started at or before its agent", () => {
    const old = proc(1, 1_000);
    const newer = proc(2, 50_000);
    const m = matchInstancesToProcesses(
      [
        { id: "a", startedAt: 9_000 },
        { id: "b", startedAt: 58_000 },
      ],
      [newer, old],
    );
    expect(m.get("a")).toBe(old);
    expect(m.get("b")).toBe(newer);
  });

  it("allows the agent to start a little before the process clock says (slack)", () => {
    const p = proc(1, 10_000);
    expect(matchInstancesToProcesses([{ id: "a", startedAt: 7_000 }], [p], 5_000).get("a")).toBe(p);
    expect(matchInstancesToProcesses([{ id: "a", startedAt: 4_000 }], [p], 5_000).has("a")).toBe(
      false,
    );
  });

  it("uses each process once, oldest instance first", () => {
    // AE (pid 1) still runs; a later AE whose agent started at 60 s was
    // killed. Both instances would pick pid 1; the older one owns it.
    const p = proc(1, 0);
    const m = matchInstancesToProcesses(
      [
        { id: "killed-later", startedAt: 60_000 },
        { id: "running", startedAt: 10_000 },
      ],
      [p],
    );
    expect(m.get("running")).toBe(p);
    expect(m.has("killed-later")).toBe(false);
  });

  it("lets a fresh instance claim first, so a dead leftover never takes its process", () => {
    const p = proc(1, 0);
    const m = matchInstancesToProcesses(
      [
        { id: "leftover", startedAt: 5_000, fresh: false },
        { id: "ticking", startedAt: 20_000, fresh: true },
      ],
      [p],
    );
    expect(m.get("ticking")).toBe(p);
    expect(m.has("leftover")).toBe(false);
  });

  it("matches nothing without a start time on either side", () => {
    const m = matchInstancesToProcesses(
      [
        { id: "a", startedAt: undefined },
        { id: "b", startedAt: 10_000 },
      ],
      [proc(1, null)],
    );
    expect(m.size).toBe(0);
  });
});

function counting(procs: AeProcess[] | null) {
  const source = async () => {
    source.calls++;
    return procs;
  };
  source.calls = 0;
  return source;
}

describe("process-aware listing and targeting", () => {
  it("labels a killed-while-busy instance dead and a quiet running one stalled", async () => {
    const now = Date.now();
    await writeHeartbeat("killed", {
      startedAt: now - 3_600_000,
      busy: true,
      ts: now - 60_000,
    });
    await writeHeartbeat("quiet", { startedAt: now - 600_000, ts: now - 40_000 });
    await writeHeartbeat("fresh", { startedAt: now - 100_000 });
    const procs = [proc(10, now - 610_000), proc(20, now - 110_000)];
    const list = await listInstances(root, now, { processes: counting(procs) });
    const byId = Object.fromEntries(list.map((i) => [i.id, i]));
    expect(byId.killed.state).toBe("dead");
    expect(byId.killed.alive).toBe(false);
    expect(byId.quiet.state).toBe("stalled");
    expect(byId.quiet.alive).toBe(true);
    expect(byId.quiet.process?.pid).toBe(10);
    expect(byId.fresh.state).toBe("live");
    expect(byId.fresh.process?.pid).toBe(20);
    expect(describeInstance(byId.quiet)).toMatch(
      /^untitled \[quiet\] \(stalled: After Effects running \(pid 10\), agent not ticking for 40s\)$/,
    );
    expect(describeInstance(byId.killed)).toContain("dead: After Effects process gone");
  });

  it("does not query processes while every heartbeat is fresh, and remembers proven-dead ones", async () => {
    const now = Date.now();
    await writeHeartbeat("fresh", { startedAt: now - 10_000 });
    const source = counting([]);
    await listInstances(root, now, { processes: source });
    expect(source.calls).toBe(0);
    await listInstances(root, now, { processes: source, matchAll: true });
    expect(source.calls).toBe(1);

    await writeHeartbeat("gone", { startedAt: now - 100_000, ts: now - 60_000, busy: true });
    const first = await listInstances(root, now, { processes: source });
    expect(source.calls).toBe(2);
    expect(first.find((i) => i.id === "gone")?.state).toBe("dead");
    // Nothing that could host it runs, so the next look needs no query.
    const second = await listInstances(root, now, { processes: source });
    expect(source.calls).toBe(2);
    expect(second.find((i) => i.id === "gone")?.state).toBe("dead");
  });

  it("keeps heartbeat rules when the process query has no answer", async () => {
    const now = Date.now();
    await writeHeartbeat("busy-old", { startedAt: now - 100_000, ts: now - 60_000, busy: true });
    const list = await listInstances(root, now, { processes: counting(null) });
    expect(list[0].state).toBe("busy");
    expect(list[0].processChecked).toBe(false);
  });

  it("ignores a dead instance when picking the default target (the 'N instances are live' bug)", async () => {
    const now = Date.now();
    await writeHeartbeat("ae-tg6cvr", {
      startedAt: now - 7_200_000,
      busy: true,
      ts: now - 600_000,
    });
    await writeHeartbeat("ae-y32ytr", { startedAt: now - 600_000 });
    const procs = [proc(48296, now - 608_000)];
    // Without process information the busy leftover still counts…
    const blind = await resolveTarget(null, root, now, { processes: null });
    expect(blind.mode).toBe("error");
    // …with it, the leftover is dead and the call goes to the running one.
    const r = await resolveTarget(null, root, now, { processes: counting(procs) });
    expect(r.mode === "pull" && r.instance.id).toBe("ae-y32ytr");
  });

  it("addresses a stalled instance and explains a dead one", async () => {
    const now = Date.now();
    await writeHeartbeat("stalled", { startedAt: now - 600_000, ts: now - 30_000 });
    await writeHeartbeat("dead", { startedAt: now - 60_000, ts: now - 30_000 });
    const procs = [proc(7, now - 605_000)];
    const stalled = await resolveTarget("stalled", root, now, { processes: counting(procs) });
    expect(stalled.mode === "pull" && stalled.instance.state).toBe("stalled");
    const dead = await resolveTarget("dead", root, now, { processes: counting(procs) });
    expect(dead.mode).toBe("error");
    if (dead.mode === "error") {
      expect(dead.message).toContain("no longer running");
    }
    // Two addressable instances (one stalled) and nothing named: refuse to guess.
    await writeHeartbeat("other", { startedAt: now - 10_000 });
    const both = await resolveTarget(null, root, now, {
      processes: counting([...procs, proc(8, now - 12_000)]),
    });
    expect(both.mode === "error" && both.message).toContain("2 After Effects instances are live");
  });

  it("never sweeps a stalled instance, however old its heartbeat", async () => {
    const now = Date.now();
    const old = now - INSTANCE_DIR_SWEEP_MS - 1000;
    const stalled = await writeHeartbeat("stalled", { startedAt: old - 60_000, ts: old });
    const dead = await writeHeartbeat("dead", { startedAt: old - 10_000, ts: old });
    const procs = [proc(1, old - 70_000)];
    const removed = await sweepDeadInstanceDirs(root, now, { processes: counting(procs) });
    expect(removed).toEqual(["dead"]);
    await expect(fs.access(stalled)).resolves.toBeUndefined();
    await expect(fs.access(dead)).rejects.toThrow();
  });
});
