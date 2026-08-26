#!/bin/bash
# Rotate every campaign's 10 public reply rows. Run twice a day by
# ~/Library/LaunchAgents/com.mjalfoudari.openreply-rotate.plist
#
# The 10-row cap is OpenReply's, not ours: a reel taking 300 comments shows those ten
# strings ~30 times each. Rotating is the only way to widen what people actually see
# without writing new copy.
#
# Absolute interpreter paths on purpose — launchd runs with a minimal PATH that has
# neither node nor homebrew python in it, and the first version of this failed at
# 09:00 with "npx: command not found" and nothing else to show for it.
set -euo pipefail

# npx shells out to `node` by name, so an absolute path to npx is not enough — the
# PATH it inherits from launchd must contain node too.
export PATH="/Users/mj/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

REPO="/Users/mj/Shakesbeard Labs/My Apps/openreply"
BANKS="${OPENREPLY_BANKS_DIR:-/Users/mj/.claude/skills/openreply-campaign}"
PYTHON="${PYTHON_BIN:-/opt/homebrew/bin/python3}"
NPX="${NPX_BIN:-/Users/mj/.local/bin/npx}"

cd "$REPO"
"$PYTHON" "$BANKS/rotate.py" 40 | "$NPX" tsx --env-file=.env scripts/apply-replies.ts
