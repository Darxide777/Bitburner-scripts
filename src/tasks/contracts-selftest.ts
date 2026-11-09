// Checks every solver against the game: creates a dummy contract of each type on home,
// solves and submits it, and records failures with the game's own description and data.
// The daemon runs it once per build (data/contracts-selftest.txt carries the build hash).
// args: (result file), build hash
import type { NS } from "@ns";
import { SOLVERS } from "../lib/contracts.js";
import { appendJsonl, replacer } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import { task } from "../lib/task-main.js";

export interface SelftestResult {
  build: string;
  t: number;
  passed: string[];
  failed: { kind: string; why: string; desc?: string; data?: string; answer?: string }[];
}

export async function main(ns: NS): Promise<void> {
  await task(ns, (args) => {
    const CC = ns.codingcontract;
    const res: SelftestResult = { build: String(args[0] ?? ""), t: Date.now(), passed: [], failed: [] };
    const show = (v: unknown) => JSON.stringify(v, replacer)?.slice(0, 2000);
    for (const kind of CC.getContractTypes()) {
      const file = CC.createDummyContract(kind, "home");
      if (!file) {
        res.failed.push({ kind, why: "couldn't create a dummy" });
        continue;
      }
      const data = CC.getData(file, "home");
      // before attempting: a wrong last try deletes the file
      const desc = CC.getDescription(file, "home");
      const tries = CC.getNumTriesRemaining(file, "home");
      const solver = SOLVERS[kind];
      let answer: unknown;
      let why = "";
      if (!solver) why = "no solver";
      else
        try {
          answer = solver(data);
        } catch (e) {
          why = `solver threw: ${e instanceof Error ? e.message : String(e)}`;
        }
      if (!why) {
        // solved = a reward string, or (dummies may pay nothing) the file is gone although
        // a wrong answer would have left tries on it
        const reward = CC.attempt(answer, file, "home");
        if (!reward && (ns.fileExists(file, "home") || tries <= 1)) why = "wrong answer";
      }
      if (why) res.failed.push({ kind, why, desc, data: show(data), answer: show(answer) });
      else res.passed.push(kind);
      if (ns.fileExists(file, "home")) ns.rm(file, "home");
    }
    ns.write(DATA.contractsSelftest, JSON.stringify(res, replacer), "w");
    appendJsonl(ns, DATA.events, {
      t: Date.now(),
      kind: "contract",
      msg: `solver self-test: ${res.passed.length} passed, ${res.failed.length} failed${res.failed.length ? ` (${res.failed.map((f) => f.kind).join(", ")})` : ""}`,
    });
    return { passed: res.passed.length, failed: res.failed.map((f) => f.kind) };
  });
}
