# Pi project directory

Pi reads this `.pi/` directory as its native project config, per Pi's own
conventions. Kortix does not write to it or interpret its contents — it
only routes sessions here once the `pi` runtime profile is selected.

There is no documented native config shape to seed yet (Pi is an
experimental harness this cycle); this file exists purely so the directory
is present and non-empty. Add whatever native Pi config your project needs.
