// ident/update.ts — build ident/db.json, the offline identification DB wisp labels devices with.
// Three standard sources, nothing hand-written:
//   1. IEEE MA-L registry (oui.csv)            — vendor of a PUBLIC MAC address
//   2. Bluetooth SIG assigned numbers           — 16-bit service/char/descriptor names,
//                                                member UUID owners, company IDs (mfr data),
//                                                Appearance values (device type)
//   3. Gadgetbridge device drivers (codeberg)   — device name patterns + custom GATT UUIDs
// Run: deno run -A ident/update.ts   (needs network; git clones Gadgetbridge into ident/.gb once)

const HERE = new URL(".", import.meta.url).pathname;
const SIG = "https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers/";
const GB_GIT = "https://codeberg.org/Freeyourgadget/Gadgetbridge.git";

async function get(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return await r.text();
}

// --- 1. IEEE OUI (MA-L, 24-bit prefixes) ---
function parseOui(csv: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const line of csv.split("\n").slice(1)) {
    const x = line.match(/^MA-L,([0-9A-F]{6}),("([^"]*)"|[^,]*)/);
    if (x) m[x[1]] = (x[3] ?? x[2]).trim();
  }
  return m;
}

// --- 2. Bluetooth SIG YAML (flat lists of `- uuid|value: 0x....` + `name:`) ---
function parseSig(yaml: string, key: "uuid" | "value"): Record<string, string> {
  const m: Record<string, string> = {};
  let id = "";
  for (const line of yaml.split("\n")) {
    const k = line.match(new RegExp(`^\\s*-?\\s*${key}:\\s*0x([0-9A-Fa-f]+)`));
    if (k) { id = k[1].toLowerCase().padStart(4, "0"); continue; }
    const n = line.match(/^\s*name:\s*(.+?)\s*$/);
    if (n && id) { m[id] = n[1].replace(/^['"]|['"]$/g, ""); id = ""; }
  }
  return m;
}

// Appearance: 16-bit value = category << 6 | subcategory; name the most specific level
function parseAppearance(yaml: string): Record<string, string> {
  const m: Record<string, string> = {};
  let cat = -1;
  let pending: number | null = null;                          // value whose `name:` line comes next
  for (const line of yaml.split("\n")) {
    const c = line.match(/^\s*-\s*category:\s*0x([0-9A-Fa-f]+)/);
    if (c) { cat = parseInt(c[1], 16); pending = cat << 6; continue; }
    const s = line.match(/^\s*-\s*value:\s*0x([0-9A-Fa-f]+)/);
    if (s && cat >= 0) { pending = (cat << 6) | parseInt(s[1], 16); continue; }
    const n = line.match(/^\s*name:\s*(.+?)\s*$/);
    if (n && pending !== null) { m[pending.toString(16).padStart(4, "0")] = n[1].replace(/^['"]|['"]$/g, ""); pending = null; }
  }
  return m;
}

// --- 3. Gadgetbridge: Coordinator name patterns + UUID.fromString constants per device family ---
async function run(cmd: string[], cwd?: string) {
  const r = await new Deno.Command(cmd[0], { args: cmd.slice(1), cwd, stdout: "null", stderr: "piped" }).output();
  if (!r.success) throw new Error(`${cmd.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
}
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p); else if (e.name.endsWith(".java")) yield p;
  }
}
// Java string literal body -> the string it denotes (only the escapes regex sources use)
const javaStr = (s: string) => s.replace(/\\(.)/g, (_, c) => c === "n" ? "\n" : c === "t" ? "\t" : c);

async function parseGadgetbridge() {
  // persistent sparse checkout in ident/.gb (cloned once; delete the dir to re-clone a newer one)
  const gbDir = `${HERE}.gb`;
  if (!await Deno.stat(gbDir).then(() => true, () => false)) {
    await run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", GB_GIT, gbDir]);
    await run(["git", "sparse-checkout", "set", "app/src/main/java", "app/src/main/res/values"], gbDir);
  }
  {
    const main = `${gbDir}/app/src/main`;
    const strings: Record<string, string> = {};
    for (const x of (await Deno.readTextFile(`${main}/res/values/strings.xml`)).matchAll(/<string name="(devicetype_[^"]+)"[^>]*>([^<]*)<\/string>/g))
      strings[x[1]] = x[2];

    const names: [string, string, string][] = [];               // [js regex source, flags, label]
    const uuids: Record<string, [string, string][]> = {};       // uuid128 -> [[family, CONST]]
    for await (const f of walk(`${main}/java`)) {
      const src = await Deno.readTextFile(f);
      const fam = f.match(/\/(?:service\/)?devices\/([^/]+)\//)?.[1];
      if (f.endsWith("Coordinator.java")) {
        // only a single string literal: Pattern.compile("...") or Pattern.compile("...", Pattern.CASE_INSENSITIVE)
        const pm = src.match(/Pattern\.compile\(\s*"((?:[^"\\]|\\.)*)"\s*(,\s*Pattern\.CASE_INSENSITIVE)?\s*\)/);
        if (pm) {
          const dt = src.match(/R\.string\.(devicetype_\w+)/)?.[1];
          const mfr = src.match(/getManufacturer\(\)\s*\{\s*return\s+"([^"]+)"/)?.[1];
          const label = (dt && strings[dt]) || f.split("/").pop()!.replace("Coordinator.java", "");
          const full = mfr && !label.toLowerCase().startsWith(mfr.toLowerCase()) ? `${mfr} ${label}` : label;
          try { new RegExp(javaStr(pm[1])); names.push([javaStr(pm[1]), pm[2] ? "i" : "", full]); } catch { /* Java-only syntax */ }
        }
      }
      if (!fam) continue;
      for (const x of src.matchAll(/(\w+)\s*=\s*UUID\.fromString\(\s*"([0-9a-fA-F-]{36})"\s*\)/g)) {
        const u = x[2].toLowerCase();
        (uuids[u] ??= []);
        if (!uuids[u].some(([a, b]) => a === fam && b === x[1])) uuids[u].push([fam, x[1]]);
      }
    }
    return { names, uuids };
  }
}

const [oui, svc, chr, desc, member, company, appearance, gb] = await Promise.all([
  get("https://standards-oui.ieee.org/oui/oui.csv").then(parseOui),
  get(SIG + "uuids/service_uuids.yaml").then((y) => parseSig(y, "uuid")),
  get(SIG + "uuids/characteristic_uuids.yaml").then((y) => parseSig(y, "uuid")),
  get(SIG + "uuids/descriptors.yaml").then((y) => parseSig(y, "uuid")),
  get(SIG + "uuids/member_uuids.yaml").then((y) => parseSig(y, "uuid")),
  get(SIG + "company_identifiers/company_identifiers.yaml").then((y) => parseSig(y, "value")),
  get(SIG + "core/appearance_values.yaml").then(parseAppearance),
  parseGadgetbridge(),
]);
const db = { built: new Date().toISOString(), oui, sig: { ...desc, ...chr, ...svc }, member, company, appearance, gbNames: gb.names, gbUuids: gb.uuids };
await Deno.writeTextFile(`${HERE}db.json`, JSON.stringify(db));
console.log(`ident: oui=${Object.keys(oui).length} sig=${Object.keys(db.sig).length} member=${Object.keys(member).length} company=${Object.keys(company).length} appearance=${Object.keys(appearance).length} gbNames=${gb.names.length} gbUuids=${Object.keys(gb.uuids).length}`);
