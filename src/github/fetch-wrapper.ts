/**
 * Rate-limit / retry / circuit-breaker wrapper around a base `fetch`.
 *
 * Sits between Octokit (which calls our custom fetch) and the transport
 * layer (Obsidian's `requestUrl`, via `createRequestUrlFetch`). Every
 * request passes through:
 *
 *   1. Circuit-breaker pre-flight   -- short-circuit if auth is known-dead
 *   2. Concurrency slot             -- FIFO cap at N in-flight requests
 *   3. Retry loop with status-based policies:
 *      - 401 once           -> retry; 401 twice trips circuit
 *      - 403 + SSO header   -> open circuit, propagate
 *      - 403 + rate-limit   -> sleep until X-RateLimit-Reset, retry
 *      - 429                -> sleep max(Retry-After, exp-backoff)+jitter
 *      - 5xx                -> exp-backoff + jitter, retry
 *      - status === 0 / TE  -> exp-backoff + jitter, retry
 *      - 2xx / 3xx / other  -> return (success clears auth counter)
 *
 * All policies are governed by `01_DESIGN.md Security Invariants --
 * Rate-limit discipline` and the failure-mode table. Security review
 * H5 + failure-mode table are the normative references.
 */

import { computeBackoff, sleep as defaultSleep, type BackoffOptions } from "./backoff";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";
import { Semaphore } from "./concurrency";
import { RateLimitTracker } from "./rate-limit";

export interface RateLimitedFetchDeps {
	/** Underlying fetch -- typically `createRequestUrlFetch(http)`. */
	inner: typeof fetch;
	rateLimit: RateLimitTracker;
	circuit: CircuitBreaker;
	concurrency: Semaphore;

	/** Max retry attempts for transient failures (5xx / 429 / network). Default 3. */
	maxRetries?: number;
	/** Hard cap on any single sleep (ms). Default 3_600_000 (1hr). */
	maxSleepMs?: number;
	backoff?: BackoffOptions;
	/** Injected sleep for tests. Defaults to setTimeout-backed sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export function wrapWithRateLimit(deps: RateLimitedFetchDeps): typeof fetch {
	const maxRetries = deps.maxRetries ?? 3;
	const maxSleepMs = deps.maxSleepMs ?? 3_600_000;
	const sleep = deps.sleep ?? defaultSleep;

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (deps.circuit.isOpen()) {
			throw new CircuitOpenError(deps.circuit.getReason() ?? "(unknown reason)");
		}

		return deps.concurrency.run(async () => {
			let attempt = 0;
			while (true) {
				if (deps.circuit.isOpen()) {
					throw new CircuitOpenError(
						deps.circuit.getReason() ?? "(unknown reason)",
					);
				}

				let response: Response;
				try {
					response = await deps.inner(input, init);
				} catch (err) {
					// Transport-level failure (status===0 mapped to TypeError by
					// createRequestUrlFetch, or real network exceptions from
					// Node-fetch adapters in tests).
					if (err instanceof TypeError) {
						if (attempt >= maxRetries) throw err;
						await sleep(
							Math.min(maxSleepMs, computeBackoff(attempt, deps.backoff)),
						);
						attempt++;
						continue;
					}
					throw err;
				}

				// Any response -> record rate-limit headers (except on 5xx that
				// lacks them; record() silently ignores missing headers).
				deps.rateLimit.record(response.headers);

				const status = response.status;

				if (status === 401) {
					deps.circuit.record401(`401 Unauthorized on ${describe(input)}`);
					// "Retry once with a fresh connection" per failure-mode table.
					// Only retry on the first hit; the second 401 trips the circuit
					// and is propagated to Octokit (as a RequestError) so callers see
					// the auth failure on this specific request.
					if (attempt === 0 && !deps.circuit.isOpen()) {
						attempt++;
						continue;
					}
					return response;
				}

				if (status === 429) {
					const retryAfterMs = parseRetryAfter(response.headers) * 1000;
					const backoffMs = computeBackoff(attempt, deps.backoff);
					const waitMs = Math.min(maxSleepMs, Math.max(retryAfterMs, backoffMs));
					if (attempt >= maxRetries) return response;
					await sleep(waitMs);
					attempt++;
					continue;
				}

				if (status === 403) {
					// Detect sub-variants. Needs a clone of the body because
					// rate-limit 403s include text; if we don't retry we return
					// the original untouched.
					if (hasSsoRequired(response.headers)) {
						deps.circuit.open("SAML SSO authorization required");
						return response;
					}

					const isRateLimitBody = await is403RateLimit(response);
					if (isRateLimitBody) {
						if (attempt >= maxRetries) return response;
						const resetMs = deps.rateLimit.msUntilReset();
						const backoffMs = computeBackoff(attempt, deps.backoff);
						const waitMs = Math.min(
							maxSleepMs,
							Math.max(resetMs, backoffMs),
						);
						await sleep(waitMs);
						attempt++;
						continue;
					}

					// Non-SSO, non-rate-limit 403 (e.g. missing scope on a specific
					// endpoint). Propagate without retry so Octokit produces a
					// RequestError the caller can inspect.
					return response;
				}

				if (status >= 500 && status < 600) {
					if (attempt >= maxRetries) return response;
					await sleep(
						Math.min(maxSleepMs, computeBackoff(attempt, deps.backoff)),
					);
					attempt++;
					continue;
				}

				// 2xx / 3xx / non-retriable 4xx: record success to reset the 401
				// consecutive-failure counter, then return.
				if (status >= 200 && status < 400) {
					deps.circuit.recordSuccess();
				}
				return response;
			}
		});
	}) as typeof fetch;
}

// -- helpers --------------------------------------------------------------

function describe(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

/**
 * Parse the `Retry-After` header. GitHub returns integer seconds; the
 * HTTP spec also permits an HTTP-date. Both are handled; unknown shapes
 * fall through to 0 so the backoff path still kicks in.
 */
export function parseRetryAfter(headers: Headers): number {
	const raw = headers.get("retry-after");
	if (!raw) return 0;
	const asInt = Number.parseInt(raw, 10);
	if (Number.isFinite(asInt)) return Math.max(0, asInt);
	const asDateMs = Date.parse(raw);
	if (Number.isFinite(asDateMs)) {
		return Math.max(0, Math.ceil((asDateMs - Date.now()) / 1000));
	}
	return 0;
}

export function hasSsoRequired(headers: Headers): boolean {
	const v = headers.get("x-github-sso");
	if (!v) return false;
	// Value shape: "required; url=https://..." (required variant) or partial info.
	return v.toLowerCase().includes("required");
}

/**
 * Distinguish a 403 caused by rate-limiting from other 403s (permission
 * denied, SAML, etc). Primary signal: `X-RateLimit-Remaining: 0` paired
 * with a 403 status. Fallback: inspect the response body for the
 * canonical "rate limit" phrasing.
 *
 * Clones the response so the body remains consumable by downstream
 * callers (Octokit reads it to build RequestError / data).
 */
export async function is403RateLimit(response: Response): Promise<boolean> {
	const remaining = response.headers.get("x-ratelimit-remaining");
	if (remaining === "0") return true;

	try {
		const clone = response.clone();
		const text = await clone.text();
		const lower = text.toLowerCase();
		return lower.includes("rate limit") || lower.includes("secondary rate limit");
	} catch {
		return false;
	}
}
