#!/data/data/com.termux/files/usr/bin/bash
# btctl — thin front-end over termux-usb for the RTL8761 USB Bluetooth control core (no root).
# Usage:
#   btctl list
#   btctl desc   <dev>   # dump device/config/interface/endpoint descriptors
#   btctl hci    <dev>   # claim iface0, send HCI Read_Local_Version, read the event back
#   btctl romver <dev>   # vendor Read_ROM_Version (0xFC6D)
#   btctl fwdl   <dev>   # download rtl8761bu fw+config, HCI_Reset, verify patched subver
#   btctl scan   <dev>   # LE active scan (auto-downloads fw first). BT_SCAN_SECS=5
#   btctl adv    <dev>   # LE advertise. BT_ADV_NAME, BT_ADV_SECS, BT_ADV_PRESET=
#                        #   swiftpair (Windows Connect toast) | ibeacon | eddystone
#   btctl connect <dev>  # LE connect + GATT primary services. BT_TARGET=<mac>, BT_SCAN_SECS
#   btctl read   <dev>   # LE connect + discover characteristics + read readable values
#   btctl notify <dev>   # subscribe to a notify/indicate char. BT_NOTIFY_UUID, BT_NOTIFY_SECS
#   btctl write  <dev>   # write a writable char + read back. BT_WRITE_HEX=deadbeef, BT_WRITE_UUID
#   btctl pair   <dev>   # LE Just Works pairing (SMP) + encrypt; BT_PAIR_READ_UUID reads a char after
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DENO="${DENO:-/root/.deno/bin/deno}"
CORE="$HERE/bt.ts"
export PATH="/data/data/com.termux/files/usr/bin:$PATH"

run() { # action dev
  local action="$1" dev="$2"
  local cb="$HERE/.cb.sh"
  # NB: termux-usb only forwards the callback's stdout when it exits 0, so never let the
  # deno exit code propagate — the driver's output IS the result.
  cat > "$cb" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
HOME=/root BT_ACTION="$action" "$DENO" run -A --no-lock "$CORE" "\$1"
exit 0
EOF
  chmod +x "$cb"
  # manual adv (BT_ADV_SECS=0) and live scan (BT_SCAN_SECS=0) run until the TUI signals them, so no 60s cap
  if { [ "$action" = adv ] && [ "${BT_ADV_SECS:-}" = 0 ]; } || { [ "$action" = scan ] && [ "${BT_SCAN_SECS:-}" = 0 ]; } || [ "$action" = mem ]; then termux-usb -r -e "$cb" "$dev"
  else timeout 60 termux-usb -r -e "$cb" "$dev"; fi
}

cmd="${1:-list}"; shift || true
case "$cmd" in
  list)  termux-usb -l ;;
  desc)   run desc   "$1" ;;
  hci)    run hci    "$1" ;;
  romver) run romver "$1" ;;
  caps)   run caps   "$1" ;;
  mem)    run mem    "$1" ;;
  fwdl)   run fwdl   "$1" ;;
  scan)   run scan   "$1" ;;
  adv)    run adv    "$1" ;;
  connect) run connect "$1" ;;
  read)   run read   "$1" ;;
  notify) run notify "$1" ;;
  write)  run write  "$1" ;;
  pair)   run pair   "$1" ;;
  *)     echo "unknown: $cmd"; exit 2 ;;
esac
