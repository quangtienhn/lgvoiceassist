#!/bin/sh
# Stop the daemon and give the mic button back to LG's assistant.
DATA=/media/developer/lgtv-assist
mkdir -p "$DATA"; touch "$DATA/disabled"
[ -f /tmp/lgtv-assist.pid ] && kill "$(cat /tmp/lgtv-assist.pid)" 2>/dev/null
[ -f /tmp/lgtv-assist.daemon.pid ] && kill "$(cat /tmp/lgtv-assist.daemon.pid)" 2>/dev/null
rm -f /tmp/lgtv-assist.pid /tmp/lgtv-assist.daemon.pid
sleep 1
grep -q " /usr/sbin/voiceconductor " /proc/mounts && umount /usr/sbin/voiceconductor
systemctl start voiceconductor.service 2>/dev/null
exit 0
