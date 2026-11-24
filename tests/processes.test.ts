import { describe, expect, it } from "vitest";
import {
  type AeProcess,
  cachedProcessLister,
  isMultiInstanceCommandLine,
  parseProcessJson,
} from "../src/transport/processes.js";

const EXE = '"C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe"';

describe("isMultiInstanceCommandLine", () => {
  it("flags -m", () => {
    expect(isMultiInstanceCommandLine(`${EXE} -m`)).toBe(true);
    expect(isMultiInstanceCommandLine(`${EXE} -m "D:\\show\\a.aep"`)).toBe(true);
  });
  it("does not flag plain launches or -m inside quoted paths", () => {
    expect(isMultiInstanceCommandLine(EXE)).toBe(false);
    expect(isMultiInstanceCommandLine(`${EXE} "D:\\show -m\\a.aep"`)).toBe(false);
    expect(isMultiInstanceCommandLine(`${EXE} -r "C:\\tmp\\dispatcher.jsx"`)).toBe(false);
    // as seen live: Windows truncated the file argument, leaving an open quote
    expect(isMultiInstanceCommandLine(`${EXE} "D:\\Resilio\\SLIH -m`)).toBe(false);
  });
});

describe("parseProcessJson", () => {
  it("handles none, one and many", () => {
    expect(parseProcessJson("")).toEqual([]);
    expect(parseProcessJson(JSON.stringify({ pid: 5, cmd: `${EXE} -m` }))).toEqual([
      { pid: 5, commandLine: `${EXE} -m`, multiInstance: true, startedAt: null },
    ]);
    const many = parseProcessJson(
      JSON.stringify([
        { pid: 1, cmd: EXE },
        { pid: 2, cmd: null },
      ]),
    );
    expect(many.map((p) => [p.pid, p.multiInstance])).toEqual([
      [1, false],
      [2, false],
    ]);
  });
});

describe("process start times", () => {
  it("parses the creation time as epoch ms, null when absent", () => {
    const rows = parseProcessJson(
      JSON.stringify([
        { pid: 1, cmd: EXE, started: 1795555011041 },
        { pid: 2, cmd: EXE, started: null },
        { pid: 3, cmd: EXE },
      ]),
    );
    expect(rows.map((p) => p.startedAt)).toEqual([1795555011041, null, null]);
  });
});

describe("cachedProcessLister", () => {
  it("answers from one query within the window and shares a query in flight", async () => {
    let calls = 0;
    const rows: AeProcess[] = [{ pid: 1, commandLine: EXE, multiInstance: false, startedAt: 1 }];
    const cached = cachedProcessLister(async () => {
      calls++;
      return rows;
    }, 10_000);
    const [a, b] = await Promise.all([cached(), cached()]);
    expect(a).toBe(rows);
    expect(b).toBe(rows);
    await cached();
    expect(calls).toBe(1);
  });

  it("asks again once the window has passed, and reads a failed query as unknown", async () => {
    let calls = 0;
    const cached = cachedProcessLister(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return [];
    }, 0);
    expect(await cached()).toBeNull();
    expect(await cached()).toEqual([]);
    expect(calls).toBe(2);
  });
});
