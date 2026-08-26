# Running the DM worker under launchd

The web app is on Vercel, Postgres on Neon, Redis on Redis Cloud — but the BullMQ
worker runs on this Mac. `net.shakesbeard.openreply-worker.plist` is a launchd
**user agent** that keeps it alive across terminal exits, crashes, reboots, and
sleep. (Logout is the one gap — see "What 'persistent' actually means" below.)

Equivalent to running this by hand, minus the terminal:

```
npx tsx --env-file=.env worker/dm-worker.ts
```

The plist calls the repo's local `node_modules/.bin/tsx` with an absolute `node`
(`/Users/mj/.local/bin/node` → `/Users/mj/.hermes/node/bin/node`) instead of
`npx`, because launchd runs with a bare `PATH` and no login shell — `npx` would
not resolve, and it would add two pointless processes to the tree.

No secrets live in the plist. `--env-file=.env` is resolved by node against
`WorkingDirectory`, so `.env` stays the single source of config.

## Install

Stop the ephemeral terminal worker **first**, or you will briefly run two workers
against the same queue:

```sh
pkill -f "tsx.*worker/dm-worker.ts"
```

Then:

```sh
mkdir -p ~/Library/LaunchAgents

cp "/Users/mj/Shakesbeard Labs/My Apps/openreply/ops/net.shakesbeard.openreply-worker.plist" \
   ~/Library/LaunchAgents/net.shakesbeard.openreply-worker.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.shakesbeard.openreply-worker.plist
```

`RunAtLoad` starts it immediately, so there is no separate start command.

If `bootstrap` fails with `Input/output error` (5), the label was disabled by a
previous `bootout -w` or `disable`; clear it and retry:

```sh
launchctl enable gui/$(id -u)/net.shakesbeard.openreply-worker
```

### What "persistent" actually means here

A `gui/$UID` agent is tied to the logged-in GUI session (`launchctl managername`
reports `Aqua`). Concretely:

| Event | Worker |
| --- | --- |
| Terminal closed / SSH session ends | keeps running |
| Worker crashes or exits | restarted by `KeepAlive` after 10s |
| Reboot | starts again at login, no action needed |
| Mac sleeps | pauses, resumes on wake (see below) |
| **Full logout** (not reboot) | **stops until next login** |

That last row is the one caveat: no LaunchAgent runs while nobody is logged in.
If the Mac must process DMs while sitting at the login window, this has to be a
LaunchDaemon in `/Library/LaunchDaemons` running as root or via `UserName`, which
is a different (root-owned, `sudo`) install. For a personal Mac that reboots
straight back to a logged-in session, the agent is enough — just prefer restart
over logout.

## Status

```sh
launchctl print gui/$(id -u)/net.shakesbeard.openreply-worker
```

Look at `state = running`, `pid`, and `last exit code`. Quick one-liner:

```sh
launchctl list | grep openreply
```

Columns are `PID  last-exit-code  Label`. A `-` in the PID column means not
running; a repeatedly changing PID means it is crash-looping (see logs).

## Logs

```sh
tail -f "/Users/mj/Shakesbeard Labs/My Apps/openreply/ops/worker.log"
tail -f "/Users/mj/Shakesbeard Labs/My Apps/openreply/ops/worker.err.log"
```

Both are gitignored (`/ops/*.log`). launchd appends forever and does not rotate —
truncate them if they get large:

```sh
: > "/Users/mj/Shakesbeard Labs/My Apps/openreply/ops/worker.log"
```

## Restart / uninstall

```sh
# restart in place (after a code change or a wedged connection)
launchctl kickstart -k gui/$(id -u)/net.shakesbeard.openreply-worker

# uninstall
launchctl bootout gui/$(id -u)/net.shakesbeard.openreply-worker
rm ~/Library/LaunchAgents/net.shakesbeard.openreply-worker.plist
```

`bootout` is the only clean way to stop it — `kill` just makes `KeepAlive` start
it again 10 seconds later.

Editing the plist requires a re-copy plus `bootout` then `bootstrap`; launchd
caches the loaded definition and will not pick up file edits on its own.

## Verify it works

```sh
curl -s https://openreply-chi-lac.vercel.app/api/health | python3 -m json.tool
```

Expect `checks.worker.healthy: true` (note the `checks.` prefix — that is the
real JSON path) and a `checks.worker.heartbeat.pid` matching the launchd PID:

```sh
curl -s https://openreply-chi-lac.vercel.app/api/health \
  | python3 -c 'import json,sys; w=json.load(sys.stdin)["checks"]["worker"]; print(w["healthy"], w["heartbeat"])'
launchctl list | grep openreply
```

The two PIDs will not match: launchd supervises the `tsx` launcher, and the
heartbeat comes from the node child that `tsx` spawns. What matters is that the
heartbeat PID changes when you `kickstart -k`. `pgrep -f dm-worker.ts` shows both.

The worker writes its heartbeat to Redis every 30s with a 120s TTL, so allow up
to ~2 minutes after a stop before `/api/health` flips to `healthy: false`, and up
to ~30s after a start before it flips back to `true`. The whole endpoint returns
HTTP 503 when the worker is down, so this also works as a plain uptime check.

## Sleep, and what happens to queued jobs

**Jobs are not lost while the Mac sleeps.** The queue lives in Redis Cloud, not on
this machine. Instagram webhooks keep hitting Vercel, Vercel keeps enqueueing into
Redis, and the jobs simply sit in `waiting`. When the Mac wakes, ioredis
reconnects and BullMQ drains the backlog. Delayed jobs (the follow-up DMs) fire on
wake using their original due time, so a long sleep means they arrive late, not
never.

Two consequences worth knowing:

- `/api/health` reports `worker.healthy: false` during sleep, because the heartbeat
  TTL expires after 120s. That is expected, not a fault.
- The 5-minute comment-reconciler poll does not run while asleep. That is the
  safety net for comments Instagram's webhooks miss; a sweep runs 10s after wake.

`KeepAlive` handles a crashed or exited process. It does **not** help if the
process is alive but its Redis socket went stale — ioredis auto-reconnects, which
covers this in practice, but if the health endpoint stays `false` while
`launchctl list` shows a stable PID, that is the case. Fix:

```sh
launchctl kickstart -k gui/$(id -u)/net.shakesbeard.openreply-worker
```

To avoid the sleep window entirely, keep the Mac awake:

```sh
sudo pmset -a sleep 0 disablesleep 1     # desk/plugged-in setup only
```

## Gotchas

- The repo path contains spaces. In the plist that is fine — each argv element is
  its own `<string>`, so no quoting or escaping is involved. Shell commands in this
  README quote the path for the same reason.
- If node moves (`which node` no longer prints `/Users/mj/.local/bin/node`), update
  `ProgramArguments[0]`, then `bootout` + `bootstrap`.
- Only one worker should run at a time. Check with
  `ps -Ao pid,command | grep dm-worker | grep -v grep` before installing.
