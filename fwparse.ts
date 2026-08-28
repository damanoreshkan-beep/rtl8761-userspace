// fwparse.ts — offline validator for milestone 3. No USB. Parses the firmware + config and
// prints the patch table, the selected patch, and the fragmented download plan.
//   deno run -A fwparse.ts [romVersion=1] [fw.bin] [config.bin]
import { parseFirmware } from "./fw.ts";

const romVersion = Number(Deno.args[0] ?? "1");
const fwPath = Deno.args[1] ?? "rtl8761bu_fw.bin";
const cfgPath = Deno.args[2] ?? "rtl8761bu_config.bin";

const fw = Deno.readFileSync(fwPath);
const cfg = Deno.readFileSync(cfgPath);
const plan = parseFirmware(fw, cfg, romVersion);

const hx = (n: number, w = 4) => "0x" + (n >>> 0).toString(16).padStart(w, "0");
console.log(`fw=${fwPath} ${fw.length}B  cfg=${cfgPath} ${cfg.length}B  rom_version=${hx(romVersion, 2)}`);
console.log(`fw_version=${hx(plan.fwVersion, 8)}  num_patches=${plan.numPatches}  project_id=${plan.projectId === null ? "none" : hx(plan.projectId)}`);
for (const [i, p] of plan.patches.entries()) {
  const mark = i === plan.chosen.index ? "  <== chosen" : "";
  console.log(`  patch[${i}] chip_id=${p.chipId} length=${p.length} offset=${p.offset}${mark}`);
}

// Download plan: vendor 0xFC20, fragments of [index byte][<=252 data], bit7 on the last.
const CHUNK = 252;
const frags = Math.ceil(plan.payload.length / CHUNK);
console.log(`payload=${plan.payload.length}B  -> ${frags} fragments of <=${CHUNK}B (last index has bit7 set)`);
