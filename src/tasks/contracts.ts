// Finds coding contracts on every reachable server, solves and submits them.
// A contract we got wrong is never retried (a wrong solver would just burn its tries);
// it is listed in data/contracts.txt and the self-test shows which solver is off.
import type { NS } from "@ns";
import { SOLVERS } from "../lib/contracts.js";
import { appendJsonl, readJson, writeJson } from "../lib/io.js";
import { allHosts } from "../lib/net.js";
import { DATA } from "../lib/paths.js";
import { task } from "../lib/task-main.js";

export interface ContractsState {
  solved: number;
  failed: string[]; // "host:file"
  unsupported: Record<string, number>; // type → count seen
  lastReward: string;
  /** recent money rewards in $ (the hacknet manager values "Generate Coding Contract" by these) */
  moneyRewards?: number[];
  /** last scan: when, how many servers were checked and how many contracts were on them */
  lastRun?: number;
  hostsScanned?: number;
  found?: number;
}

export async function main(ns: NS): Promise<void> {
  await task(ns, () => {
    const CC = ns.codingcontract;
    const st = readJson<ContractsState>(ns, DATA.contracts, { solved: 0, failed: [], unsupported: {}, lastReward: "" });
    const failed = new Set(st.failed);
    const done: string[] = [];
    const hosts = allHosts(ns);
    st.lastRun = Date.now();
    st.hostsScanned = hosts.length;
    st.found = 0;
    for (const host of hosts) {
      for (const file of ns.ls(host, ".cct")) {
        st.found++;
        const id = `${host}:${file}`;
        if (failed.has(id)) continue;
        const kind = CC.getContractType(file, host);
        const solver = SOLVERS[kind];
        const note = (msg: string) => {
          failed.add(id);
          appendJsonl(ns, DATA.events, { t: Date.now(), kind: "contract", msg: `${kind} on ${host}: ${msg}` });
        };
        if (!solver) {
          st.unsupported[kind] = (st.unsupported[kind] ?? 0) + 1;
          note("no solver");
          continue;
        }
        let answer: unknown;
        try {
          answer = solver(CC.getData(file, host));
        } catch (e) {
          note(`solver threw: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        const reward = CC.attempt(answer, file, host);
        if (!reward) {
          note("wrong answer (won't retry)");
          continue;
        }
        st.solved++;
        st.lastReward = reward;
        const usd = parseMoney(reward);
        if (usd > 0) st.moneyRewards = [...(st.moneyRewards ?? []), usd].slice(-20);
        done.push(`${kind}: ${reward}`);
        appendJsonl(ns, DATA.events, { t: Date.now(), kind: "contract", msg: `solved ${kind} on ${host}: ${reward}` });
      }
    }
    // contracts vanish when solved or out of tries: keep the list bounded
    st.failed = [...failed].slice(-500);
    writeJson(ns, DATA.contracts, st);
    return done;
  });
}

/** "Gained $15.543m" → 15_543_000 (0 if the reward isn't money). */
export function parseMoney(reward: string): number {
  const m = /\$([\d.]+)([kmbtq]?)/i.exec(reward);
  if (!m) return 0;
  const mult: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
  return Number(m[1]) * (mult[m[2].toLowerCase()] ?? 1);
}
