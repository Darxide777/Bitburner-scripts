// Installs a backdoor on one server. args: hostname
// Long-running (takes ~1/4 of the server's hack time), so the daemon spawns it
// without waiting. Leaves the terminal connected to home afterwards.
import type { NS } from "@ns";
import { pathTo } from "../lib/net.js";
import { task } from "../lib/task-main.js";

export async function main(ns: NS): Promise<void> {
  await task(ns, async (args) => {
    const host = String(args[0]);
    const path = pathTo(ns, host);
    if (!path) throw new Error(`no path to ${host}`);
    const sing = ns.singularity;
    try {
      sing.connect("home");
      for (const h of path) if (!sing.connect(h)) throw new Error(`could not connect to ${h}`);
      await sing.installBackdoor();
    } finally {
      sing.connect("home");
    }
    return host;
  });
}
