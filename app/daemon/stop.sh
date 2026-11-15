#!/bin/sh
# Stop the daemon and give the mic button back to LG's assistant.
DATA=/media/developer/lgtv-assist
mkdir -p "$DATA"; touch "$DATA/disabled"
[ -f /tmp/lgtv-assist.pid ] && kill "$(cat /tmp/lgtv-assist.pid)" 2>/dev/null
[ -f /tmp/lgtv-assist.daemon.pid ] && kill "$(cat /tmp/lgtv-assist.daemon.pid)" 2>/dev/null
rm -f /tmp/lgtv-assist.pid /tmp/lgtv-assist.daemon.pid
sleep 1
rm -f /tmp/lifesgoodwithoutspying.claim.com.webos.service.voiceconductor
# Only undo our own stub: if Life's Good Without Spying blocks voice, LG's assistant stays off
# (its stand-in comes back by itself once our claim is gone).
if [ -e /tmp/lgtv-assist.mounted ]; then
  grep -q " /usr/sbin/voiceconductor " /proc/mounts && umount /usr/sbin/voiceconductor
  rm -f /tmp/lgtv-assist.mounted
  systemctl start voiceconductor.service 2>/dev/null
fi
exit 0
