// Discovery and selection of After Effects instances on the pull path.
//
// Every instance running the resident agent (jsx/agent.jsx) keeps
// <runtime>/instances/<id>/heartbeat.json fresh — every second while idle,
// flagged `busy` around a request (ticks do not fire while a script runs, so a
// long call silences the heartbeat legitimately). This module reads those
// files and turns "which AE should this call go to" into a decision the
// transport can act on without touching AE.
//
// A heartbeat alone cannot tell a dead instance from a quiet one: a force-
// killed AE leaves a heartbeat that may say `busy` forever, while a live AE
// that is rendering, showing a modal, or whose scheduled task simply stopped
// firing goes quiet too. So once a heartbeat is stale, the instance is tied
// to a running AfterFX.exe by start time (matchInstancesToProcesses) and its
// state comes from whether that process still runs:
//
//   live     fresh heartbeat
//   busy     the last heartbeat said `busy` and its process runs (a request
//            is executing; ticks resume when it returns)
//   stalled  its process runs but the heartbeat is stale and not busy (AE
//            busy rendering, a modal dialog, or a scheduled task that stopped
//            firing — see the transport's re-arm)
//   dead     no matching process. Without process information (not Windows,
//            or the query failed) the heartbeat rules decide alone: stale and
//            not busy, or busy for longer than HEARTBEAT_BUSY_STALE_MS.
//
// Every state but `dead` is addressable: a request written to a busy or
// stalled instance's mailbox waits there until its agent ticks again.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  HEARTBEAT_BUSY_STALE_MS,
  HEARTBEAT_FILENAME,
  HEARTBEAT_STALE_MS,
  INSTANCE_DIR_SWEEP_MS,
  INSTANCES_DIR,
  sanitizeInstanceId,
} from "../config.js";
import { type AeProcess, type AeProcessLister, cachedAeProcesses } from "./processes.js";

/** What jsx/agent.jsx writes. Every field but `id`/`ts` is best-effort. */
export interface Heartbeat {
  id: string;
  idSource?: "env" | "random";
  agentVersion?: number;
  aeVersion?: string;
  project: string | null;
  projectName: string | null;
  dirty?: boolean;
  numItems?: number;
  startedAt?: number;
  ticks?: number;
  served?: number;
  busy?: boolean;
  busySince?: number | null;
  /** Times the scheduled task was re-armed (agent v2+). */
  rearms?: number;
  lastError?: string | null;
  /** Epoch milliseconds, AE's clock — same machine as ours. */
  ts: number;
}

export type InstanceState = "live" | "busy" | "stalled" | "dead";

export interface InstanceInfo {
  id: string;
  dir: string;
  heartbeat: Heartbeat | null;
  /** Milliseconds since the last heartbeat, or null without one. */
  ageMs: number | null;
  /** Addressable: any state but `dead`. */
  alive: boolean;
  state: InstanceState;
  /** The AfterFX.exe this instance runs in, when running processes were matched. */
  process: AeProcess | null;
  /** True when the state was decided with the list of running processes in hand. */
  processChecked: boolean;
}

/**
 * Heartbeat-only liveness (the rule without process information): a fresh
 * heartbeat, or a busy one within the long window.
 */
export function isAlive(heartbeat: Heartbeat | null, now: number = Date.now()): boolean {
  if (heartbeat === null || typeof heartbeat.ts !== "number") return false;
  const age = now - heartbeat.ts;
  return age < (heartbeat.busy ? HEARTBEAT_BUSY_STALE_MS : HEARTBEAT_STALE_MS);
}

/** The agent wrote within HEARTBEAT_STALE_MS: it is ticking, whatever else is true. */
export function isFresh(heartbeat: Heartbeat | null, now: number = Date.now()): boolean {
  return (
    heartbeat !== null &&
    typeof heartbeat.ts === "number" &&
    now - heartbeat.ts < HEARTBEAT_STALE_MS
  );
}

/**
 * The state of one instance. `processRunning`: whether the AfterFX.exe it was
 * matched to still runs — true / false — or null when no process information
 * is available, which falls back to the heartbeat rules alone.
 */
export function classifyInstance(
  heartbeat: Heartbeat | null,
  now: number,
  processRunning: boolean | null,
): InstanceState {
  if (heartbeat === null || typeof heartbeat.ts !== "number") return "dead";
  if (isFresh(heartbeat, now)) return heartbeat.busy ? "busy" : "live";
  if (processRunning === null) return isAlive(heartbeat, now) ? "busy" : "dead";
  if (!processRunning) return "dead";
  return heartbeat.busy ? "busy" : "stalled";
}

/** An agent starts a few to ~30 s after its After Effects; this covers clock rounding on the other side. */
export const PROCESS_MATCH_SLACK_MS = 5_000;

export interface MatchCandidate {
  id: string;
  /** heartbeat.startedAt: when the agent started inside its AE. */
  startedAt: number | null | undefined;
  /** A fresh heartbeat proves the instance runs; such instances claim processes first. */
  fresh?: boolean;
}

/**
 * Tie instances to the After Effects processes they run in.
 *
 * Each instance gets the process whose start time is the LATEST one at or
 * before its agent's `startedAt` (+ `slackMs`), and each process hosts at
 * most one instance (the agent refuses to install twice per process).
 * Instances claim in order: fresh heartbeats first — those certainly run
 * somewhere, so a dead leftover never takes their process — then by
 * `startedAt`, oldest first. An instance without `startedAt`, or with no
 * eligible process left, gets none. Pure.
 */
export function matchInstancesToProcesses<P extends { startedAt: number | null }>(
  instances: MatchCandidate[],
  processes: P[],
  slackMs: number = PROCESS_MATCH_SLACK_MS,
): Map<string, P> {
  const order = instances.filter(
    (i): i is MatchCandidate & { startedAt: number } => typeof i.startedAt === "number",
  );
  // A fresh array from filter(): sorting it in place touches nothing else.
  // oxlint-disable-next-line unicorn/no-array-sort
  order.sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh) || a.startedAt - b.startedAt);
  const used = new Set<P>();
  const out = new Map<string, P>();
  for (const inst of order) {
    let best: P | null = null;
    for (const p of processes) {
      if (used.has(p) || p.startedAt === null) continue;
      if (p.startedAt > inst.startedAt + slackMs) continue;
      if (best === null || (best.startedAt as number) < p.startedAt) best = p;
    }
    if (best !== null) {
      used.add(best);
      out.set(inst.id, best);
    }
  }
  return out;
}

/**
 * Instances proven dead, keyed by directory + startedAt + last heartbeat:
 * once no process that could host an instance runs, none ever will again
 * (a later process starts after it), so its stale heartbeat need not trigger
 * another process query. A changed heartbeat is a new key.
 */
const provenDead = new Set<string>();

function deadKey(info: InstanceInfo): string {
  return `${info.dir}|${info.heartbeat?.startedAt ?? "?"}|${info.heartbeat?.ts ?? "?"}`;
}

/**
 * Re-derive every instance's state from the running processes. `processes`
 * null keeps the heartbeat-only states. Pure apart from remembering the
 * instances it proves dead.
 */
export function applyProcesses(
  infos: InstanceInfo[],
  processes: AeProcess[] | null,
  now: number = Date.now(),
): InstanceInfo[] {
  if (processes === null) return infos;
  const matches = matchInstancesToProcesses(
    infos.map((i) => ({
      id: i.id,
      startedAt: i.heartbeat?.startedAt,
      fresh: isFresh(i.heartbeat, now),
    })),
    processes,
  );
  const claimedByFresh = new Set<AeProcess>();
  for (const i of infos) {
    const p = matches.get(i.id);
    if (p && isFresh(i.heartbeat, now)) claimedByFresh.add(p);
  }
  return infos.map((i) => {
    const proc = matches.get(i.id) ?? null;
    const state = classifyInstance(i.heartbeat, now, proc !== null);
    if (state === "dead" && i.heartbeat !== null) {
      // Certain only when nothing that could host it runs, or every such
      // process provably hosts a ticking instance.
      const startedAt = i.heartbeat.startedAt;
      const hosts = processes.filter(
        (p) =>
          typeof startedAt === "number" &&
          p.startedAt !== null &&
          p.startedAt <= startedAt + PROCESS_MATCH_SLACK_MS,
      );
      if (hosts.every((p) => claimedByFresh.has(p))) provenDead.add(deadKey(i));
    }
    return { ...i, process: proc, processChecked: true, state, alive: state !== "dead" };
  });
}

// --- Where process information comes from -----------------------------------

let processSource: AeProcessLister | null = cachedAeProcesses;

/** The process lister instance lookups use by default (cached). */
export function getInstanceProcessSource(): AeProcessLister | null {
  return processSource;
}

/**
 * Replace the default process lister (tests). `null` = no process
 * information (heartbeat rules only). Returns a function restoring the old one.
 */
export function setInstanceProcessSource(source: AeProcessLister | null): () => void {
  const previous = processSource;
  processSource = source;
  return () => {
    processSource = previous;
  };
}

/** Describe one instance directory from its heartbeat alone. Never throws; a missing or torn heartbeat reads as dead. */
export async function readInstance(dir: string, now: number = Date.now()): Promise<InstanceInfo> {
  const id = path.basename(dir);
  let heartbeat: Heartbeat | null = null;
  try {
    const raw = await fs.readFile(path.join(dir, HEARTBEAT_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<Heartbeat>;
    if (parsed && typeof parsed.ts === "number") {
      heartbeat = {
        ...parsed,
        id: typeof parsed.id === "string" ? parsed.id : id,
        project: typeof parsed.project === "string" ? parsed.project : null,
        projectName: typeof parsed.projectName === "string" ? parsed.projectName : null,
        ts: parsed.ts,
      };
    }
  } catch {
    /* no heartbeat yet, unreadable, or mid-rename — dead until proven otherwise */
  }
  const state = classifyInstance(heartbeat, now, null);
  return {
    id,
    dir,
    heartbeat,
    ageMs: heartbeat ? now - heartbeat.ts : null,
    alive: state !== "dead",
    state,
    process: null,
    processChecked: false,
  };
}

export interface ListOptions {
  /** Process lister; null = heartbeat rules only. Default: getInstanceProcessSource(). */
  processes?: AeProcessLister | null;
  /**
   * Query processes even when every heartbeat is fresh, so each instance
   * carries its pid (instance.list, instance.stop). By default the query runs
   * only when some heartbeat is stale and not already proven dead.
   */
  matchAll?: boolean;
}

/** Every instance directory, alive or not, sorted by id. */
export async function listInstances(
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
  options: ListOptions = {},
): Promise<InstanceInfo[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(instancesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  let infos: InstanceInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    infos.push(await readInstance(path.join(instancesDir, entry.name), now));
  }
  infos.sort((a, b) => a.id.localeCompare(b.id));

  const source = options.processes === undefined ? processSource : options.processes;
  if (source === null) return infos;
  const unsettled = infos.some(
    (i) => i.heartbeat !== null && !isFresh(i.heartbeat, now) && !provenDead.has(deadKey(i)),
  );
  if (unsettled || (options.matchAll && infos.some((i) => i.heartbeat !== null))) {
    const procs = await source();
    if (procs !== null) return applyProcesses(infos, procs, now);
  }
  // No query needed (or none possible): what is already proven dead stays dead.
  for (const i of infos) {
    if (i.heartbeat !== null && !isFresh(i.heartbeat, now) && provenDead.has(deadKey(i))) {
      i.state = "dead";
      i.alive = false;
      i.processChecked = true;
    }
  }
  return infos;
}

/** One instance by id (directory name) with its process-aware state; null when there is no such directory. */
export async function findInstance(
  id: string,
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
  options: ListOptions = {},
): Promise<InstanceInfo | null> {
  return (await listInstances(instancesDir, now, options)).find((i) => i.id === id) ?? null;
}

function projectStem(name: string): string {
  return path
    .basename(name)
    .toLowerCase()
    .replace(/\.aepx?$/i, "");
}

/** Case-insensitive, separator-agnostic form of a path for equality checks. */
function projectPathKey(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Does `target` (as the user wrote it) name this instance? Three forms:
 *   - an id, matched exactly or after the same sanitizing the agent applied;
 *   - a project file name, with or without its extension, matched
 *     case-insensitively on the stem — "shotA" and "ShotA.aep" both address
 *     the instance that has ShotA.aep open;
 *   - a project PATH (anything containing a separator), matched on the whole
 *     resolved path — the way to pick one of two instances whose projects
 *     share a file name in different folders.
 */
export function matchesTarget(instance: InstanceInfo, target: string): boolean {
  const wanted = target.trim();
  if (wanted.length === 0) return false;
  if (instance.id === wanted || instance.id === sanitizeInstanceId(wanted)) return true;
  const hb = instance.heartbeat;
  if (/[\\/]/.test(wanted)) {
    return hb?.project ? projectPathKey(hb.project) === projectPathKey(wanted) : false;
  }
  const project = hb?.projectName ?? (hb?.project ? path.basename(hb.project) : null);
  if (!project) return false;
  return projectStem(project) === projectStem(wanted);
}

export type TargetResolution =
  | { mode: "push" }
  | { mode: "pull"; instance: InstanceInfo }
  | { mode: "error"; message: string; hint: string };

const INSTALL_HINT =
  "Each instance needs the resident agent: run `npx @kumoproductions/mcp-aftereffects install-agent` " +
  "once per After Effects version, then (re)start After Effects — the agent registers about ten " +
  "seconds after launch. To name an instance, set AE_MCP_INSTANCE in the environment that launches it " +
  "(works with `AfterFX.exe -m`); the server-side AE_MCP_INSTANCE can also name the project file it has open.";

/**
 * How an instance is named to people and models: the project it has open
 * first, because that is what anyone actually thinks of it as, then the id
 * in brackets — needed to address it when the project is untitled or open
 * twice. `ShotA.aep [ae-t6s4fl]`, `untitled [ae-9k2p1q]`.
 */
export function instanceLabel(instance: InstanceInfo): string {
  const project = instance.heartbeat?.projectName ?? "untitled";
  return `${project} [${instance.id}]`;
}

function secs(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/**
 * The state in words: "live, seen 0s ago", "busy: serving a request for 42s
 * (pid 4711)", "stalled: After Effects running (pid 4711), agent not ticking
 * for 40s", "dead: After Effects process gone, last seen 3600s ago".
 */
export function stateDetail(instance: InstanceInfo, now: number = Date.now()): string {
  const hb = instance.heartbeat;
  const age = instance.ageMs;
  const pid = instance.process ? `pid ${instance.process.pid}` : null;
  switch (instance.state) {
    case "live":
      return `live, seen ${secs(age ?? 0)} ago`;
    case "busy": {
      const since = typeof hb?.busySince === "number" ? hb.busySince : (hb?.ts ?? now);
      return `busy: serving a request for ${secs(now - since)}${pid ? ` (${pid})` : ""}`;
    }
    case "stalled":
      return `stalled: After Effects running${pid ? ` (${pid})` : ""}, agent not ticking for ${secs(age ?? 0)}`;
    case "dead":
      if (age === null) return "dead: never seen";
      return instance.processChecked
        ? `dead: After Effects process gone, last seen ${secs(age)} ago`
        : `dead: heartbeat stopped ${secs(age)} ago`;
  }
}

export function describeInstance(instance: InstanceInfo): string {
  return `${instanceLabel(instance)} (${stateDetail(instance)})`;
}

export function instanceSummary(instances: InstanceInfo[]): string {
  return instances.length === 0 ? "none" : instances.map(describeInstance).join("; ");
}

/**
 * Decide where a call goes.
 *
 * Only addressable instances (any state but `dead`) take part. With a target:
 * exactly one must match. Without one: pull to the single addressable
 * instance if there is one, push when there is none — the pre-agent
 * behaviour, so a user who never installed the agent sees no change — and
 * refuse when several are, because guessing would drive the wrong project.
 */
export async function resolveTarget(
  target: string | null,
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
  options: ListOptions = {},
): Promise<TargetResolution> {
  const all = await listInstances(instancesDir, now, options);
  const live = all.filter((i) => i.alive);

  if (target === null) {
    if (live.length === 0) return { mode: "push" };
    if (live.length === 1) return { mode: "pull", instance: live[0] };
    return {
      mode: "error",
      message:
        `${live.length} After Effects instances are live and none was named — ` +
        `set AE_MCP_INSTANCE to one of: ${live.map(instanceLabel).join(", ")}`,
      hint:
        'Name the instance by its id or by the project file it has open (e.g. "shotA" or "shotA.aep"): ' +
        "AE_MCP_INSTANCE on the server picks its default, and every tool takes an `instance` argument to " +
        `address another for one call. Live instances: ${instanceSummary(live)}.`,
    };
  }

  const matches = live.filter((i) => matchesTarget(i, target));
  if (matches.length === 1) return { mode: "pull", instance: matches[0] };
  if (matches.length > 1) {
    return {
      mode: "error",
      message:
        `'${target}' matches ${matches.length} live After Effects instances: ` +
        matches.map(instanceLabel).join(", "),
      hint: `Address one of them by id instead. Live instances: ${instanceSummary(live)}.`,
    };
  }
  const dead = all.filter((i) => !i.alive && matchesTarget(i, target));
  let why: string;
  if (dead.length > 0) {
    const ago = Math.round((dead[0].ageMs ?? 0) / 1000);
    why = dead[0].processChecked
      ? ` — it was last seen ${ago}s ago and its After Effects process is no longer running (it quit or crashed)`
      : ` — it was last seen ${ago}s ago and has stopped ticking (After Effects quit, crashed, or is stuck in a modal dialog)`;
  } else {
    why =
      live.length > 0
        ? `; live instances: ${instanceSummary(live)}`
        : "; no instance has a live agent";
  }
  return {
    mode: "error",
    message: `no live After Effects instance matches '${target}'${why}`,
    hint: INSTALL_HINT,
  };
}

/**
 * Remove instance directories nobody can still be using: dead (by process
 * when that is known) and silent for INSTANCE_DIR_SWEEP_MS, or no heartbeat
 * at all in a directory that old (an agent creates the directory and
 * heartbeats within the same tick). A stalled instance is never removed,
 * however old its heartbeat: its agent would have nowhere to write when it
 * ticks again. Returns the ids removed. Best-effort — a directory that
 * vanishes or is held open underneath us is simply left for the next sweep.
 */
export async function sweepDeadInstanceDirs(
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
  options: ListOptions = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const instance of await listInstances(instancesDir, now, options)) {
    if (instance.state !== "dead") continue;
    let lastActivity: number | null = instance.heartbeat?.ts ?? null;
    if (lastActivity === null) {
      try {
        lastActivity = (await fs.stat(instance.dir)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - lastActivity < INSTANCE_DIR_SWEEP_MS) continue;
    try {
      await fs.rm(instance.dir, { recursive: true, force: true });
      removed.push(instance.id);
    } catch {
      /* raced with a returning agent, or locked — next time */
    }
  }
  return removed;
}
