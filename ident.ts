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

export interface AdvInfo { mac: string; addrType: number; name: string; uuids: string[]; companies: number[] }

// Best guess of what a device is, from its advertisement (and, after connect, its services).
export function identDevice(a: AdvInfo): string {
  if (!db) return "";
  const out: string[] = [];
  // skip a label whose first word repeats one already shown ("Gree Air Conditioner" · "GREE Electric…")
  const w = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? "";
  const add = (s: string) => { if (s && !out.some((o) => w(o) === w(s))) out.push(s); };
  if (a.name) add(gbNames.find((x) => x.re.test(a.name))?.label ?? "");
  for (const u of a.uuids) { const gb = gbOf(norm(u)[1]); if (gb.length) add(`gb:${gb[0][0]}`); }
  for (const c of a.companies) add(db.company[c.toString(16).padStart(4, "0")] ?? "");
  if (a.addrType === 0) add(db.oui[a.mac.replace(/:/g, "").slice(0, 6).toUpperCase()] ?? "");
  for (const u of a.uuids) { const s16 = norm(u)[0]; if (s16) add(db.member[s16] ?? db.sig[s16] ?? ""); }
  return out.slice(0, 2).join(" · ");
}
