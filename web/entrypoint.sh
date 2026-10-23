#!/bin/sh
# PID1 real sin `sh -c` intermedio: exec reemplaza el proceso.
if [ "$WORKER_MODE" = "1" ]; then
  exec ./node_modules/.bin/tsx worker.ts "$@"
else
  exec node server.js "$@"
fi
