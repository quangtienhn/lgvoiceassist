#!/bin/sh
# Homebrew Channel boot hook for LG TV Assist (installed as /var/lib/webosbrew/init.d/60-lgtv-assist).
# Removes itself once the app is uninstalled.
S=/media/developer/apps/usr/palm/services/io.github.xrogers.lgtvassist.service/daemon
if [ ! -x "$S/autostart.sh" ]; then rm -f "$0"; exit 0; fi
exec "$S/autostart.sh"
