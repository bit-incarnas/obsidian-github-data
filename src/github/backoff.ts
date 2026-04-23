/**
 * Backoff + jitter helpers for retry loops.
 *
 * - Exponential base (doubling each attempt), capped at 1hr per the
 *   security-review failure-mode table.
 * - Uniform-random jitter added to every delay, to prevent multi-device
 *   synchronized retry storms (security review H5, bullet 3).
 *
 * Random source and sleep are injectable so test cases can make timing
 * deterministic.
 */

export interface BackoffOptions {
	/** Base delay in ms for attempt 0. Default 1000. */
	baseMs?: number;
	/** Hard cap on backoff delay. Default 3_600_000 (1hr). */
	capMs?: number;
	/** Max random jitter added on top of the exponential. Default 2000. */
	jitterMs?: number;
	/** Injected random in [0, 1). Defaults to Math.random. */
	random?: () => number;
}

/**
 * Compute the delay (ms) for a given retry attempt.
 *
 * attempt=0 -> base + jitter
 * attempt=1 -> base*2 + jitter
 * attempt=N -> min(cap, base * 2^N) + jitter
 */
export function computeBackoff(attempt: number, opts: BackoffOptions = {}): number {
	const base = opts.baseMs ?? 1000;
	const cap = opts.capMs ?? 3_600_000;
	const jitter = opts.jitterMs ?? 2000;
	const random = opts.random ?? Math.random;

	const safeAttempt = Math.max(0, Math.floor(attempt));
	// Math.pow(2, 40) overflows to Infinity eventually; clamp the exponent.
	const exp = safeAttempt > 30 ? cap : Math.min(cap, base * 2 ** safeAttempt);
	const jit = random() * jitter;
	return exp + jit;
}

/** Resolves after `ms` milliseconds. Never rejects. */
export function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}
