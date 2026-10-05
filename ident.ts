// ident.ts — offline device/UUID identification from ident/db.json (built by ident/update.ts).
// Sources: IEEE OUI (public MACs), Bluetooth SIG assigned numbers, Gadgetbridge device drivers.

interface Db {
  oui: Record<string, string>; sig: Record<string, string>; member: Record<string, string>;
  company: Record<string, string>; appearance: Record<string, string>; gbNames: [string, string, string][]; gbUuids: Record<string, [string, string][]>;
}
const BASE = "-0000-1000-8000-00805f9b34fb";

let db: Db | null = null;
try { db = JSON.parse(Deno.readTextFileSync(new URL("./ident/db.json", import.meta.url))); } catch { /* no db yet */ }
export const identReady = db !== null;

// name patterns that also match "" are catch-alls (e.g. ".*") — useless for identification
const gbNames = (db?.gbNames ?? []).map(([src, fl, label]) => ({ re: new RegExp(`^(?:${src})$`, fl), label }))
  .filter((x) => !x.re.test(""));

// bt.ts UUID forms: "0x2a00" (16-bit) or 32 hex chars big-endian (128-bit) -> [16-bit key | "", dashed 128-bit]
function norm(uuid: string): [string, string] {
  const u = uuid.toLowerCase().replace(/^0x/, "").replace(/-/g, "");
  if (u.length <= 4) { const s = u.padStart(4, "0"); return [s, `0000${s}${BASE}`]; }
  const d = `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
  return [d.startsWith("0000") && d.endsWith(BASE) ? d.slice(4, 8) : "", d];
}

// Gadgetbridge families that declare this UUID (only when it points at ≤2 families)
function gbOf(full: string): [string, string][] {
  const hits = db?.gbUuids[full] ?? [];
  return new Set(hits.map(([f]) => f)).size <= 2 ? hits : [];
}

// Label for a GATT service/characteristic/descriptor UUID: SIG name, else Gadgetbridge, else SIG member owner.
export function uuidLabel(uuid: string): string {
  if (!db) return "";
  const [s16, full] = norm(uuid);
  if (s16 && db.sig[s16]) return db.sig[s16];
  const gb = gbOf(full);
  if (gb.length) return `gb:${gb[0][0]} ${gb[0][1]}`;
  if (s16 && db.member[s16]) return `member: ${db.member[s16]}`;
  return "";
}

// SIG Appearance (device type), e.g. 0x0941 -> "Earbud"; falls back to the category name. "" for Unknown.
export function appearanceName(v: number): string {
  if (!db || !v) return "";
  return db.appearance[v.toString(16).padStart(4, "0")] ?? db.appearance[(v & ~0x3f).toString(16).padStart(4, "0")] ?? "";
}

export interface AdvInfo { mac: string; addrType: number; name: string; uuids: string[]; companies: number[]; appleType?: number; appleMsd?: number[] }

// Apple "Continuity" BLE message types (reverse-engineered; furiousMAC/continuity, hexway/apple_bleee).
const CONT: Record<number, string> = {
  0x02: "iBeacon", 0x03: "AirPrint", 0x05: "AirDrop", 0x06: "HomeKit", 0x07: "AirPods pairing",
  0x08: "Hey Siri", 0x09: "AirPlay target", 0x0a: "AirPlay source", 0x0b: "Watch wrist",
  0x0c: "Handoff", 0x0d: "Tethering target", 0x0e: "Tethering source", 0x0f: "Nearby Action",
  0x10: "Nearby Info", 0x12: "Find My",
};
// Proximity Pairing (type 0x07) 2-byte model IDs (airpodsgo / maniacx / AppleJuice, 2026-10).
// On-wire low byte first; keyed here by the canonical UINT16 (e.g. AirPods Pro = 0x0E20).
const AIRPODS: Record<number, string> = {
  0x0220: "AirPods 1", 0x0f20: "AirPods 2", 0x1320: "AirPods 3", 0x1920: "AirPods 4", 0x1b20: "AirPods 4 (ANC)",
  0x0e20: "AirPods Pro", 0x1420: "AirPods Pro 2", 0x2420: "AirPods Pro 2 (USB-C)", 0x2720: "AirPods Pro 3",
  0x0a20: "AirPods Max", 0x1f20: "AirPods Max (USB-C)",
  0x0520: "BeatsX", 0x0320: "Powerbeats3", 0x0d20: "Powerbeats4", 0x0b20: "Powerbeats Pro", 0x1d20: "Powerbeats Pro 2",
  0x0620: "Beats Solo3", 0x0c20: "Beats Solo Pro", 0x2620: "Beats Solo Buds", 0x0920: "Beats Studio3",
  0x1720: "Beats Studio Pro", 0x1120: "Beats Studio Buds", 0x1620: "Beats Studio Buds+", 0x1020: "Beats Flex",
  0x1220: "Beats Fit Pro",
};
// Nearby Info (0x10) action code = low nibble of the status byte (furiousMAC/continuity nearby_info.md).
const NEARBY_ACT: Record<number, string> = {
  0x00: "", 0x01: "reporting off", 0x03: "locked", 0x05: "audio (locked)", 0x07: "screen on",
  0x09: "video", 0x0a: "watch unlocked", 0x0b: "in use", 0x0d: "DRIVING", 0x0e: "CALL/FaceTime",
};
// Decode the Apple manufacturer payload (bytes after company 0x004C) into its Continuity messages,
// including the Nearby Info device-state (screen/lock/call/driving/WiFi) that apple_bleee surfaces.
// Payload is a sequence of [type][len][data…].
export function appleContinuity(msd: number[]): string {
  const out: string[] = []; let i = 0;
  while (i + 2 <= msd.length) {
    const t = msd[i], len = msd[i + 1], data = msd.slice(i + 2, i + 2 + len); i += 2 + len;
    if (t === 0x07 && data.length >= 3) {                        // Proximity Pairing: name the model
      out.push(AIRPODS[(data[2] << 8) | data[1]] ?? "AirPods/Beats pairing");
    } else if (t === 0x10 && data.length >= 1) {                 // Nearby Info: device usage state
      const sf = data[0] >> 4, bits: string[] = [];
      const act = NEARBY_ACT[data[0] & 0x0f]; if (act) bits.push(act);
      if (data.length >= 2) bits.push(data[1] & 0x04 ? "WiFi on" : "WiFi off");
      if (sf & 0x04) bits.push("AirDrop rx");
      if (sf & 0x01) bits.push("primary");
      out.push("Nearby Info" + (bits.length ? " [" + bits.join(", ") + "]" : ""));
    } else out.push(CONT[t] ?? `type 0x${t.toString(16)}`);
    if (len === 0 && t === 0) break;
  }
  return [...new Set(out)].join(", ");
}

// Flag known location trackers / surveillance beacons from their advertisement. "" if none.
// appleType is the Apple manufacturer-data message type: 0x12 = Find My offline-finding (AirTag etc.).
export function trackerLabel(a: AdvInfo): string {
  const u = a.uuids.map((x) => norm(x)[0]);
  // signatures per seemoo-lab/AirGuard + Google FMDN spec (2026-10)
  if (a.companies.includes(0x004c) && a.appleType === 0x12) return "TRACKER: Find My (AirTag/accessory)";
  if (u.includes("feed") || u.includes("feec")) return "TRACKER: Tile";
  if (u.includes("fe33")) return "TRACKER: Chipolo";
  if (u.includes("fd5a")) return "TRACKER: Samsung SmartTag";
  if (u.includes("fd69")) return "TRACKER: Samsung Find My Mobile";
  if (u.includes("fa25")) return "TRACKER: Pebblebee";
  if (u.includes("feaa")) return "TRACKER: Google Find My Device";
  return "";
}

// Best guess of what a device is, from its advertisement (and, after connect, its services).
export function identDevice(a: AdvInfo): string {
  if (!db) return "";
  const out: string[] = [];
  // skip a label whose first word repeats one already shown ("Gree Air Conditioner" · "GREE Electric…")
  const w = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? "";
  const add = (s: string) => { if (s && !out.some((o) => w(o) === w(s))) out.push(s); };
  add(trackerLabel(a));                                          // flag trackers first, so they lead the label
  if (a.name) add(gbNames.find((x) => x.re.test(a.name))?.label ?? "");
  for (const u of a.uuids) { const gb = gbOf(norm(u)[1]); if (gb.length) add(`gb:${gb[0][0]}`); }
  for (const c of a.companies) add(db.company[c.toString(16).padStart(4, "0")] ?? "");
  if (a.addrType === 0) add(db.oui[a.mac.replace(/:/g, "").slice(0, 6).toUpperCase()] ?? "");
  for (const u of a.uuids) { const s16 = norm(u)[0]; if (s16) add(db.member[s16] ?? db.sig[s16] ?? ""); }
  const label = out.slice(0, 2).join(" · ");
  const cont = a.appleMsd && a.appleMsd.length ? appleContinuity(a.appleMsd) : "";
  return cont ? (label ? `${label} · ${cont}` : cont) : label;
}
