# RTL8761 no-root userspace HCI driver — RESEARCH

Goal: drive a Realtek RTL8761 USB Bluetooth dongle from userspace with **no root**, over
`termux-usb` + libusb/usbfs on the phone — the same transport that gave us the AX56
(RTL8852AU) Wi-Fi driver. Deliver an honest HCI stack: firmware download → HCI reset →
BLE scan / advertise / connect, driven from the terminal.

Sibling project & template: `/root/ax56-ctl` (`rtl8852au-userspace`). The usbfs ioctl
primitives (CONTROL / BULK / CLAIM / DISCONNECT_CLAIM, `pread` for descriptors) are lifted
straight from `tool/ax56.ts`.

---

## 1. Hardware — MEASURED (not assumed)

Device on the bus: `/dev/bus/usb/001/005`.

```
DEVICE   vid=2550 pid=8761 usb=0110 class=e0/01/01 numCfg=1
CONFIG   nIface=2 cfgVal=1 attr=e0 maxPower=500mA
  IFACE  num=0 alt=0 nEP=3 class=e0/01/01        <- HCI transport
    EP 0x81 IN  interrupt mps=16   <- HCI events
    EP 0x02 OUT bulk      mps=64   <- ACL data out
    EP 0x82 IN  bulk      mps=64   <- ACL data in
  IFACE  num=1 (alt 0..5) isoc EP 0x03/0x83       <- SCO voice (ignore for now)
```

- Class `e0/01/01` = Wireless / Radio Frequency / **Bluetooth** — the standard USB BT
  transport. HCI **commands** go over the control endpoint (EP0), not a data EP.
- Endpoints are CONFIRMED by descriptor dump, not guessed.

### HCI already answers before any firmware (ROM bootloader)

`btctl hci` sent `Read_Local_Version` (opcode 0x1001) over EP0 and read the event on EP 0x81:

```
event 0e 0c 02 01 10 00 0a 0b 00 0a 5d 00 61 87
  0e            Command Complete
  0c            param len 12
  02            num cmd pkts
  01 10         opcode 0x1001 (Read_Local_Version)
  00            status OK
  0a            HCI_Version    = 0x0a (BT 5.1)
  0b 00         HCI_Revision   = 0x000b
  0a            LMP_Version    = 0x0a (BT 5.1)
  5d 00         Manufacturer   = 0x005d (93 = Realtek Semiconductor)
  61 87         LMP_Subversion = 0x8761
```

Chip: **Realtek RTL8761B-family, USB**. btrtl `ic_id_table` match is
`lmp_subver=0x8761, hci_rev=0x000b, hci_ver=0x0a, HCI_USB` →
firmware `rtl_bt/rtl8761b_fw.bin` + `rtl_bt/rtl8761b_config.bin` (config **is** needed).
Exact ROM revision to be confirmed via vendor `Read_ROM_Version` (0xFC6D) before picking a
firmware patch.

---

## 2. Transport contract (usbfs, no root)

Reuse verbatim from ax56.ts:
- `USBDEVFS_DISCONNECT_CLAIM` (0x8108551B) with flag 2 → detach any kernel driver +
  claim iface 0 unconditionally. (On Android there is usually no `btusb` bound, but the
  host BT HAL may hold it — claim handles it.)
- HCI **command**: `USBDEVFS_CONTROL`, `bmRequestType=0x20, bRequest=0, wValue=0,
  wIndex=0`, data = `[opcode_lo, opcode_hi, plen, params...]`.
- HCI **event**: read EP `0x81` (interrupt; usbfs BULK ioctl services interrupt EPs too —
  worked in recon).
- **ACL** data: bulk OUT `0x02` / bulk IN `0x82`.
- **SCO**: isoc iface 1 — out of scope for v1.

---

## 3. Firmware download protocol (btrtl, to port)

RTL8761 ROM runs HCI but needs a firmware+config patch to expose the full controller.
Sequence (from `drivers/bluetooth/btrtl.c`):

1. `Read_ROM_Version` — vendor cmd **0xFC6D** (OGF 0x3f, OCF 0x06d). Returns `status` +
   `rom_version` byte. Selects which patch inside the fw file to use.
2. Load `rtl8761b_fw.bin` (+ `rtl8761b_config.bin`). New-format fw has an 8-byte epatch
   signature and an extension section; parse the patch table, pick the entry whose
   `chip_id` matches `rom_version+1`, concatenate that patch payload with the config blob.
3. Download — vendor cmd **0xFC20** (OGF 0x3f, OCF 0x020), fragmented:
   `[index_byte][<=252 data bytes]`. `index` increments 0,1,2,…; bit7 (0x80) set on the
   **final** fragment. Each fragment gets a Command Complete with the echoed index.
4. Controller relaunches internally; then `HCI_Reset` (0x0C03). Now full HCI is live.

Open questions to nail during build:
- `rtl8761b` vs `rtl8761bu` filename for THIS lmp/hci pair (confirm against current
  linux-firmware `rtl_bt/` + btrtl table).
- New epatch header format details (offsets of num_patches, chip_id table, payload len).
- Whether config download is mandatory for this unit (btrtl marks 8761B `config_needed`).

Firmware source: linux-firmware `rtl_bt/` (git.kernel.org / GitHub mirror). NOT vendored —
fetch at setup, gitignore the .bin (same rule as ax56 fw).

---

## 4. Milestones (verifiable)

1. **Recon — DONE.** Descriptors + `Read_Local_Version` no-root. ✓
2. **Read_ROM_Version (0xFC6D) — DONE.** `status=00 rom_version=0x01` (event
   `0e 05 02 6d fc 00 01`). Patch match key = chip_id `rom_version+1` in the epatch table. ✓
3. **Fetch + parse fw — DONE.** `rtl8761bu_fw.bin` (44484B, "Realtech" hdr, 2 patches) +
   `rtl8761bu_config.bin` (6B, empty). project_id 0x0e, chosen patch chip_id=2 (=rom+1),
   payload 30210B → 120 fragments. `fw.ts` + `fwparse.ts`. ✓
4. **Download (0xFC20) loop — DONE.** All 120 fragments ACK status 0, final idx 0xf7
   (bit7 set). ✓
5. **HCI_Reset + Read_Local_Version — DONE.** subver `0x8761` (ROM) → **`0xd922`** = low
   16 bits of fw_version 0xdfc6d922 → patch confirmed running. ✓
6. **LE scan — DONE.** After patch: `Set_Event_Mask` + `LE_Set_Event_Mask` (all 0xFF — the
   default masks LE Meta bit 61, so adv reports never arrive without this), then
   `LE_Set_Scan_Params`/`Enable`; parse `LE_Advertising_Report` on EP 0x81. Real result:
   8 nearby BLE devices with MAC + RSSI + names. ✓ **v1 BLE sniffer complete.**
7. **LE advertise — IMPLEMENTED.** `Read_BD_ADDR` (public 00:e0:4c… Realtek OUI),
   `LE_Set_Advertising_Parameters` (ADV_IND, ~100ms, all channels),
   `LE_Set_Advertising_Data` (Flags + Complete Local Name), `LE_Set_Advertise_Enable` —
   all status 0, broadcasts a named device. verify: seen from a phone BLE scanner
   (single radio can't self-verify; pending visual confirmation). (`btctl adv`)

8. **LE connect + GATT — DONE (green end-to-end).** `connect`: scan → pick a connectable
   advertiser (event_type 0/1) or `BT_TARGET=<mac>` → `LE_Create_Connection` → wait
   `LE_(Enhanced_)Connection_Complete` → over ACL (bulk 0x02/0x82, L2CAP CID 0x0004) ATT
   `Exchange_MTU` then `Read_By_Group_Type` (0x2800) loop for primary services →
   `HCI_Disconnect`. Verified against the Arch bench box (`ssh box`, Intel 8260) running a
   BlueZ connectable peripheral "mrx-ble" (`bluetoothctl advertise peripheral`, held by a
   backgrounded pipe): **CONNECTED handle=0x10, discovered GAP 0x1800, GATT 0x1801,
   Device Information 0x180a, and a 128-bit custom service** with correct handle ranges.

Bugs fixed along the way:
- `cmdStatus` reads status at ev[2] (num_cmd is ev[3]).
- termux-usb forwards callback stdout ONLY on exit 0 — btctl's callback now always
  `exit 0`, and bt.ts surfaces throws to stdout (stderr is dropped).
- BT 5.1 controller: enabling the full LE event mask switches Connection Complete to the
  **Enhanced** form (0x3e/0x0a); `waitMeta` accepts both 0x01 and 0x0a (status/handle share
  offsets ev[3]/ev[4..5]).
- ATT read must skip strays: a late MTU-response (0x03) and L2CAP signaling on CID 0x0005
  arrive on the same bulk EP; `attRecv` keeps only CID 0x0004, and discovery retries until
  it sees the matching 0x11/0x01.

9. **Read characteristics — DONE (green end-to-end).** `read`: connect → discover services
   → per service `Read_By_Type` (Char Declaration 0x2803) for characteristics → ATT
   `Read_Request` (0x0a) on each readable (props bit 0x02) value handle. Verified vs the box:
   read GAP Device Name = **"mrx-arch"**, Appearance 0x010c, GATT Database Hash, DevInfo
   PnP ID; a custom RWN characteristic correctly reported `<read denied>` (ATT error, needs
   encryption). Flags R/W/N/I parsed from the declaration; well-known UUIDs named; values as
   hex + ASCII. connect/read share `connectTarget` + `discoverServices` helpers.

10. **Notifications — DONE (green end-to-end).** `notify`: connect → discover → pick a
    notify/indicate characteristic (auto-picks the best: prefers NOTIFY, well-known 16-bit
    UUIDs, and skips Service Changed 0x2a05; or `BT_NOTIFY_UUID=<uuid>`) → `Find_Information`
    (0x04) for its CCCD (0x2902) → `Write_Request` (0x12) CCCD = 0x0001 → stream Handle Value
    Notifications (0x1b) / Indications (0x1d, auto-Confirm 0x1e). Verified vs a BlueZ Heart
    Rate GATT server on the box (`/tmp/gatt_hr.py`, python-dbus): **subscribed to 0x2a37 and
    received one notification/second with the value incrementing 0x3d→…** live. On unsubscribe
    writes CCCD = 0x0000.

11. **Characteristic writes — DONE (green end-to-end).** `write`: connect → discover → pick a
    writable char (auto: prefers readable + well-known 16-bit UUIDs, skips Client Supported
    Features 0x2b29; or `BT_WRITE_UUID`) → `Write_Request` (0x12, ack) if the char has the
    Write prop, else `Write_Command` (0x52, no response) for WriteWithoutResponse → read back
    if readable to verify. `BT_WRITE_HEX=deadbeef`. Verified vs the box: wrote `ca fe 01` to a
    custom read/write echo char (0xabcd) → Write Response ok → **read-back matched**.

v1 = milestones 1–6 (BLE sniffer) DONE. Advertise (7), Connect+discovery (8), Read chars (9),
Notifications (10), Writes (11) DONE. Complete no-root BLE central: scan / advertise / connect
/ discover / read / subscribe / write. Next: a touch-TUI, or descriptor writes / bonding.

## Test rig — box as a BLE peripheral
`ssh box` (Intel 8260, BlueZ). Two peers, both hold via a live process (advertisement drops
when it exits): `/tmp/ble_adv.sh <secs>` = bluetoothctl connectable advertiser "mrx-ble" with
the default GATT DB; `/tmp/gatt_hr.py <secs>` = python-dbus server with a Heart Rate (0x180D/0x2A37) char that
notifies every second once subscribed, plus an Echo char (0xABCD, read+write) that stores and
returns whatever is written. Box BT addr F8:94:C2:4C:6F:7A (public). NB: box shell is zsh, no
hciconfig — drive with bluetoothctl / btmgmt; use `/usr/sbin/ssh box` (see the ssh memory) and
kill it with `pkill -f '[g]att_hr.py'` (bracket avoids self-match).

### Gotchas nailed (for the write-up)
- fw does NOT survive a USB reset on callback close → each fresh termux-usb invocation is
  back in ROM. `scan` is self-contained: `ensurePatched()` re-downloads unless subver is
  already the patched `0xd922`. Any long-lived flow must hold ONE invocation.
- `cmdC` must skip stray events (adv reports, command-status) and match the echoed opcode,
  else the first Read_Local_Version reads a queued 0x3e and looks like a failure.
- Event masks after HCI_Reset are the difference between 0 and 95 events.

---

## 5. Files

- `bt.ts`   — Deno usbfs HCI core (termux-usb callback). Recon slice today; grows per §4.
- `btctl.sh`— front-end: `list` / `desc` / `hci`. Grows: `romver` / `fwdl` / `scan`.
- fw blobs — fetched, gitignored.
