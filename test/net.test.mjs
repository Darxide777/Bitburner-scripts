// Network traversal tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { allHosts, pathTo } from "../dist/lib/net.js";

const graph = {
  home: ["a", "b"],
  a: ["home", "c"],
  b: ["home"],
  c: ["a", "d"],
  d: ["c"],
};
const ns = { scan: (host) => graph[host] ?? [] };

test("allHosts returns every reachable server in BFS order", () => {
  assert.deepEqual(allHosts(ns), ["home", "a", "b", "c", "d"]);
});

test("pathTo returns the shortest path, excluding home", () => {
  assert.deepEqual(pathTo(ns, "d"), ["a", "c", "d"]);
  assert.equal(pathTo(ns, "missing"), null);
});
