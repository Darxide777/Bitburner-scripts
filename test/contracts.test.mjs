// Coding contract solver tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOLVERS, _internal } from "../dist/lib/contracts.js";

const S = (type, data) => SOLVERS[type](data);
const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());

test("number theory", () => {
  assert.equal(S("Find Largest Prime Factor", 13195), 29);
  assert.equal(S("Find Largest Prime Factor", 600851475143), 6857);
  assert.equal(S("Find Largest Prime Factor", 2), 2);
  assert.equal(S("Total Ways to Sum", 5), 6);
  assert.equal(S("Total Ways to Sum II", [5, [1, 2, 5]]), 4);
  assert.equal(S("Total Number of Primes", [1, 10]), 4);
  assert.equal(S("Total Number of Primes", [10, 30]), 6);
  assert.equal(S("Total Number of Primes", [2, 2]), 1);
  assert.equal(S("Total Number of Primes", [1, 2_000_000]), 148933);
  assert.equal(S("Square Root", 16n), 4n);
  assert.equal(S("Square Root", 20n), 4n);
  assert.equal(S("Square Root", 21n), 5n);
  assert.equal(S("Square Root", 10n ** 40n), 10n ** 20n);
  assert.equal(S("Square Root", 10n ** 40n + 10n ** 20n + 1n), 10n ** 20n + 1n); // just past the midpoint
});

test("arrays", () => {
  assert.equal(S("Subarray with Maximum Sum", [-2, 1, -3, 4, -1, 2, 1, -5, 4]), 6);
  assert.equal(S("Subarray with Maximum Sum", [-3, -1, -2]), -1);
  assert.deepEqual(S("Spiralize Matrix", [[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [1, 2, 3, 6, 9, 8, 7, 4, 5]);
  assert.deepEqual(S("Spiralize Matrix", [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]), [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7]);
  assert.deepEqual(S("Spiralize Matrix", [[1], [2], [3]]), [1, 2, 3]);
  assert.equal(S("Array Jumping Game", [2, 3, 1, 1, 4]), 1);
  assert.equal(S("Array Jumping Game", [3, 2, 1, 0, 4]), 0);
  assert.equal(S("Array Jumping Game II", [2, 3, 1, 1, 4]), 2);
  assert.equal(S("Array Jumping Game II", [3, 2, 1, 0, 4]), 0);
  assert.equal(S("Array Jumping Game II", [0]), 0);
  assert.deepEqual(S("Merge Overlapping Intervals", [[1, 3], [8, 10], [2, 6], [10, 12]]), [[1, 6], [8, 12]]);
  assert.equal(S("Minimum Path Sum in a Triangle", [[2], [3, 4], [6, 5, 7], [4, 1, 8, 3]]), 11);
});

test("stock traders", () => {
  assert.equal(S("Algorithmic Stock Trader I", [7, 1, 5, 3, 6, 4]), 5);
  assert.equal(S("Algorithmic Stock Trader II", [7, 1, 5, 3, 6, 4]), 7);
  assert.equal(S("Algorithmic Stock Trader III", [3, 3, 5, 0, 0, 3, 1, 4]), 6);
  assert.equal(S("Algorithmic Stock Trader IV", [2, [3, 2, 6, 5, 0, 3]]), 7);
  assert.equal(S("Algorithmic Stock Trader I", [5, 4, 3]), 0);
});

test("grids and graphs", () => {
  assert.equal(S("Unique Paths in a Grid I", [3, 7]), 28);
  assert.equal(S("Unique Paths in a Grid II", [[0, 0, 0], [0, 1, 0], [0, 0, 0]]), 2);
  assert.equal(S("Shortest Path in a Grid", [[0, 1, 0, 0, 0], [0, 0, 0, 1, 0]]), "DRRURRD");
  assert.equal(S("Shortest Path in a Grid", [[0, 1], [1, 0]]), "");
  assert.deepEqual(S("Proper 2-Coloring of a Graph", [4, [[0, 2], [0, 3], [1, 2], [1, 3]]]), [0, 0, 1, 1]);
  assert.deepEqual(S("Proper 2-Coloring of a Graph", [3, [[0, 1], [0, 2], [1, 2]]]), []);
  assert.deepEqual(S("Largest Rectangle in a Matrix", [[1, 0, 0], [1, 0, 0], [0, 0, 1]]), [[0, 1], [1, 2]]);
});

test("strings", () => {
  sameSet(S("Generate IP Addresses", "25525511135"), ["255.255.11.135", "255.255.111.35"]);
  sameSet(S("Generate IP Addresses", "1938718066"), ["193.87.180.66"]);
  sameSet(S("Sanitize Parentheses in Expression", "()())()"), ["()()()", "(())()"]);
  sameSet(S("Sanitize Parentheses in Expression", "(a)())()"), ["(a)()()", "(a())()"]);
  sameSet(S("Sanitize Parentheses in Expression", ")("), [""]);
  sameSet(S("Find All Valid Math Expressions", ["123", 6]), ["1+2+3", "1*2*3"]);
  sameSet(S("Find All Valid Math Expressions", ["105", 5]), ["1*0+5", "10-5"]);
  assert.equal(S("Encryption I: Caesar Cipher", ["DEBUG ME", 3]), "ABYRD JB");
  assert.equal(S("Encryption II: Vigenère Cipher", ["DASHBOARD", "LINUX"]), "OIFBYZIEX");
});

test("hamming codes match the game's examples and round-trip with one flipped bit", () => {
  assert.equal(S("HammingCodes: Integer to Encoded Binary", 8), "11110000");
  assert.equal(S("HammingCodes: Encoded Binary to Integer", "11110000"), 8);
  assert.equal(S("HammingCodes: Encoded Binary to Integer", "11110010"), 8);
  for (const n of [1, 2, 3, 21, 255, 1023, 123456789, 2 ** 40 + 12345]) {
    const enc = _internal.hammingEncode(n);
    assert.equal(_internal.hammingDecode(enc), n);
    for (let i = 0; i < enc.length; i++) {
      const bad = enc.slice(0, i) + (enc[i] === "1" ? "0" : "1") + enc.slice(i + 1);
      assert.equal(_internal.hammingDecode(bad), n, `n=${n} flip ${i}`);
    }
  }
});

test("compression: RLE, LZ round trip at (at most) the documented lengths", () => {
  assert.equal(S("Compression I: RLE Compression", "aaaaabccc"), "5a1b3c");
  assert.equal(S("Compression I: RLE Compression", "aAaAaA"), "1a1A1a1A1a1A");
  assert.equal(S("Compression I: RLE Compression", "111112333"), "511233");
  assert.equal(S("Compression I: RLE Compression", "z".repeat(19)), "9z9z1z");
  assert.equal(S("Compression II: LZ Decompression", "7abracad47"), "abracadabra");
  assert.equal(S("Compression II: LZ Decompression", "5aaabb450723abb"), "aaabbaaababababaabb");
  for (const [plain, maxLen] of [["abracadabra", 10], ["mississippi", 11], ["aaaaaaaaaaaaa", 7], ["aaaaaaaaaaaaaa", 7], ["abcdefghijklmnopqrstuvwxyz", 31]]) {
    const enc = S("Compression III: LZ Compression", plain);
    assert.equal(_internal.lzDecompress(enc), plain, enc);
    assert.ok(enc.length <= maxLen, `${plain} → ${enc} (${enc.length} > ${maxLen})`);
  }
});
