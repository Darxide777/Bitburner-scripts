// Destroys w0r1d_d43m0n and starts the next BitNode, restarting daemon.js there.
// args: (result file), nextNode
import type { NS } from "@ns";
import { appendJsonl } from "../lib/io.js";
import { DATA, SCRIPTS } from "../lib/paths.js";

export async function main(ns: NS): Promise<void> {
  const next = Number(ns.args[1]) || 12;
  appendJsonl(ns, DATA.events, { t: Date.now(), kind: "destroy", msg: `destroying w0r1d_d43m0n → BN${next}` });
  ns.singularity.destroyW0r1dD43m0n(next, SCRIPTS.daemon);
}
