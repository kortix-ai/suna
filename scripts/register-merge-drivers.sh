#!/bin/sh
# Registers this repository's custom git merge drivers. `.gitattributes` names
# a driver per path, but git uses a driver only once this configuration
# exists; before that it runs its plain text merge. The root package.json
# `prepare` script runs this file on every `pnpm install`, so no clone depends
# on someone remembering a setup step.
set -e

# Translation catalogs (apps/web/translations/*.json): merge key by key and
# keep key order. See apps/web/scripts/i18n-catalogs.mjs. Git runs the driver
# from the top of the worktree. Without node on PATH (a GUI client) or without
# the script (an old checkout), git's own text merge runs instead: markers,
# never a file that silently holds only our side.
git config merge.i18n-catalog.name 'translation catalogs: key-wise merge that keeps key order'
git config merge.i18n-catalog.driver 'command -v node >/dev/null 2>&1 && test -f apps/web/scripts/i18n-catalogs.mjs && exec node apps/web/scripts/i18n-catalogs.mjs merge-driver %O %A %B %L %P %S %X %Y; exec git merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B'
