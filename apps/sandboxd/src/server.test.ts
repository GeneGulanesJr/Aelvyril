import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demux, tarOne, untarOne } from "./server.ts";

test("exec output frames: order kept, stdout picked out", () => {
  const f = (stream: number, s: string) => {
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(Buffer.byteLength(s), 4);
    return Buffer.concat([h, Buffer.from(s)]);
  };
  const { all, stdout } = demux(Buffer.concat([f(1, "a"), f(2, "B"), f(1, "c")]));
  assert.equal(all.toString(), "aBc");
  assert.equal(stdout.toString(), "ac");
});

test("one-file tar: real tar reads it, and we read our own back", () => {
  const data = Buffer.from("héllo\nworld".repeat(100));
  const tar = tarOne("note.txt", data);
  assert.deepEqual(untarOne(tar), data);
  const dir = mkdtempSync(join(tmpdir(), "sbx-tar-"));
  writeFileSync(join(dir, "a.tar"), tar);
  execFileSync("tar", ["-xf", "a.tar"], { cwd: dir });
  assert.deepEqual(readFileSync(join(dir, "note.txt")), data);
});
