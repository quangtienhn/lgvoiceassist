#!/bin/sh
# LG TV Assist: take the Magic Remote mic from LG's voiceconductor and (re)start the satellite daemon.
# Called by the app service ("start") and by the boot hook /var/lib/webosbrew/init.d/60-lgtv-assist.
D="$(cd "$(dirname "$0")" && pwd)"
DATA=/media/developer/lgtv-assist
mkdir -p "$DATA"
[ -e "$DATA/disabled" ] && exit 0
if ! grep -q " /usr/sbin/voiceconductor " /proc/mounts; then
  mount --bind "$D/voiceconductor-stub" /usr/sbin/voiceconductor
fi
systemctl stop voiceconductor.service 2>/dev/null
systemctl start voiceinput.service 2>/dev/null
if [ -f /tmp/lgtv-assist.pid ] && kill -0 "$(cat /tmp/lgtv-assist.pid)" 2>/dev/null; then exit 0; fi
sh "$D/loop.sh" </dev/null >/dev/null 2>&1 &
echo $! > /tmp/lgtv-assist.pid
