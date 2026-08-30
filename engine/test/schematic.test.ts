import test from "ava";

import { Volume, blockData, blockId, pack } from "../src/core/volume.js";
import { vec } from "../src/core/vec.js";
import { blockName } from "../src/mc18/blocks.js";
import { MaterialResolver, block } from "../src/mc18/material.js";
import { nbt, parseNbt, writeNbt } from "../src/schematic/nbt.js";
import { readSchematic, writeSchematic } from "../src/schematic/schematic.js";

test("packed cells split into id and data", (t) => {
  const b = pack(35, 14);
  t.is(blockId(b), 35);
  t.is(blockData(b), 14);
  t.is(blockName(b), "red_wool");
});

test("NBT round-trips every tag type", (t) => {
  const doc = {
    name: "Root",
    root: {
      b: nbt.byte(-7),
      s: nbt.short(-300),
      i: nbt.int(123456),
      l: nbt.long(9007199254740993n),
      f: nbt.float(0.5),
      d: nbt.double(Math.PI),
      ba: nbt.byteArray(new Int8Array([1, -1, 127, -128])),
      str: nbt.string("hello schematic"),
      list: nbt.list("int", [nbt.int(1), nbt.int(2), nbt.int(3)]),
      comp: nbt.compound({ inner: nbt.string("x") }),
      ia: nbt.intArray(new Int32Array([1, -2, 3])),
      la: nbt.longArray(new BigInt64Array([1n, -2n])),
    },
  };
  const parsed = parseNbt(writeNbt(doc));
  t.is(parsed.name, "Root");
  t.is(parsed.root["i"]!.type === "int" ? parsed.root["i"]!.value : null, 123456);
  t.is(parsed.root["l"]!.type === "long" ? parsed.root["l"]!.value : null, 9007199254740993n);
  t.is(parsed.root["str"]!.type === "string" ? parsed.root["str"]!.value : null, "hello schematic");
  t.deepEqual(
    parsed.root["ba"]!.type === "byteArray" ? [...parsed.root["ba"]!.value] : null,
    [1, -1, 127, -128],
  );
  t.is(parsed.root["list"]!.type === "list" ? parsed.root["list"]!.value.length : -1, 3);
});

test("schematic round-trips a volume byte-for-byte", (t) => {
  const vol = Volume.of(7, 5, 3);
  vol.fill(vol.bounds, block("stone"));
  vol.set(0, 0, 0, block("red_wool"));
  vol.set(6, 4, 2, block("granite"));
  vol.set(3, 2, 1, block("oak_stairs"));

  const buf = writeSchematic(vol, { offset: vec(-3, 0, -1) });
  const read = readSchematic(buf);

  t.is(read.sourceFormat, "mcedit");
  t.deepEqual(read.offset, vec(-3, 0, -1));
  t.is(read.volume.width, 7);
  t.is(read.volume.height, 5);
  t.is(read.volume.length, 3);
  t.deepEqual([...read.volume.cells], [...vol.cells]);
  t.is(blockName(read.volume.get(0, 0, 0)), "red_wool");
  t.is(blockName(read.volume.get(6, 4, 2)), "granite");
});

test("schematic writing is byte-stable for identical content", (t) => {
  const a = Volume.of(4, 4, 4);
  const b = Volume.of(4, 4, 4);
  for (const v of [a, b]) {
    v.fill(v.bounds, block("quartz_block"));
    v.set(1, 1, 1, block("blue_wool"));
  }
  t.deepEqual(writeSchematic(a), writeSchematic(b));
});

test("ids above 255 survive via AddBlocks", (t) => {
  const vol = Volume.of(2, 1, 1);
  // 1.8 vanilla stops at 197, but modded reference schematics use the high range and must not
  // silently truncate to a different block on round-trip.
  vol.cells[0] = pack(300, 5);
  vol.cells[1] = pack(1, 0);
  const read = readSchematic(writeSchematic(vol));
  t.is(blockId(read.volume.cells[0]!), 300);
  t.is(blockData(read.volume.cells[0]!), 5);
  t.is(blockId(read.volume.cells[1]!), 1);
});

test("material resolver accepts the syntaxes an LLM will actually emit", (t) => {
  const r = new MaterialResolver();
  t.is(blockName(r.require("stone")), "stone");
  t.is(blockName(r.require("stone:1")), "granite");
  t.is(blockName(r.require("granite")), "granite");
  t.is(blockName(r.require("35:14")), "red_wool");
  t.is(blockName(r.require("minecraft:Red_Wool")), "red_wool");
  t.is(blockName(r.require("wool:5")), "lime_wool");
});

test("strict mode rejects post-1.8 blocks and names the substitute", (t) => {
  const strict = new MaterialResolver({ mode: "strict" });
  const res = strict.resolve("white_concrete");
  t.false(res.ok);
  if (!res.ok) {
    t.regex(res.reason, /does not exist in Minecraft 1\.8/);
    t.is(res.suggestion, "white_wool");
  }
});

test("substitute mode maps post-1.8 blocks and records the warning", (t) => {
  const lenient = new MaterialResolver({ mode: "substitute" });
  const res = lenient.resolve("light_gray_terracotta");
  t.true(res.ok);
  if (res.ok) t.is(blockName(res.block), "silver_stained_clay");
  t.deepEqual(lenient.substitutions(), [
    { from: "light_gray_terracotta", to: "silver_stained_clay", count: 1 },
  ]);
});

test("a typo produces a suggestion rather than a dead end", (t) => {
  const res = new MaterialResolver().resolve("cobblestome");
  t.false(res.ok);
  if (!res.ok) t.is(res.suggestion, "cobblestone");
});
