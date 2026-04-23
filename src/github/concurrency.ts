/**
 * Concurrency cap (semaphore) for GitHub requests.
 *
 * Security review H5 specifies max 4 in-flight requests to stay within
 * GitHub's secondary rate-limit guidance. A plugin-wide singleton keeps
 * all writers + ad-hoc calls within one shared budget.
 *
 * FIFO queueing: callers waiting on a slot are released in the order
 * they called `acquire()`. `run(fn)` is the preferred API -- it pairs
 * acquire/release via try/finally so slots never leak on throw.
 */

export interface SemaphoreOptions {
	/** Maximum in-flight holders. Default 4 per security review. */
	max?: number;
}

export class Semaphore {
	private readonly max: number;
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(options: SemaphoreOptions = {}) {
		const max = options.max ?? 4;
		if (max < 1) throw new Error(`Semaphore max must be >= 1 (got ${max})`);
		this.max = max;
	}

	/**
	 * Acquire a slot. Resolves immediately if a slot is free; otherwise
	 * resolves when a slot is released.
	 */
	async acquire(): Promise<void> {
		if (this.inFlight < this.max) {
			this.inFlight += 1;
			return;
		}
		return new Promise((resolve) => {
			this.waiters.push(() => {
				this.inFlight += 1;
				resolve();
			});
		});
	}

	/**
	 * Release a slot. Safe to over-release (clamps at 0). Wakes the
	 * next waiter in FIFO order.
	 */
	release(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		const next = this.waiters.shift();
		if (next) next();
	}

	/**
	 * Preferred API: run `fn` inside an acquire/release pair. Exceptions
	 * still release the slot.
	 */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	getInFlight(): number {
		return this.inFlight;
	}

	getQueueLength(): number {
		return this.waiters.length;
	}

	getMax(): number {
		return this.max;
	}
}
