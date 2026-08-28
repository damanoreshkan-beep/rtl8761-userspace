// fw.ts — RTL8761 firmware parser, ported faithfully from Linux drivers/bluetooth/btrtl.c
// (rtlbt_parse_firmware, legacy "Realtech" epatch header path). Pure, no I/O — takes the
// fw + config bytes and the ROM version, returns the download payload + selected patch.

const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

const EPATCH_SIG = "Realtech"; // 8-byte header signature
const EXT_SIG = [0x51, 0x04, 0xfd, 0x77]; // extension section marker at EOF (0x77fd0451)

export interface FwPlan {
  fwVersion: number;
  numPatches: number;
  patches: { chipId: number; length: number; offset: number }[];
  chosen: { index: number; chipId: number; length: number; offset: number };
  projectId: number | null;
  payload: Uint8Array; // patch (last 4 bytes = fwVersion) + raw config appended
}

export function parseFirmware(fw: Uint8Array, cfg: Uint8Array, romVersion: number): FwPlan {
  const sig = new TextDecoder().decode(fw.subarray(0, 8));
  if (sig !== EPATCH_SIG) throw new Error(`bad fw signature: "${sig}" (want "${EPATCH_SIG}")`);

  // Extension section at EOF: walk TLV entries backward to read project_id (opcode 0x00).
  const tail = fw.subarray(fw.length - 4);
  const hasExt = EXT_SIG.every((v, i) => v === tail[i]);
  let projectId: number | null = null;
  if (hasExt) {
    // btrtl walks backward from the ext signature: opcode=*--p, length=*--p, then p-=length.
    let p = fw.length - 4;
    while (p >= 14 + 3) {
      const opcode = fw[--p];
      const length = fw[--p];
      if (opcode === 0xff) break; // end marker
      if (opcode === 0x00 && length === 1) { projectId = fw[p - 1]; break; }
      p -= length;
    }
  }

  const fwVersion = le32(fw, 8);
  const numPatches = le16(fw, 12);
  const base = 14;
  const patches = [];
  for (let i = 0; i < numPatches; i++) {
    patches.push({
      chipId: le16(fw, base + i * 2),
      length: le16(fw, base + 2 * numPatches + i * 2),
      offset: le32(fw, base + 4 * numPatches + i * 4),
    });
  }

  // btrtl selects the patch whose chip_id == rom_version + 1.
  const idx = patches.findIndex((p) => p.chipId === romVersion + 1);
  if (idx < 0) throw new Error(`no patch for rom_version 0x${romVersion.toString(16)} (want chip_id ${romVersion + 1})`);
  const chosen = { index: idx, ...patches[idx] };

  // Payload = the selected patch, with fw_version written over its last 4 bytes, then the
  // raw config file appended verbatim (btrtl appends cfg_len bytes when a config exists).
  const patch = fw.slice(chosen.offset, chosen.offset + chosen.length);
  new DataView(patch.buffer).setUint32(patch.length - 4, fwVersion, true);
  const payload = new Uint8Array(patch.length + cfg.length);
  payload.set(patch, 0);
  payload.set(cfg, patch.length);

  return { fwVersion, numPatches, patches, chosen, projectId, payload };
}
