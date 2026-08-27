/**
 * Keyword-scope matching for comment triage.
 *
 * Mirrors comment-reconciler.ts's own matching logic so a comment triage marks
 * KEYWORD_MATCH exactly when an active automation would actually fire on it —
 * the two must never disagree, or MJ would see "genuine" comments in the
 * triage queue that are actually about to get an automated DM reply.
 */

import { matchKeywords } from "@/lib/utils/keyword-matcher";

export interface AutomationScope {
  id: string;
  postId: string | null;
  matchAnyPost: boolean;
  matchAnyWord: boolean;
  keywords: string[];
  wholeWordMatch: boolean;
}

export function matchesAnyAutomation(
  automations: AutomationScope[],
  mediaId: string,
  text: string
): boolean {
  for (const automation of automations) {
    const inScope = automation.postId === mediaId || automation.matchAnyPost;
    if (!inScope) continue;
    if (automation.matchAnyWord) return true;
    if (matchKeywords(text, automation.keywords, automation.wholeWordMatch).matched) {
      return true;
    }
  }
  return false;
}
