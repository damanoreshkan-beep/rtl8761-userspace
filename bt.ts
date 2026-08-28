// bt.ts — userspace HCI recon core for RTL8761 USB Bluetooth, no root.
// Runs as a termux-usb callback: argv[0] = inherited usbfs fd. Action via BT_ACTION env.
// RESEARCH SLICE: descriptor dump + HCI Read Local Version. Nothing is written to the
// chip except a single HCI command over the control endpoint (the standard transport).

const fd = Number(Deno.args[0]);
const action = Deno.env.get("BT_ACTION") ?? "desc";

const libc = Deno.dlopen("libc.so.6", {
  ioctl: { parameters: ["i32", "u64", "buffer"], result: "i32" },
  pread: { parameters: ["i32", "buffer", "usize", "i64"], result: "isize" },
  __errno_location: { parameters: [], result: "pointer" },
});
const errno = () => new Deno.UnsafePointerView(libc.symbols.__errno_location()!).getInt32();

const IOCTL = {
  CLAIM: 0x8004550Fn,
  DISCONNECT_CLAIM: 0x8108551Bn,
  CONTROL: 0xC0185500n,
  BULK: 0xC0185502n,
} as const;

function claim(iface = 0): boolean {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, iface, true);
  if (libc.symbols.ioctl(fd, IOCTL.CLAIM, b) >= 0) return true;
  const dc = new Uint8Array(264);
  const dv = new DataView(dc.buffer);
  dv.setUint32(0, iface, true);
  dv.setUint32(4, 2, true); // USBDEVFS_DISCONNECT_CLAIM_EXCEPT_DRIVER=2 -> unconditional
  return libc.symbols.ioctl(fd, IOCTL.DISCONNECT_CLAIM, dc) >= 0;
}

function control(reqType: number, req: number, val: number, idx: number, data: Uint8Array, timeout = 1000): number {
  const r = new Uint8Array(24);
  const dv = new DataView(r.buffer);
  dv.setUint8(0, reqType);
  dv.setUint8(1, req);
  dv.setUint16(2, val, true);
  dv.setUint16(4, idx, true);
  dv.setUint16(6, data.length, true);
  dv.setUint32(8, timeout, true);
  dv.setBigUint64(16, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(data))), true);
  const rc = libc.symbols.ioctl(fd, IOCTL.CONTROL, r);
  return rc < 0 ? -errno() : rc;
}

function bulk(ep: number, buf: Uint8Array, timeout = 2000): number {
  const r = new Uint8Array(24);
  const dv = new DataView(r.buffer);
  dv.setUint32(0, ep, true);
  dv.setUint32(4, buf.length, true);
  dv.setUint32(8, timeout, true);
  dv.setBigUint64(16, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(buf))), true);
  const rc = libc.symbols.ioctl(fd, IOCTL.BULK, r);
  return rc < 0 ? -errno() : rc;
}

const enc = new TextEncoder();
const out = (s: string) => Deno.stdout.writeSync(enc.encode(s));

// termux-usb forwards only the callback's stdout, so surface any throw there (not stderr).
globalThis.addEventListener("unhandledrejection", (e) => { out(`ERROR: ${(e.reason as Error)?.stack ?? e.reason}\n`); Deno.exit(1); });
globalThis.addEventListener("error", (e) => { out(`ERROR: ${e.error?.stack ?? e.message}\n`); Deno.exit(1); });

// --- HCI helpers (defined here so both fwdl and scan can ensure a patched controller) ---
function readEvent(timeout = 1500): Uint8Array {
  const ev = new Uint8Array(260);
  const n = bulk(0x81, ev, timeout);
  return n > 0 ? ev.subarray(0, n) : new Uint8Array(0);
}
// send a command, read its Command Complete (skipping stray events like adv reports);
// match the echoed opcode. Returns {status, ret} (ret = params after status).
function cmdC(ogf: number, ocf: number, params?: Uint8Array): { status: number; ret: Uint8Array } {
  const opcode = (ogf << 10) | ocf;
  const lo = opcode & 0xff, hi = (opcode >> 8) & 0xff;
  hciCmd(ogf, ocf, params);
  for (let tries = 0; tries < 12; tries++) {
    const ev = readEvent(1500);
    if (ev.length === 0) break;
    if (ev[0] === 0x0e && ev.length >= 6 && ev[3] === lo && ev[4] === hi) {
      return { status: ev[5], ret: ev.subarray(6) };
    }
    // ignore other events (0x3e adv reports, command-status, etc.) and keep reading
  }
  return { status: -1, ret: new Uint8Array(0) };
}
function localSubver(): number {
  const { status, ret } = cmdC(0x04, 0x0001); // Read_Local_Version
  return status === 0 && ret.length >= 8 ? (ret[6] | (ret[7] << 8)) : -1;
}
// Download fw+config if the controller is still running the ROM bootloader (subver 0x8761).
async function ensurePatched(): Promise<number> {
  cmdC(0x03, 0x003);            // HCI_Reset first: stop any leftover scan, flush state
  let sv = localSubver();
  if (sv === 0xd922) return sv; // already running the patched build — nothing to do
  const { parseFirmware } = await import(new URL("./fw.ts", import.meta.url).href);
  const rd = (n: string) => Deno.readFileSync(new URL("./" + n, import.meta.url).pathname);
  const romVersion = cmdC(0x3f, 0x06d).ret[0]; // Read_ROM_Version
  const plan = parseFirmware(rd("rtl8761bu_fw.bin"), rd("rtl8761bu_config.bin"), romVersion);
  const pl: Uint8Array = plan.payload;
  const CHUNK = 252, frags = Math.ceil(pl.length / CHUNK);
  for (let i = 0; i < frags; i++) {
    const slice = pl.subarray(i * CHUNK, i * CHUNK + CHUNK);
    const param = new Uint8Array(1 + slice.length);
    param[0] = (i & 0x7f) | (i === frags - 1 ? 0x80 : 0);
    param.set(slice, 1);
    if (cmdC(0x3f, 0x020, param).status !== 0) throw new Error(`fwdl frag ${i} failed`);
  }
  cmdC(0x03, 0x003); // HCI_Reset
  await new Promise((r) => setTimeout(r, 300));
  sv = localSubver();
  return sv;
}
// commands that return Command Status (0x0f) instead of Command Complete (e.g. Create_Connection)
function cmdStatus(ogf: number, ocf: number, params?: Uint8Array): number {
  const opcode = (ogf << 10) | ocf;
  const lo = opcode & 0xff, hi = (opcode >> 8) & 0xff;
  hciCmd(ogf, ocf, params);
  for (let t = 0; t < 12; t++) {
    const ev = readEvent(1500);
    if (ev.length === 0) break;
    // Command Status: 0x0f, len, status(ev[2]), num_cmd(ev[3]), opcode(ev[4..5])
    if (ev[0] === 0x0f && ev.length >= 6 && ev[4] === lo && ev[5] === hi) return ev[2];
  }
  return -1;
}
// wait for an LE Meta event (0x3e) with any of the given subevent codes; returns its bytes
function waitMeta(subs: number | number[], timeoutMs: number): Uint8Array {
  const set = Array.isArray(subs) ? subs : [subs];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ev = readEvent(500);
    if (ev.length >= 3 && ev[0] === 0x3e && set.includes(ev[2])) return ev;
  }
  return new Uint8Array(0);
}
// ACL data out on bulk EP 0x02: L2CAP PDU on the given CID over the connection handle.
const PB_START = 0x00; // first fragment, host->controller (LE)
function aclSend(handle: number, cid: number, payload: Uint8Array): number {
  const hf = (handle & 0x0fff) | (PB_START << 12);
  const l2 = 4 + payload.length;
  const pkt = new Uint8Array(4 + 4 + payload.length);
  const dv = new DataView(pkt.buffer);
  dv.setUint16(0, hf, true);
  dv.setUint16(2, l2, true);            // ACL data total length
  dv.setUint16(4, payload.length, true); // L2CAP PDU length
  dv.setUint16(6, cid, true);            // L2CAP CID
  pkt.set(payload, 8);
  return bulk(0x02, pkt, 2000);
}
// ACL data in on bulk EP 0x82: returns the L2CAP payload (strips ACL+L2CAP headers)
function aclRecv(timeout = 2000): { cid: number; payload: Uint8Array } | null {
  const buf = new Uint8Array(300);
  const n = bulk(0x82, buf, timeout);
  if (n < 8) return null;
  const dv = new DataView(buf.buffer);
  const l2len = dv.getUint16(4, true);
  const cid = dv.getUint16(6, true);
  return { cid, payload: buf.subarray(8, 8 + l2len) };
}
const ATT_CID = 0x0004;
// read the next ATT-channel (CID 0x0004) PDU, skipping L2CAP signaling / other CIDs
function attRecv(timeout = 2500): Uint8Array | null {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = aclRecv(600);
    if (r && r.cid === ATT_CID && r.payload.length) return r.payload;
  }
  return null;
}

interface AdvRec { addr: Uint8Array; addrType: number; eventType: number; rssi: number; name: string }
// Run an LE active scan for `secs` and return records keyed by MAC (assumes patched + claimed).
function scanCollect(secs: number): Map<string, AdvRec> {
  const ff = new Uint8Array(8).fill(0xff);
  cmdC(0x03, 0x001, ff); cmdC(0x08, 0x001, ff);                                   // event masks
  cmdC(0x08, 0x00b, Uint8Array.from([0x01, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00])); // scan params
  cmdC(0x08, 0x00c, Uint8Array.from([0x01, 0x00]));                               // scan enable
  const seen = new Map<string, AdvRec>();
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const ev = new Uint8Array(260);
    const n = bulk(0x81, ev, 800);
    if (n < 4 || ev[0] !== 0x3e || ev[2] !== 0x02) continue;
    let p = 3;
    const num = ev[p++];
    for (let r = 0; r < num && p + 9 <= n; r++) {
      const eventType = ev[p++];
      const addrType = ev[p++];
      const addr = ev.slice(p, p + 6); p += 6;
      const mac = Array.from(addr).reverse().map(h).join(":");
      const dlen = ev[p++];
      let name = "";
      const adEnd = p + dlen; let q = p;
      while (q + 2 <= adEnd) {
        const l = ev[q], t = ev[q + 1];
        if (l === 0) break;
        if ((t === 0x09 || t === 0x08) && l > 1) name = new TextDecoder().decode(ev.subarray(q + 2, q + 1 + l));
        q += l + 1;
      }
      p = adEnd;
      const rssi = ev[p] > 127 ? ev[p] - 256 : ev[p]; p++;
      const prev = seen.get(mac);
      seen.set(mac, { addr, addrType, eventType, rssi, name: name || prev?.name || "" });
    }
  }
  cmdC(0x08, 0x00c, Uint8Array.from([0x00, 0x00]));                               // scan disable
  return seen;
}

// Ensure patched, scan, pick target (BT_TARGET or strongest connectable), create the LE
// connection and exchange MTU. Returns the connection handle or -1. `label` prefixes output.
async function connectTarget(label: string): Promise<number> {
  const sv = await ensurePatched();
  out(`${label}: controller lmp_subver=0x${(sv >>> 0).toString(16)}\n`);
  const want = (Deno.env.get("BT_TARGET") ?? "").toLowerCase();
  const recs = scanCollect(Number(Deno.env.get("BT_SCAN_SECS") ?? "5"));
  const connectable = [...recs.entries()].filter(([, r]) => r.eventType === 0x00 || r.eventType === 0x01);
  const target = want ? recs.get(want) : connectable.sort((a, b) => b[1].rssi - a[1].rssi)[0]?.[1];
  out(`${label}: ${recs.size} seen, ${connectable.length} connectable\n`);
  for (const [mac, r] of connectable.sort((a, b) => b[1].rssi - a[1].rssi).slice(0, 6))
    out(`  ${mac}  type=${r.addrType}  ${String(r.rssi).padStart(4)} dBm  ${r.name}\n`);
  if (!target) { out(`${label}: no connectable target${want ? " matching " + want : ""}\n`); return -1; }
  out(`${label}: -> ${Array.from(target.addr).reverse().map(h).join(":")} (addr_type=${target.addrType})\n`);
  const cc = new Uint8Array(25);
  const dv = new DataView(cc.buffer);
  dv.setUint16(0, 0x0060, true); dv.setUint16(2, 0x0060, true); // scan interval/window
  cc[4] = 0x00; cc[5] = target.addrType; cc.set(target.addr, 6); cc[12] = 0x00;
  dv.setUint16(13, 0x0018, true); dv.setUint16(15, 0x0028, true); // conn interval min/max
  dv.setUint16(17, 0x0000, true); dv.setUint16(19, 0x00c8, true); // latency, supervision (2s)
  dv.setUint16(21, 0x0000, true); dv.setUint16(23, 0x0000, true); // CE length
  const cst = cmdStatus(0x08, 0x00d, cc);
  out(`${label}: create_connection status=${cst}\n`);
  const ce = waitMeta([0x01, 0x0a], 8000);                        // LE (Enhanced) Connection Complete
  if (ce.length < 6 || ce[3] !== 0x00) {
    out(`${label}: connection FAILED (meta status=${ce.length >= 4 ? "0x" + h(ce[3]) : "timeout"})\n`);
    cmdStatus(0x08, 0x00e); return -1;                            // LE_Create_Connection_Cancel
  }
  const handle = ce[4] | (ce[5] << 8);
  out(`${label}: CONNECTED handle=0x${handle.toString(16)}\n`);
  aclSend(handle, ATT_CID, Uint8Array.from([0x02, 0x17, 0x00])); // Exchange MTU (default 23)
  const mtu = attRecv(2000);
  if (mtu && mtu[0] === 0x03) out(`${label}: server MTU=${mtu[1] | (mtu[2] << 8)}\n`);
  return handle;
}
function disconnect(handle: number) {
  cmdStatus(0x01, 0x006, Uint8Array.from([handle & 0xff, (handle >> 8) & 0xff, 0x13]));
}
// One ATT request expecting response opcode `want` (or an Error Response 0x01); skips strays.
function attTxn(handle: number, req: Uint8Array, want: number): Uint8Array | null {
  aclSend(handle, ATT_CID, req);
  const t0 = Date.now();
  while (Date.now() - t0 < 3500) {
    const p = attRecv(1000);
    if (p && (p[0] === want || p[0] === 0x01)) return p;
  }
  return null;
}
const attUuid = (uv: Uint8Array) =>
  uv.length === 2 ? "0x" + (uv[0] | (uv[1] << 8)).toString(16).padStart(4, "0") : Array.from(uv).reverse().map(h).join("");

interface Svc { start: number; end: number; uuid: string }
function discoverServices(handle: number): Svc[] {   // Read_By_Group_Type, Primary Service 0x2800
  const svcs: Svc[] = [];
  let start = 0x0001;
  while (start <= 0xffff) {
    const req = new Uint8Array(7); const rv = new DataView(req.buffer);
    req[0] = 0x10; rv.setUint16(1, start, true); rv.setUint16(3, 0xffff, true); rv.setUint16(5, 0x2800, true);
    const b = attTxn(handle, req, 0x11);
    if (!b || b[0] !== 0x11) break;
    const each = b[1]; let last = 0;
    for (let i = 2; i + each <= b.length; i += each) {
      const s = b[i] | (b[i + 1] << 8), e = b[i + 2] | (b[i + 3] << 8);
      svcs.push({ start: s, end: e, uuid: attUuid(b.subarray(i + 4, i + each)) }); last = e;
    }
    if (last >= 0xffff || last < start) break;
    start = last + 1;
  }
  return svcs;
}
interface Char { declHandle: number; props: number; valueHandle: number; uuid: string }
function discoverChars(handle: number, sStart: number, sEnd: number): Char[] { // Read_By_Type, Char Decl 0x2803
  const chars: Char[] = [];
  let start = sStart;
  while (start <= sEnd) {
    const req = new Uint8Array(7); const rv = new DataView(req.buffer);
    req[0] = 0x08; rv.setUint16(1, start, true); rv.setUint16(3, sEnd, true); rv.setUint16(5, 0x2803, true);
    const b = attTxn(handle, req, 0x09);
    if (!b || b[0] !== 0x09) break;
    const each = b[1]; let last = 0;
    for (let i = 2; i + each <= b.length; i += each) {
      const declHandle = b[i] | (b[i + 1] << 8);
      chars.push({ declHandle, props: b[i + 2], valueHandle: b[i + 3] | (b[i + 4] << 8), uuid: attUuid(b.subarray(i + 5, i + each)) });
      last = declHandle;
    }
    if (last >= sEnd || last < start) break;
    start = last + 1;
  }
  return chars;
}
function readChar(handle: number, valueHandle: number): Uint8Array | null { // ATT Read Request 0x0a
  const req = new Uint8Array(3);
  req[0] = 0x0a; new DataView(req.buffer).setUint16(1, valueHandle, true);
  const b = attTxn(handle, req, 0x0b);
  return b && b[0] === 0x0b ? b.subarray(1) : null;
}
// ATT Find_Information over [start,end]: return the handle of the CCCD (UUID 0x2902), or -1.
function findCCCD(handle: number, start: number, end: number): number {
  let s = start;
  while (s <= end && s > 0) {
    const req = new Uint8Array(5); const rv = new DataView(req.buffer);
    req[0] = 0x04; rv.setUint16(1, s, true); rv.setUint16(3, end, true);
    const b = attTxn(handle, req, 0x05);
    if (!b || b[0] !== 0x05) break;
    const step = b[1] === 0x01 ? 4 : 18;                     // format: 1=16-bit UUID, 2=128-bit
    let last = 0;
    for (let i = 2; i + step <= b.length; i += step) {
      const hnd = b[i] | (b[i + 1] << 8);
      if (attUuid(b.subarray(i + 2, i + step)) === "0x2902") return hnd;
      last = hnd;
    }
    if (last >= end || last < s) break;
    s = last + 1;
  }
  return -1;
}
function attWrite(handle: number, attHandle: number, value: Uint8Array): boolean { // ATT Write Request 0x12
  const req = new Uint8Array(3 + value.length);
  req[0] = 0x12; new DataView(req.buffer).setUint16(1, attHandle, true); req.set(value, 3);
  const b = attTxn(handle, req, 0x13);
  return !!b && b[0] === 0x13;
}
const GATT_NAMES: Record<string, string> = {
  "0x2a00": "Device Name", "0x2a01": "Appearance", "0x2a04": "Pref Conn Params",
  "0x2a29": "Manufacturer", "0x2a24": "Model Number", "0x2a25": "Serial Number",
  "0x2a26": "Firmware Rev", "0x2a27": "Hardware Rev", "0x2a28": "Software Rev",
  "0x2a19": "Battery Level", "0x2a23": "System ID", "0x2a50": "PnP ID",
};
const hex = (b: Uint8Array, n = b.length) =>
  Array.from(b.subarray(0, n)).map((x) => x.toString(16).padStart(2, "0")).join(" ");

// Read the whole descriptor blob usbfs exposes at the fd: device desc then all config descs.
function readDescriptors(): Uint8Array {
  const buf = new Uint8Array(1024);
  const n = Number(libc.symbols.pread(fd, buf, BigInt(buf.length), 0n));
  return buf.subarray(0, Math.max(0, n));
}

function parseDescriptors(d: Uint8Array) {
  let i = 0;
  while (i + 2 <= d.length) {
    const len = d[i], type = d[i + 1];
    if (len === 0) break;
    if (type === 0x01) {
      out(`DEVICE   vid=${le(d, 8)} pid=${le(d, 10)} usb=${le(d, 2)} class=${h(d[4])}/${h(d[5])}/${h(d[6])} numCfg=${d[i + 17]}\n`);
    } else if (type === 0x02) {
      out(`CONFIG   nIface=${d[i + 4]} cfgVal=${d[i + 5]} attr=${h(d[i + 7])} maxPower=${d[i + 8] * 2}mA\n`);
    } else if (type === 0x04) {
      out(`  IFACE  num=${d[i + 2]} alt=${d[i + 3]} nEP=${d[i + 4]} class=${h(d[i + 5])}/${h(d[i + 6])}/${h(d[i + 7])}\n`);
    } else if (type === 0x05) {
      const addr = d[i + 2], attr = d[i + 3];
      const dir = addr & 0x80 ? "IN " : "OUT";
      const kinds = ["control", "isoc", "bulk", "interrupt"];
      const mps = d[i + 4] | (d[i + 5] << 8);
      out(`    EP   0x${addr.toString(16).padStart(2, "0")} ${dir} ${kinds[attr & 3].padEnd(9)} mps=${mps} interval=${d[i + 6]}\n`);
    }
    i += len;
  }
}
const h = (x: number) => x.toString(16).padStart(2, "0");
const le = (d: Uint8Array, i: number) => h(d[i + 1]) + h(d[i]);

// HCI command over the control endpoint: bmRequestType=0x20, bRequest=0, value=0, index=0.
function hciCmd(ogf: number, ocf: number, params: Uint8Array = new Uint8Array(0)): number {
  const opcode = (ogf << 10) | ocf;
  const pkt = new Uint8Array(3 + params.length);
  pkt[0] = opcode & 0xff;
  pkt[1] = (opcode >> 8) & 0xff;
  pkt[2] = params.length;
  pkt.set(params, 3);
  return control(0x20, 0x00, 0x0000, 0x0000, pkt);
}

if (action === "desc") {
  const d = readDescriptors();
  if (d.length < 18) { out(`desc: short read (${d.length} bytes) errno=${errno()}\n`); Deno.exit(1); }
  out(`raw ${d.length} bytes\n`);
  parseDescriptors(d);
} else if (action === "hci") {
  // Read Local Version Information: OGF=0x04 (Informational), OCF=0x0001.
  if (!claim(0)) { out(`hci: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const sent = hciCmd(0x04, 0x0001);
  out(`hci: Read_Local_Version sent rc=${sent}\n`);
  // Event comes back on the interrupt-IN endpoint. Try the common addresses.
  for (const ep of [0x81, 0x82, 0x83]) {
    const ev = new Uint8Array(64);
    const n = bulk(ep, ev, 1500);
    if (n > 0) { out(`  event on EP 0x${ep.toString(16)}: ${hex(ev, n)}\n`); break; }
    out(`  EP 0x${ep.toString(16)}: no data (rc=${n})\n`);
  }
} else if (action === "fwdl") {
  // Full firmware download: parse fw+config, fragment via vendor 0xFC20, then HCI_Reset.
  const { parseFirmware } = await import(new URL("./fw.ts", import.meta.url).href);
  const rd = (n: string) => Deno.readFileSync(new URL("./" + n, import.meta.url).pathname);
  if (!claim(0)) { out(`fwdl: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }

  // 1. rom_version (0xFC6D) to pick the patch.
  hciCmd(0x3f, 0x06d);
  const rv = new Uint8Array(64);
  if (bulk(0x81, rv, 1500) < 7 || rv[0] !== 0x0e) { out("fwdl: rom_version read failed\n"); Deno.exit(1); }
  const romVersion = rv[6];
  out(`fwdl: rom_version=0x${h(romVersion)}\n`);

  // 2. parse.
  const plan = parseFirmware(rd("rtl8761bu_fw.bin"), rd("rtl8761bu_config.bin"), romVersion);
  const pl: Uint8Array = plan.payload;
  out(`fwdl: patch chip_id=${plan.chosen.chipId} payload=${pl.length}B\n`);

  // 3. fragment + download. vendor 0xFC20, param = [index][<=252 data], bit7 on the last.
  const CHUNK = 252;
  const frags = Math.ceil(pl.length / CHUNK);
  for (let i = 0; i < frags; i++) {
    const slice = pl.subarray(i * CHUNK, i * CHUNK + CHUNK);
    let idx = i & 0x7f;
    if (i === frags - 1) idx |= 0x80;
    const param = new Uint8Array(1 + slice.length);
    param[0] = idx;
    param.set(slice, 1);
    const sent = hciCmd(0x3f, 0x020, param);
    const ev = new Uint8Array(64);
    const n = bulk(0x81, ev, 2000);
    const ok = n >= 7 && ev[0] === 0x0e && ev[3] === 0x20 && ev[4] === 0xfc && ev[5] === 0x00;
    if (!ok) { out(`  frag ${i}/${frags} FAILED sent=${sent} n=${n} ev=${hex(ev, Math.max(0, n))}\n`); Deno.exit(1); }
    if (i % 20 === 0 || i === frags - 1) out(`  frag ${i + 1}/${frags} ok (idx=0x${h(idx)})\n`);
  }

  // 4. HCI_Reset (0x0C03) and let the patched fw relaunch.
  hciCmd(0x03, 0x003);
  bulk(0x81, new Uint8Array(64), 2000);
  await new Promise((r) => setTimeout(r, 300));

  // 5. Re-read local version — subversion should differ once the patch runs.
  hciCmd(0x04, 0x0001);
  const lv = new Uint8Array(64);
  const ln = bulk(0x81, lv, 1500);
  if (ln >= 14 && lv[0] === 0x0e) {
    const subver = lv[12] | (lv[13] << 8);
    out(`fwdl: DONE. post-patch lmp_subver=0x${subver.toString(16)} (rom was 0x8761)\n`);
  } else {
    out(`fwdl: download sent; version re-read inconclusive (n=${ln})\n`);
  }
} else if (action === "scan") {
  // LE active scan. Self-contained: downloads fw first if the chip is still in ROM.
  if (!claim(0)) { out(`scan: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const sv = await ensurePatched();
  out(`scan: controller lmp_subver=0x${(sv >>> 0).toString(16)}${sv === 0x8761 ? " (STILL ROM!)" : " (patched)"}\n`);
  const ff = new Uint8Array(8).fill(0xff);
  // Unmask events: general Set_Event_Mask must include LE Meta (bit 61) or adv reports never arrive.
  const em = cmdC(0x03, 0x001, ff);           // Set_Event_Mask
  const lem = cmdC(0x08, 0x001, ff);          // LE_Set_Event_Mask
  // LE_Set_Scan_Parameters: active, interval/window 0x0010, own=public, filter=all.
  const sp = cmdC(0x08, 0x00b, Uint8Array.from([0x01, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00]));
  // LE_Set_Scan_Enable: enable=1, filter_duplicates=0.
  const se = cmdC(0x08, 0x00c, Uint8Array.from([0x01, 0x00]));
  out(`scan: event_mask=${em.status} le_event_mask=${lem.status} set_params=${sp.status} set_enable=${se.status}\n`);
  let rawEvents = 0;

  const secs = Number(Deno.env.get("BT_SCAN_SECS") ?? "5");
  out(`scan: listening ${secs}s...\n`);
  const seen = new Map<string, { rssi: number; name: string }>();
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const ev = new Uint8Array(260);
    const n = bulk(0x81, ev, 800);
    if (n > 0) rawEvents++;
    if (n < 4 || ev[0] !== 0x3e || ev[2] !== 0x02) continue;      // LE Meta / Adv Report
    let p = 3;
    const num = ev[p++];
    for (let r = 0; r < num && p + 9 <= n; r++) {
      p++;                                                        // event_type
      p++;                                                        // address_type
      const mac = Array.from(ev.subarray(p, p + 6)).reverse().map(h).join(":"); p += 6;
      const dlen = ev[p++];
      let name = "";
      const adEnd = p + dlen;
      let q = p;
      while (q + 2 <= adEnd) {                                    // parse AD structures for name
        const l = ev[q], t = ev[q + 1];
        if (l === 0) break;
        if ((t === 0x09 || t === 0x08) && l > 1) name = new TextDecoder().decode(ev.subarray(q + 2, q + 1 + l));
        q += l + 1;
      }
      p = adEnd;
      const rssi = ev[p] > 127 ? ev[p] - 256 : ev[p]; p++;        // signed
      const prev = seen.get(mac);
      seen.set(mac, { rssi, name: name || prev?.name || "" });
    }
  }
  hciCmd(0x08, 0x00c, Uint8Array.from([0x00, 0x00]));             // LE_Set_Scan_Enable off
  const rows = [...seen.entries()].sort((a, b) => b[1].rssi - a[1].rssi);
  out(`scan: ${rows.length} device(s) (${rawEvents} raw events)\n`);
  for (const [mac, v] of rows) out(`  ${mac}  ${String(v.rssi).padStart(4)} dBm  ${v.name}\n`);
} else if (action === "adv") {
  // LE advertise. Self-contained: downloads fw first if the chip is still in ROM.
  if (!claim(0)) { out(`adv: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const sv = await ensurePatched();
  out(`adv: controller lmp_subver=0x${(sv >>> 0).toString(16)}${sv === 0x8761 ? " (STILL ROM!)" : " (patched)"}\n`);

  const bd = cmdC(0x04, 0x009); // Read_BD_ADDR
  const mac = bd.status === 0 && bd.ret.length >= 6
    ? Array.from(bd.ret.subarray(0, 6)).reverse().map(h).join(":") : "??";

  // LE_Set_Advertising_Parameters: ADV_IND (connectable), interval 0x00A0 (~100ms),
  // public addr, all 3 channels (0x07), no filter.
  const ap = cmdC(0x08, 0x006, Uint8Array.from([0xa0, 0x00, 0xa0, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0x07, 0x00]));

  // Build 31-byte adv data: Flags (LE general disc, no BR/EDR) + Complete Local Name.
  const name = enc.encode(Deno.env.get("BT_ADV_NAME") ?? "RTL8761-AW");
  const ad = new Uint8Array(32); // [sig_len][31 bytes]
  let o = 1;
  ad[o++] = 0x02; ad[o++] = 0x01; ad[o++] = 0x06;              // Flags
  ad[o++] = 1 + name.length; ad[o++] = 0x09; ad.set(name, o); o += name.length; // Complete Local Name
  ad[0] = o - 1;                                                // significant length
  const sd = cmdC(0x08, 0x008, ad);                            // LE_Set_Advertising_Data
  const en = cmdC(0x08, 0x00a, Uint8Array.from([0x01]));       // LE_Set_Advertise_Enable

  const secs = Number(Deno.env.get("BT_ADV_SECS") ?? "20");
  out(`adv: params=${ap.status} data=${sd.status} enable=${en.status}\n`);
  out(`adv: broadcasting "${new TextDecoder().decode(name)}" as ${mac} for ${secs}s — look on a phone BLE scanner\n`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  cmdC(0x08, 0x00a, Uint8Array.from([0x00]));                  // LE_Set_Advertise_Enable off
  out(`adv: stopped\n`);
} else if (action === "connect") {
  // LE connect + GATT primary service discovery. Self-contained (downloads fw if needed).
  if (!claim(0)) { out(`connect: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const handle = await connectTarget("connect");
  if (handle < 0) Deno.exit(1);
  out(`connect: primary services:\n`);
  const svcs = discoverServices(handle);
  for (const s of svcs) out(`  [0x${s.start.toString(16).padStart(4, "0")}-0x${s.end.toString(16).padStart(4, "0")}] ${s.uuid}\n`);
  out(`connect: ${svcs.length} service(s). disconnecting.\n`);
  disconnect(handle);
} else if (action === "read") {
  // Connect, then for every service discover characteristics and read the readable ones.
  if (!claim(0)) { out(`read: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const handle = await connectTarget("read");
  if (handle < 0) Deno.exit(1);
  const svcs = discoverServices(handle);
  out(`read: ${svcs.length} service(s); characteristics + values:\n`);
  for (const s of svcs) {
    out(`  service ${s.uuid} [0x${s.start.toString(16).padStart(4, "0")}-0x${s.end.toString(16).padStart(4, "0")}]\n`);
    for (const c of discoverChars(handle, s.start, s.end)) {
      const flags = (c.props & 0x02 ? "R" : "-") + (c.props & 0x0c ? "W" : "-") + (c.props & 0x10 ? "N" : "-") + (c.props & 0x20 ? "I" : "-");
      let val = "";
      if (c.props & 0x02) {
        const raw = readChar(handle, c.valueHandle);
        if (raw) {
          const asc = Array.from(raw).map((x) => x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".").join("");
          val = `= ${Array.from(raw).map(h).join(" ")}  "${asc}"`;
        } else val = "= <read denied>";
      }
      out(`    ${c.uuid} h=0x${c.valueHandle.toString(16).padStart(4, "0")} [${flags}] ${(GATT_NAMES[c.uuid] ?? "").padEnd(16)} ${val}\n`);
    }
  }
  out(`read: done. disconnecting.\n`);
  disconnect(handle);
} else if (action === "notify") {
  // Connect, subscribe to a notify/indicate characteristic's CCCD, stream notifications.
  if (!claim(0)) { out(`notify: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const handle = await connectTarget("notify");
  if (handle < 0) Deno.exit(1);
  const svcs = discoverServices(handle);
  const wantUuid = (Deno.env.get("BT_NOTIFY_UUID") ?? "").toLowerCase();
  // gather every notify/indicate characteristic, then pick the best: prefer NOTIFY over
  // INDICATE and deprioritize Service Changed (0x2a05), which only fires on a GATT DB change.
  const cands: { svc: Svc; chars: Char[]; idx: number; score: number }[] = [];
  for (const s of svcs) {
    const chars = discoverChars(handle, s.start, s.end);
    for (let i = 0; i < chars.length; i++) {
      if (!(chars[i].props & 0x30)) continue;                    // 0x10 notify | 0x20 indicate
      if (wantUuid && chars[i].uuid.toLowerCase() !== wantUuid) continue;
      const score = (chars[i].props & 0x10 ? 2 : 0) + (chars[i].uuid === "0x2a05" ? 0 : 1) + (chars[i].uuid.startsWith("0x") ? 1 : 0);
      cands.push({ svc: s, chars, idx: i, score });
    }
  }
  const chosen = cands.sort((a, b) => b.score - a.score)[0];
  if (!chosen) { out(`notify: no notify/indicate characteristic found\n`); disconnect(handle); Deno.exit(1); }
  const c = chosen.chars[chosen.idx];
  const next = chosen.chars[chosen.idx + 1];
  const cccd = findCCCD(handle, c.valueHandle + 1, next ? next.declHandle - 1 : chosen.svc.end);
  const indicate = !(c.props & 0x10) && !!(c.props & 0x20);
  out(`notify: char ${c.uuid} value_h=0x${c.valueHandle.toString(16)} cccd=${cccd < 0 ? "none" : "0x" + cccd.toString(16)} mode=${indicate ? "indicate" : "notify"}\n`);
  if (cccd < 0) { out(`notify: no CCCD (0x2902) — cannot subscribe\n`); disconnect(handle); Deno.exit(1); }
  const cfg = indicate ? 0x0002 : 0x0001;
  out(`notify: CCCD write ${attWrite(handle, cccd, Uint8Array.from([cfg & 0xff, 0x00])) ? "ok" : "FAILED"}\n`);

  const secs = Number(Deno.env.get("BT_NOTIFY_SECS") ?? "15");
  out(`notify: listening ${secs}s...\n`);
  const t0 = Date.now(); let count = 0;
  while (Date.now() - t0 < secs * 1000) {
    const r = aclRecv(1000);
    if (!r || r.cid !== ATT_CID || r.payload.length < 3) continue;
    const p = r.payload;
    if (p[0] !== 0x1b && p[0] !== 0x1d) continue;                // notification | indication
    const ah = p[1] | (p[2] << 8);
    const v = p.subarray(3);
    const asc = Array.from(v).map((x) => x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".").join("");
    out(`  [${((Date.now() - t0) / 1000).toFixed(1).padStart(4)}s] h=0x${ah.toString(16).padStart(4, "0")} ${Array.from(v).map(h).join(" ")}  "${asc}"\n`);
    count++;
    if (p[0] === 0x1d) aclSend(handle, ATT_CID, Uint8Array.from([0x1e])); // Handle Value Confirmation
  }
  out(`notify: ${count} notification(s). unsubscribing + disconnecting.\n`);
  attWrite(handle, cccd, Uint8Array.from([0x00, 0x00]));
  disconnect(handle);
} else if (action === "romver") {
  // Read ROM Version: vendor OGF=0x3f, OCF=0x06d (opcode 0xFC6D). Selects the fw patch.
  if (!claim(0)) { out(`romver: claim iface0 failed errno=${errno()}\n`); Deno.exit(1); }
  const sent = hciCmd(0x3f, 0x06d);
  out(`romver: Read_ROM_Version sent rc=${sent}\n`);
  const ev = new Uint8Array(64);
  const n = bulk(0x81, ev, 1500);
  if (n <= 0) { out(`  no event (rc=${n})\n`); Deno.exit(1); }
  out(`  event: ${hex(ev, n)}\n`);
  // 0e len ncmd op_lo op_hi status rom_version
  if (n >= 7 && ev[0] === 0x0e) out(`  status=${h(ev[5])} rom_version=0x${h(ev[6])}\n`);
} else {
  out(`unknown action: ${action}\n`);
  Deno.exit(2);
}
