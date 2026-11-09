// Local log archive tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchive, lineKey } from "../tools/archive.mjs";

const L = (t, x = "") => JSON.stringify({ t, x });

test("archive appends only new lines: no duplicates, no losses, survives in-game trimming", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-archive-"));
  const archive = makeArchive(dir);
  assert.equal(archive("m", [L(1), L(2), L(2, "b")].join("\n")), 3);
  assert.equal(archive("m", [L(1), L(2), L(2, "b")].join("\n")), 0, "same content again");
  // the game trimmed old lines and added new ones, including another at the same ms
  assert.equal(archive("m", [L(2, "b"), L(2, "c"), L(3)].join("\n")), 2);
  const lines = readFileSync(join(dir, "m.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(lines, [L(1), L(2), L(2, "b"), L(2, "c"), L(3)]);
  // a fresh archiver (sync restarted) picks up from the file's tail
  const again = makeArchive(dir);
  assert.equal(again("m", [L(2, "c"), L(3), L(4)].join("\n")), 1);
});

test("trace lines are keyed by their ISO timestamp", () => {
  assert.equal(lineKey("2026-11-09T04:51:44.151Z table entering"), Date.parse("2026-11-09T04:51:44.151Z"));
  assert.equal(lineKey("no time here"), null);
  assert.equal(lineKey('{"t":5}'), 5);
});
