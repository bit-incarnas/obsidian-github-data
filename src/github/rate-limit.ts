/**
 * Rate-limit tracker. Reads GitHub's `X-RateLimit-*` response headers and
 * keeps the most recent snapshot for budget-aware throttling.
 *
 * Governed by the `core` resource (5000 req/hr for authenticated calls).
 * Separate buckets exist for `search` (30/min) and `graphql` (5000 pts/hr);
 * the tracker records whichever resource the response identifies so
 * downstream callers can decide whether a given route is safe to fire.
 *
 * Headers are case-insensitive on the wire. We normalize on read to keep
 * this module oblivious to upstream casing choices (Node fetch lowercases;
 * Obsidian's requestUrl preserves GitHub's mixed case).
 *
 * See 01_DESIGN.md Security Invariants -- Rate-limit discipline.
 */

export interface RateLimitSnapshot {
	/** X-RateLimit-Limit -- bucket size. */
	limit: number;
	/** X-RateLimit-Remaining -- calls left in this window. */
	remaining: number;
	/** X-RateLimit-Reset -- epoch seconds when the bucket resets. */
	reset: number;
	/** X-RateLimit-Used -- calls consumed in this window. */
	used: number;
	/** X-RateLimit-Resource -- core | search | graphql | code_search. */
	resource: string;
	/** When we recorded this snapshot (epoch ms). */
	observedAt: number;
}

export interface RateLimitTrackerOptions {
	/**
	 * Below this remaining-count we consider the bucket "low" and callers
	 * should throttle. Default 500 per security review H5.
	 */
	lowWatermark?: number;
	/** Injected clock for tests. Defaults to `Date.now`. */
	now?: () => number;
}

export class RateLimitTracker {
	private snapshot: RateLimitSnapshot | null = null;
	private readonly lowWatermark: number;
	private readonly now: () => number;

	constructor(options: RateLimitTrackerOptions = {}) {
		this.lowWatermark = options.lowWatermark ?? 500;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Record rate-limit headers from a response. Silently ignores
	 * responses that lack rate-limit headers (e.g. some 5xx responses
	 * from upstream proxies).
	 */
	record(headers: Headers | Record<string, string | string[] | undefined>): void {
		const limit = readHeaderInt(headers, "x-ratelimit-limit");
		const remaining = readHeaderInt(headers, "x-ratelimit-remaining");
		const reset = readHeaderInt(headers, "x-ratelimit-reset");
		if (limit === null || remaining === null || reset === null) return;

		const used = readHeaderInt(headers, "x-ratelimit-used") ?? limit - remaining;
		const resource = readHeaderString(headers, "x-ratelimit-resource") ?? "core";

		this.snapshot = {
			limit,
			remaining,
			reset,
			used,
			resource,
			observedAt: this.now(),
		};
	}

	getSnapshot(): RateLimitSnapshot | null {
		return this.snapshot;
	}

	/** Remaining as a ratio of limit. `null` if we have no snapshot. */
	remainingRatio(): number | null {
		if (!this.snapshot || this.snapshot.limit === 0) return null;
		return this.snapshot.remaining / this.snapshot.limit;
	}

	/** True if remaining is below the low-watermark threshold. */
	isLow(): boolean {
		if (!this.snapshot) return false;
		return this.snapshot.remaining < this.lowWatermark;
	}

	/**
	 * Milliseconds from `now` until the bucket resets. Returns 0 if we
	 * have no snapshot or the reset is already in the past.
	 */
	msUntilReset(): number {
		if (!this.snapshot) return 0;
		const resetMs = this.snapshot.reset * 1000;
		return Math.max(0, resetMs - this.now());
	}

	clear(): void {
		this.snapshot = null;
	}
}

function readHeaderString(
	headers: Headers | Record<string, string | string[] | undefined>,
	name: string,
): string | null {
	if (headers instanceof Headers) {
		return headers.get(name);
	}
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== target) continue;
		if (value == null) return null;
		return Array.isArray(value) ? (value[0] ?? null) : value;
	}
	return null;
}

function readHeaderInt(
	headers: Headers | Record<string, string | string[] | undefined>,
	name: string,
): number | null {
	const raw = readHeaderString(headers, name);
	if (raw === null) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
}
