import { describe, expect, it } from "vitest";
import { isMultiInstanceCommandLine, parseProcessJson } from "../src/transport/processes.js";

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
      { pid: 5, commandLine: `${EXE} -m`, multiInstance: true },
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
