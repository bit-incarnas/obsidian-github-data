import { RateLimitTracker } from "./rate-limit";

describe("RateLimitTracker", () => {
	test("snapshot is null before any record()", () => {
		const t = new RateLimitTracker();
		expect(t.getSnapshot()).toBeNull();
		expect(t.remainingRatio()).toBeNull();
		expect(t.isLow()).toBe(false);
		expect(t.msUntilReset()).toBe(0);
	});

	test("records rate-limit headers (object shape)", () => {
		const t = new RateLimitTracker({ now: () => 1_000_000 });
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "4987",
			"x-ratelimit-reset": "1234567890",
			"x-ratelimit-used": "13",
			"x-ratelimit-resource": "core",
		});

		const snap = t.getSnapshot();
		expect(snap).toEqual({
			limit: 5000,
			remaining: 4987,
			reset: 1234567890,
			used: 13,
			resource: "core",
			observedAt: 1_000_000,
		});
	});

	test("records from a Headers instance", () => {
		const t = new RateLimitTracker();
		const h = new Headers();
		h.set("X-RateLimit-Limit", "5000");
		h.set("X-RateLimit-Remaining", "100");
		h.set("X-RateLimit-Reset", "200");
		t.record(h);

		const snap = t.getSnapshot();
		expect(snap?.limit).toBe(5000);
		expect(snap?.remaining).toBe(100);
		expect(snap?.reset).toBe(200);
	});

	test("case-insensitive header reads", () => {
		const t = new RateLimitTracker();
		t.record({
			"X-RateLimit-Limit": "100",
			"X-RateLimit-Remaining": "50",
			"X-RateLimit-Reset": "999",
		});

		const snap = t.getSnapshot();
		expect(snap?.limit).toBe(100);
		expect(snap?.remaining).toBe(50);
	});

	test("derives `used` when header is missing", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "1000",
			"x-ratelimit-remaining": "750",
			"x-ratelimit-reset": "0",
		});
		// used not in headers -> derived as limit - remaining
		expect(t.getSnapshot()?.used).toBe(250);
	});

	test("defaults resource to `core` when header is missing", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "1000",
			"x-ratelimit-remaining": "1000",
			"x-ratelimit-reset": "0",
		});
		expect(t.getSnapshot()?.resource).toBe("core");
	});

	test("ignores responses with no rate-limit headers", () => {
		const t = new RateLimitTracker();
		t.record({ "content-type": "application/json" });
		expect(t.getSnapshot()).toBeNull();
	});

	test("ignores partial headers (requires limit + remaining + reset)", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "1000",
			"x-ratelimit-remaining": "500",
			// reset missing
		});
		expect(t.getSnapshot()).toBeNull();
	});

	test("non-numeric header values are treated as missing", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "not-a-number",
			"x-ratelimit-remaining": "500",
			"x-ratelimit-reset": "1000",
		});
		expect(t.getSnapshot()).toBeNull();
	});

	test("remainingRatio() is remaining/limit", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "1000",
			"x-ratelimit-remaining": "250",
			"x-ratelimit-reset": "0",
		});
		expect(t.remainingRatio()).toBeCloseTo(0.25);
	});

	test("isLow() returns true when remaining < watermark (default 500)", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "499",
			"x-ratelimit-reset": "0",
		});
		expect(t.isLow()).toBe(true);
	});

	test("isLow() returns false when remaining >= watermark", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "500",
			"x-ratelimit-reset": "0",
		});
		expect(t.isLow()).toBe(false);
	});

	test("isLow() honors a custom lowWatermark", () => {
		const t = new RateLimitTracker({ lowWatermark: 1000 });
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "800",
			"x-ratelimit-reset": "0",
		});
		expect(t.isLow()).toBe(true);
	});

	test("msUntilReset() returns ms from injected-now to reset", () => {
		const t = new RateLimitTracker({ now: () => 1_000_000_000_000 });
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "1000",
			"x-ratelimit-reset": "1000000060", // 60s after the injected now in epoch seconds
		});
		expect(t.msUntilReset()).toBe(60 * 1000);
	});

	test("msUntilReset() returns 0 when reset is in the past", () => {
		const t = new RateLimitTracker({ now: () => 1_000_000_000_000 });
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "1000",
			"x-ratelimit-reset": "1", // ancient
		});
		expect(t.msUntilReset()).toBe(0);
	});

	test("clear() resets to empty state", () => {
		const t = new RateLimitTracker();
		t.record({
			"x-ratelimit-limit": "5000",
			"x-ratelimit-remaining": "100",
			"x-ratelimit-reset": "0",
		});
		t.clear();
		expect(t.getSnapshot()).toBeNull();
		expect(t.isLow()).toBe(false);
	});
});
