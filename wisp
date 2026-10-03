#!/data/data/com.termux/files/usr/bin/bash
# wisp — codename for our no-root RTL8761B USB Bluetooth adapter (the will-o'-the-wisp: it
# conjures phantom device identities on a fresh random address every beacon). Single entry
# point over the /root/rtl8761-bt driver (btctl.ts core + bletx + bletui). FOR OWN-DEVICE USE.
#
#   wisp scan            BLE scan, results at the end (BT_SCAN_SECS=5)
#   wisp live            continuous BLE scan, each device printed as heard (until killed)
#   wisp connect         connect + list GATT primary services (BT_TARGET=<mac>)
#   wisp read            connect + read all readable characteristics
#   wisp notify          subscribe to a notify/indicate char (BT_NOTIFY_UUID, BT_NOTIFY_SECS)
#   wisp write           write a char + read back (BT_WRITE_HEX=deadbeef, BT_WRITE_UUID)
#   wisp pair            LE Just Works pairing/bonding (BT_PAIR_READ_UUID reads a char after)
#   wisp adv <preset> [secs] [txpower]   rotating-address advertise; presets:
#                        apple|samsung|google|windows|all|swiftpair|fastpair|ibeacon|eddystone
#   wisp tui             touch-TUI launcher (brand + power + range)
#   wisp desc|hci|romver|fwdl            low-level bring-up / info
set -u
export PATH="/data/data/com.termux/files/usr/bin:$PATH"
T=/root/rtl8761-bt; cd "$T" || exit 1
CACHE="$T/.btdev"

list() { termux-usb -l 2>/dev/null | grep -oE '/dev/bus/usb/[0-9]+/[0-9]+'; }
find_dev() {
  if [ -f "$CACHE" ] && list | grep -qx "$(cat "$CACHE")" \
     && ./btctl.sh desc "$(cat "$CACHE")" 2>/dev/null | grep -q 'vid=2550 pid=8761'; then cat "$CACHE"; return; fi
  echo "wisp: locating adapter (tap the USB popup for each probe)..." >&2
  for d in $(list); do
    if ./btctl.sh desc "$d" 2>/dev/null | grep -q 'vid=2550 pid=8761'; then echo "$d" > "$CACHE"; echo "$d"; return; fi
  done
}

cmd="${1:-tui}"; shift 2>/dev/null || true       # bare `wisp` opens the TUI
case "$cmd" in
  tui)             exec perl "$T/bletui.pl" ;;
  adv | spam)      exec bash "$T/bletx.sh" "$@" ;;
  live)            # continuous scan, device lines streamed as heard (termux-usb holds stdout
                   # until exit, so the driver writes them to a FIFO and we relay it)
    D="$(find_dev)"
    [ -z "$D" ] && { echo "wisp: RTL8761 adapter (2550:8761) not found in: $(list | tr '\n' ' ')"; exit 1; }
    F="$T/.scanfifo"; rm -f "$F"; mkfifo "$F" || exit 1
    BT_SCAN_SECS=0 BT_SCAN_LIVE="$F" ./btctl.sh scan "$D" >/dev/null 2>&1 &
    cat "$F"; rm -f "$F" ;;
  help | -h)       grep '^#[^!]' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *)
    D="$(find_dev)"
    [ -z "$D" ] && { echo "wisp: RTL8761 adapter (2550:8761) not found in: $(list | tr '\n' ' ')"; exit 1; }
    exec ./btctl.sh "$cmd" "$D" ;;
esac
