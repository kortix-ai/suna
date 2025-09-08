#!/bin/bash

# Start supervisord in the foreground to properly manage child processes
exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf