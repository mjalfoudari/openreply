#!/bin/bash
# Delivery health check, every 15 minutes. See scripts/delivery-health.ts for why.
# Absolute interpreters + explicit PATH: launchd's environment has neither node nor
# homebrew python, and npx shells out to `node` by name.
set -euo pipefail
export PATH="/Users/mj/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
cd "/Users/mj/Shakesbeard Labs/My Apps/openreply"
/Users/mj/.local/bin/npx tsx --env-file=.env scripts/delivery-health.ts
