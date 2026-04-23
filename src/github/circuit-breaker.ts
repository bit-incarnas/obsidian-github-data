/**
 * Auth-failure circuit breaker.
 *
 * Per the security-review failure-mode table:
 * - 401 once  -> retry once with a fresh connection.
 * - 401 twice -> open the circuit indefinitely. User-visible notice;
 *                preserve all synced data; prompt for new token.
 * - 403 with `x-github-sso: required` -> open immediately (SSO flow needed).
 *
 * The breaker is a tiny state machine. `isOpen()` is consulted before
 * each request; if the breaker is open, callers throw and the fetch
 * never fires. User action (re-entering a token) calls `reset()`.
 *
 * In v0.1 the reset surface is not yet wired into the settings tab --
 * users hit this by restarting Obsidian. That's acceptable for
 * pre-alpha; proper reset UX ships alongside cron.
 */

export type CircuitState = "closed" | "open";

export interface CircuitBreakerOptions {
	/** Consecutive auth-failures to trip. Default 2 per design doc. */
	threshold?: number;
}

export class CircuitBreaker {
	private state: CircuitState = "closed";
	private consecutiveFailures = 0;
	private reason: string | null = null;
	private readonly threshold: number;

	constructor(options: CircuitBreakerOptions = {}) {
		this.threshold = options.threshold ?? 2;
	}

	/**
	 * Record a 401. Increments the consecutive-failure count and opens
	 * the circuit if the threshold is reached.
	 */
	record401(reason: string = "401 Unauthorized"): void {
		if (this.state === "open") return;
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures >= this.threshold) {
			this.open(reason);
		}
	}

	/**
	 * Open the circuit immediately (e.g. 403 with SSO-required header).
	 * No threshold gating; one hit trips.
	 */
	open(reason: string): void {
		this.state = "open";
		this.reason = reason;
	}

	/**
	 * Any non-auth-failing response clears the consecutive-failure
	 * counter. Does NOT close an already-open circuit -- that requires
	 * explicit `reset()` from user action.
	 */
	recordSuccess(): void {
		if (this.state === "open") return;
		this.consecutiveFailures = 0;
	}

	/** Close the circuit. User calls this after re-entering a token. */
	reset(): void {
		this.state = "closed";
		this.consecutiveFailures = 0;
		this.reason = null;
	}

	isOpen(): boolean {
		return this.state === "open";
	}

	getState(): CircuitState {
		return this.state;
	}

	getReason(): string | null {
		return this.reason;
	}

	/** Diagnostic helper -- exposes the failure counter for tests + settings. */
	getConsecutiveFailures(): number {
		return this.consecutiveFailures;
	}
}

/**
 * Thrown by the fetch wrapper when a request is blocked by an open
 * circuit. Carries the original reason so the settings tab can render
 * an actionable notice.
 */
export class CircuitOpenError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`GitHub request blocked -- auth circuit is open: ${reason}`);
		this.name = "CircuitOpenError";
		this.reason = reason;
	}
}
