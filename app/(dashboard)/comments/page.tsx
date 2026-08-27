"use client";

/**
 * Comments — triage queue for genuine audience comments.
 *
 * Unlike Instagram's own activity feed, this list never reorders or resets
 * scroll: polling only appends newly-ingested rows, and replying/dismissing
 * removes exactly the one row acted on. Filtered-out comments (CTA keyword
 * hits, LLM-flagged low-effort/spam) are not shown here by default — see the
 * "Filtered" toggle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TriagedCommentListItem } from "@/app/api/triage/comments/route";

const POLL_MS = 30_000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CommentsPage() {
  const [view, setView] = useState<"pending" | "filtered">("pending");
  const [comments, setComments] = useState<TriagedCommentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const actionedIds = useRef(new Set<string>());

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/triage/comments?view=${view}`, { cache: "no-store" });
        const data = await res.json();
        if (data.success) {
          if (silent) {
            // Merge-only: append genuinely new rows, never reorder/replace
            // rows already on screen (that's the whole point of this page).
            setComments((prev) => {
              const seen = new Set(prev.map((c) => c.id));
              const fresh = data.data.comments.filter(
                (c: TriagedCommentListItem) => !seen.has(c.id) && !actionedIds.current.has(c.id)
              );
              return fresh.length ? [...prev, ...fresh] : prev;
            });
          } else {
            setComments(data.data.comments);
          }
          setError(null);
        } else if (!silent) {
          setError(data.error ?? "Failed to load comments");
        }
      } catch {
        if (!silent) setError("Failed to load comments");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [view]
  );

  useEffect(() => {
    setComments([]);
    void load(false);
    const timer = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function handleReply(id: string) {
    const message = (drafts[id] ?? "").trim();
    if (!message || busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/triage/comments/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (data.success) {
        actionedIds.current.add(id);
        setComments((prev) => prev.filter((c) => c.id !== id));
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setError(data.error ?? "Failed to send reply");
      }
    } catch {
      setError("Failed to send reply");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/triage/comments/${id}/dismiss`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        actionedIds.current.add(id);
        setComments((prev) => prev.filter((c) => c.id !== id));
      } else {
        setError(data.error ?? "Failed to dismiss");
      }
    } catch {
      setError("Failed to dismiss");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Comments</h1>
        <div className="flex gap-2 text-sm">
          <button
            type="button"
            onClick={() => setView("pending")}
            className={`rounded px-3 py-1.5 ${
              view === "pending" ? "bg-accent text-white" : "border border-border text-muted"
            }`}
          >
            To reply
          </button>
          <button
            type="button"
            onClick={() => setView("filtered")}
            className={`rounded px-3 py-1.5 ${
              view === "filtered" ? "bg-accent text-white" : "border border-border text-muted"
            }`}
          >
            Filtered
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted">
          {view === "pending" ? "No comments waiting on you." : "Nothing filtered."}
        </p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div key={c.id} className="rounded border border-border p-4">
              <div className="flex items-start gap-3">
                {c.mediaThumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.mediaThumbnailUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">
                      @{c.authorUsername ?? "unknown"}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">
                      {formatTime(c.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-foreground">{c.text}</p>
                  {view === "filtered" && (
                    <span className="mt-1 inline-block text-[11px] uppercase tracking-wide text-zinc-500">
                      {c.classification}
                    </span>
                  )}
                </div>
              </div>

              {view === "pending" && (
                <div className="mt-3 flex items-end gap-2">
                  <textarea
                    value={drafts[c.id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    rows={1}
                    placeholder="Write a reply…"
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleReply(c.id)}
                    disabled={busyId === c.id || !(drafts[c.id] ?? "").trim()}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDismiss(c.id)}
                    disabled={busyId === c.id}
                    className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
