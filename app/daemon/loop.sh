#!/bin/sh
# Keeps the daemon running until the "disabled" flag appears.
D="$(cd "$(dirname "$0")" && pwd)"
while [ ! -e /media/developer/lgtv-assist/disabled ]; do
  NODE_PATH=/usr/lib/nodejs /usr/bin/node "$D/satellite.js" >> /tmp/lgtv-assist.out 2>&1
  sleep 3
done
