#!/bin/sh
# Thin entrypoint — see run-job-jittered.sh
exec "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/run-job-jittered.sh" list-scan
