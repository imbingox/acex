import type {
  RateLimitBucketSnapshot,
  RateLimitSnapshot,
} from "../../types/index.ts";
import { maxOptional, stateSeverity } from "./state.ts";

export function aggregateBucketSnapshots(
  base: RateLimitSnapshot,
  buckets: RateLimitBucketSnapshot[],
): Pick<
  RateLimitSnapshot,
  "blockedUntil" | "retryAfterMs" | "state" | "updatedAt"
> {
  let selectedBlock: RateLimitBlockedSnapshot | undefined =
    blockCandidate(base);
  let updatedAt = base.updatedAt;

  for (const bucket of buckets) {
    updatedAt = maxOptional(updatedAt, bucket.updatedAt);
    selectedBlock = selectLaterBlock(selectedBlock, blockCandidate(bucket));
  }

  return {
    blockedUntil: selectedBlock?.blockedUntil,
    retryAfterMs: selectedBlock?.retryAfterMs,
    state: selectedBlock?.state ?? base.state,
    updatedAt,
  };
}

interface RateLimitBlockedSnapshot {
  blockedUntil: number;
  retryAfterMs?: number;
  state: RateLimitSnapshot["state"];
}

function blockCandidate(
  snapshot: Pick<RateLimitSnapshot, "blockedUntil" | "retryAfterMs" | "state">,
): RateLimitBlockedSnapshot | undefined {
  if (snapshot.blockedUntil === undefined) {
    return undefined;
  }
  return {
    blockedUntil: snapshot.blockedUntil,
    retryAfterMs: snapshot.retryAfterMs,
    state: snapshot.state,
  };
}

function selectLaterBlock(
  current: RateLimitBlockedSnapshot | undefined,
  candidate: RateLimitBlockedSnapshot | undefined,
): RateLimitBlockedSnapshot | undefined {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.blockedUntil > current.blockedUntil) {
    return candidate;
  }
  if (
    candidate.blockedUntil === current.blockedUntil &&
    stateSeverity(candidate.state) > stateSeverity(current.state)
  ) {
    return candidate;
  }
  return current;
}
