#!/bin/sh
# Boot hook for LG TV Assist (linked as /var/lib/webosbrew/init.d/60-lgtv-assist).
# Takes the Magic Remote mic from LG's voiceconductor and runs the ESPHome satellite daemon.
D="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
[ -f "$D/satellite.js" ] || exit 0
[ -e /media/developer/lgtv-assist/disabled ] && exit 0
if ! grep -q " /usr/sbin/voiceconductor " /proc/mounts; then
  mount --bind "$D/voiceconductor-stub" /usr/sbin/voiceconductor
fi
systemctl stop voiceconductor.service 2>/dev/null
systemctl start voiceinput.service 2>/dev/null
mkdir -p /media/developer/lgtv-assist
if [ -f /tmp/lgtv-assist.pid ] && kill -0 "$(cat /tmp/lgtv-assist.pid)" 2>/dev/null; then exit 0; fi
(
  echo $$ > /tmp/lgtv-assist.pid
  while [ ! -e /media/developer/lgtv-assist/disabled ]; do
    NODE_PATH=/usr/lib/nodejs /usr/bin/node "$D/satellite.js" >> /tmp/lgtv-assist.out 2>&1
    sleep 3
  done
) </dev/null >/dev/null 2>&1 &
