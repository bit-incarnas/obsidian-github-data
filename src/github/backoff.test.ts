import { computeBackoff, sleep } from "./backoff";

describe("computeBackoff", () => {
	test("attempt 0 is base + jitter", () => {
		const ms = computeBackoff(0, {
			baseMs: 1000,
			jitterMs: 2000,
			random: () => 0.5,
		});
		expect(ms).toBe(1000 + 0.5 * 2000);
	});

	test("doubles each attempt (exponential)", () => {
		const opts = { baseMs: 1000, jitterMs: 0, random: () => 0 };
		expect(computeBackoff(0, opts)).toBe(1000);
		expect(computeBackoff(1, opts)).toBe(2000);
		expect(computeBackoff(2, opts)).toBe(4000);
		expect(computeBackoff(3, opts)).toBe(8000);
	});

	test("caps at capMs", () => {
		const ms = computeBackoff(20, {
			baseMs: 1000,
			capMs: 10_000,
			jitterMs: 0,
			random: () => 0,
		});
		expect(ms).toBe(10_000);
	});

	test("defaults cap to 1hr", () => {
		const ms = computeBackoff(100, { jitterMs: 0, random: () => 0 });
		expect(ms).toBe(3_600_000);
	});

	test("jitter uses injected random", () => {
		const ms = computeBackoff(0, {
			baseMs: 100,
			jitterMs: 1000,
			random: () => 0.25,
		});
		expect(ms).toBe(100 + 250);
	});

	test("negative attempt clamps to 0", () => {
		const ms = computeBackoff(-5, {
			baseMs: 1000,
			jitterMs: 0,
			random: () => 0,
		});
		expect(ms).toBe(1000);
	});

	test("non-integer attempt floors", () => {
		const ms = computeBackoff(2.9, {
			baseMs: 1000,
			jitterMs: 0,
			random: () => 0,
		});
		expect(ms).toBe(4000); // floor(2.9) = 2
	});

	test("attempt=40 stays bounded (no Infinity)", () => {
		const ms = computeBackoff(40, {
			baseMs: 1000,
			capMs: 10_000,
			jitterMs: 0,
			random: () => 0,
		});
		expect(ms).toBe(10_000);
		expect(Number.isFinite(ms)).toBe(true);
	});
});

describe("sleep", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("resolves after the specified ms", async () => {
		const promise = sleep(500);
		let resolved = false;
		promise.then(() => {
			resolved = true;
		});

		await jest.advanceTimersByTimeAsync(499);
		expect(resolved).toBe(false);

		await jest.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(true);
	});

	test("resolves immediately for ms <= 0", async () => {
		const start = Date.now();
		await sleep(0);
		await sleep(-100);
		// No timers advanced -> the promise resolved synchronously.
		expect(Date.now()).toBe(start);
	});
});
