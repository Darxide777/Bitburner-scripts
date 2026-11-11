import { test } from "node:test";
import assert from "node:assert/strict";
import { main as enableMain } from "../dist/user/dnet/enable.js";
import { main as labMain } from "../dist/user/dnet/lab.js";
import { REWARD_PORT, mergeLocalSnapshots, paths, readLabStatus, recordReward } from "../dist/user/dnet/lib.js";

function fileNs(files) {
  return {
    getScriptName: () => "user/dnet/manager.js",
    getHostname: () => "home",
    ls: () => [...files.keys()],
    read: (file) => files.get(file) ?? "",
    write: (file, text) => files.set(file, text),
    rm: (file) => files.delete(file),
  };
}

test("user module paths stay relative to src/user/dnet", () => {
  const p = paths({ getScriptName: () => "user/dnet/manager.js" });
  assert.equal(p.lib, "user/dnet/lib.js");
  assert.equal(p.snap, "user/dnet/snap.json");
  assert.equal(p.charisma, "user/dnet/charisma.txt");
  assert.equal(p.rewards, "user/dnet/rewards.txt");
});

test("reward telemetry is written to the shared reward port", () => {
  const writes = [];
  const ns = { tryWritePort: (port, line) => writes.push([port, line]) };
  recordReward(ns, "darkweb", "loot.cache", { success: true, message: "found $1m", karmaLoss: -3 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], REWARD_PORT);
  assert.match(writes[0][1], /darkweb loot\.cache: found \$1m \(karma -3\)/);
});

test("lab status finds the active labyrinth and reports depth/charisma", () => {
  const ns = {
    dnet: {
      getServerDetails: (host) => {
        if (host === "m3rc1l3ss_l4byr1nth") {
          return {
            isOnline: true,
            modelId: "(The Labyrinth)",
            depth: 19,
            requiredCharismaSkill: 1500,
          };
        }
        return { isOnline: false, modelId: "", depth: -1, requiredCharismaSkill: 0 };
      },
    },
  };
  assert.deepEqual(readLabStatus(ns), {
    host: "m3rc1l3ss_l4byr1nth",
    name: "MercilessLab",
    tier: 3,
    depth: 19,
    charisma: 1500,
  });
});

test("lab status is null without an online labyrinth", () => {
  const ns = {
    dnet: {
      getServerDetails: () => {
        throw new Error("not a darknet server");
      },
    },
  };
  assert.equal(readLabStatus(ns), null);
});

test("enable merges the manager without dropping existing config", async () => {
  const files = new Map([
    [
      "data/config.txt",
      JSON.stringify({ stocksMinHomeGB: 512, userModules: [{ script: "other.js", args: [] }] }),
    ],
  ]);
  const messages = [];
  const ns = {
    ...fileNs(files),
    disableLog: () => {},
    tprint: (message) => messages.push(message),
  };
  await enableMain(ns);
  const config = JSON.parse(files.get("data/config.txt"));
  assert.equal(config.stocksMinHomeGB, 512);
  assert.deepEqual(config.userModules, [
    { script: "other.js", args: [] },
    { script: "user/dnet/manager.js", args: [], minHomeGB: 0 },
  ]);
  await enableMain(ns);
  assert.equal(JSON.parse(files.get("data/config.txt")).userModules.length, 2);
  assert.match(messages[1], /already enabled/);
});

test("snapshot merge keeps the fixed snapshot and unrelated files", () => {
  const files = new Map([
    ["user/dnet/snap.json", JSON.stringify({ alpha: "one" })],
    ["dnet-snap-old.json", JSON.stringify({ beta: "two" })],
    ["tasks/snapshot.js", "not a snapshot"],
  ]);
  const store = {};
  assert.equal(mergeLocalSnapshots(fileNs(files), store), true);
  assert.deepEqual(store, { alpha: "one", beta: "two" });
  assert.ok(files.has("user/dnet/snap.json"));
  assert.ok(!files.has("dnet-snap-old.json"));
  assert.ok(files.has("tasks/snapshot.js"));
  assert.equal(mergeLocalSnapshots(fileNs(files), store), false);
});

const DIRS = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function makeMaze(width, height, random) {
  const w = width % 2 === 0 ? width + 1 : width;
  const h = height % 2 === 0 ? height + 1 : height;
  const maze = Array.from({ length: h }, () => Array(w).fill("█"));
  const stack = [[1, 1]];
  maze[1][1] = " ";
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const options = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]
      .map(([dx, dy]) => [x + dx * 2, y + dy * 2])
      .filter(([nx, ny]) => nx > 0 && nx < w && ny > 0 && ny < h && maze[ny][nx] === "█");
    if (!options.length) {
      stack.pop();
      continue;
    }
    const [nx, ny] = options[Math.floor(random() * options.length)];
    maze[(y + ny) / 2][(x + nx) / 2] = " ";
    maze[ny][nx] = " ";
    stack.push([nx, ny]);
  }
  maze[h - 2][w - 2] = " ";
  return maze;
}

function surroundings(maze, x, y) {
  const row = (yy) => {
    let line = "";
    for (let xx = x - 1; xx <= x + 1; xx++) line += xx === x && yy === y ? "@" : maze[yy]?.[xx] ?? " ";
    return line;
  };
  return [row(y - 1), row(y), row(y + 1)].join("\n");
}

function labNs(maze) {
  let pos = [1, 1];
  const end = [maze[0].length - 2, maze.length - 2];
  const files = new Map([
    ["user/dnet/charisma.txt", "10000"],
    ["user/dnet/passwords.json", "{}"],
  ]);
  const logs = [];
  const ns = {
    args: ["NormalLab", 300],
    disableLog() {},
    getHostname: () => "neighbor",
    getScriptName: () => "user/dnet/lab.js",
    print: (message) => logs.push(message),
    tprint: (message) => logs.push("T:" + message),
    sleep: async () => {},
    read: (file) => files.get(file) ?? "",
    write: (file, text) => files.set(file, text),
    rm: (file) => files.delete(file),
    ls: () => [],
    scp: () => true,
    exec: () => 1,
    dnet: {
      async labreport() {
        return {
          success: true,
          coords: [...pos],
          north: maze[pos[1] - 1]?.[pos[0]] === " ",
          east: maze[pos[1]]?.[pos[0] + 1] === " ",
          south: maze[pos[1] + 1]?.[pos[0]] === " ",
          west: maze[pos[1]]?.[pos[0] - 1] === " ",
        };
      },
      async authenticate(_host, input) {
        const direction = DIRS[String(input).toLowerCase().split(" ")[0]];
        if (!direction) return { success: false, code: 401, message: "not a direction", data: surroundings(maze, ...pos) };
        const wall = [pos[0] + direction[0], pos[1] + direction[1]];
        if (maze[wall[1]]?.[wall[0]] !== " ") {
          return {
            success: false,
            code: 401,
            message: `You cannot go that way. You are still at ${pos[0]},${pos[1]}.`,
            data: surroundings(maze, ...pos),
          };
        }
        pos = [pos[0] + direction[0] * 2, pos[1] + direction[1] * 2];
        if (pos[0] === end[0] && pos[1] === end[1]) {
          return { success: true, code: 200, message: "labyrinth solved", data: "secret" };
        }
        return { success: false, code: 401, message: `You have moved to ${pos[0]},${pos[1]}.`, data: surroundings(maze, ...pos) };
      },
    },
  };
  return { ns, logs };
}

test("labyrinth solver handles deterministic random mazes", async () => {
  const random = rng(123456789);
  for (let i = 0; i < 50; i++) {
    const width = 7 + Math.floor(random() * 10) * 2;
    const height = 5 + Math.floor(random() * 8) * 2;
    const { ns, logs } = labNs(makeMaze(width, height, random));
    await labMain(ns);
    assert.ok(logs.some((line) => line.includes("solved NormalLab")), logs.join("\n"));
    assert.ok(!logs.some((line) => line.includes("failed")), logs.join("\n"));
  }
});
