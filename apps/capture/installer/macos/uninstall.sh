#!/bin/sh
# Removes Kortix Capture from this Mac: sudo "/Applications/Kortix Capture.app/Contents/Resources/uninstall.sh"
# People's libraries (~/Library/Application Support/ai.kortix.capture) stay.
if [ "$(/usr/bin/id -u)" != "0" ]; then
  echo "Run this as root: sudo \"$0\"" >&2
  exit 1
fi
/bin/launchctl bootout system/ai.kortix.capture.machine >/dev/null 2>&1
for uid in $(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk '$2 >= 500 { print $2 }'); do
  /bin/launchctl bootout "gui/$uid" /Library/LaunchAgents/ai.kortix.capture.agent.plist >/dev/null 2>&1
  /bin/launchctl bootout "gui/$uid/ai.kortix.capture.agent" >/dev/null 2>&1
  # bootout is asynchronous: wait until launchd has dropped the job.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    /bin/launchctl print "gui/$uid/ai.kortix.capture.agent" >/dev/null 2>&1 || break
    sleep 1
  done
done
# Services a person started for themselves (kortix-capture start).
for home in /Users/*; do
  for plist in "$home"/Library/LaunchAgents/ai.kortix.capture.service.*.plist; do
    [ -f "$plist" ] || continue
    uid=$(/usr/bin/stat -f %u "$plist")
    /bin/launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1
    /bin/rm -f "$plist"
  done
done
/usr/bin/pkill -f "Kortix Capture.app/Contents/MacOS" >/dev/null 2>&1
/bin/rm -f /Library/LaunchDaemons/ai.kortix.capture.machine.plist /Library/LaunchAgents/ai.kortix.capture.agent.plist
/bin/rm -f /usr/local/bin/kortix-capture /var/log/kortix-capture-machine.log
/bin/rm -rf "/Library/Application Support/Kortix"
/usr/sbin/pkgutil --forget ai.kortix.capture.pkg >/dev/null 2>&1
/bin/rm -rf "/Applications/Kortix Capture.app"
echo "Kortix Capture removed."
exit 0
