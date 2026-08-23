<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Working on the sender

The worker is not deployed with the web app. It is a long-lived local `tsx`
process (`npm run worker`), so **nothing you edit under `lib/` reaches the sender
until that process is restarted.** A fix can be committed, green in tests, and
still not live. Confirm with `ps aux | grep worker/dm-worker.ts`.

Restart only when the queue is idle:

```bash
pkill -f "worker/dm-worker.ts"; sleep 2
nohup npm run worker > /tmp/openreply-worker.log 2>&1 &
```

Killing the worker mid-job makes BullMQ treat that job as stalled and re-run it.
A re-run of a private reply that already landed is a duplicate DM to a real
person, so check `getJobCounts` for `waiting`/`active` at 0 first.

## Never bulk-retry a FAILED DM

Meta returns a generic `Error 1: An unknown error has occurred` for private
replies it actually delivered, and Instagram allows exactly one private reply per
comment. So `FAILED` in `dmLog` does **not** mean undelivered, and a retry cannot
repair the send — it only delivers a second copy. Verified once the hard way: a
recipient got five identical DMs while every attempt logged FAILED.

Before resending anything by hand, read the real thread —
`INSTAGRAM_LIST_ALL_CONVERSATIONS` filtered by `user_id` = the row's
`commenterId`, then `INSTAGRAM_LIST_ALL_MESSAGES`. Test exactly one before
touching the rest.

## Keyword matching must stay unicode-aware

`\w` and `\b` are ASCII-only in JavaScript. An ASCII cleaner reduces an Arabic
comment to `""` and an ASCII word boundary never fires beside an Arabic letter, so
a campaign gated on non-Latin keywords silently matches nothing and logs nothing.
Keep the Arabic cases in `__tests__/keyword-matcher.test.ts`.
