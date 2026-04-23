/**
 * @jest-environment node
 */
import {
	hasSsoRequired,
	is403RateLimit,
	parseRetryAfter,
	wrapWithRateLimit,
} from "./fetch-wrapper";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";
import { RateLimitTracker } from "./rate-limit";
import { Semaphore } from "./concurrency";

function makeResponse(
	status: number,
	opts: {
		body?: string;
		headers?: Record<string, string>;
	} = {},
): Response {
	const body = opts.body ?? "";
	const headers = new Headers(opts.headers);
	return new Response(body, { status, headers });
}

interface FetchFixture {
	fetch: typeof fetch;
	deps: Parameters<typeof wrapWithRateLimit>[0];
	inner: jest.MockedFunction<typeof fetch>;
	sleep: jest.MockedFunction<(ms: number) => Promise<void>>;
	rateLimit: RateLimitTracker;
	circuit: CircuitBreaker;
	concurrency: Semaphore;
}

function setup(
	innerImpl: (i: number) => Response | Promise<Response>,
	overrides: Partial<Parameters<typeof wrapWithRateLimit>[0]> = {},
): FetchFixture {
	let callIdx = 0;
	const inner = jest.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const r = innerImpl(callIdx);
			callIdx += 1;
			return Promise.resolve(r);
		},
	) as jest.MockedFunction<typeof fetch>;

	const sleep = jest.fn(async (_ms: number) => undefined) as jest.MockedFunction<
		(ms: number) => Promise<void>
	>;
	const rateLimit = new RateLimitTracker();
	const circuit = new CircuitBreaker();
	const concurrency = new Semaphore({ max: 4 });

	const deps: Parameters<typeof wrapWithRateLimit>[0] = {
		inner,
		rateLimit,
		circuit,
		concurrency,
		sleep,
		backoff: { random: () => 0, baseMs: 100, jitterMs: 0 },
		maxRetries: 3,
		...overrides,
	};
	const fetchFn = wrapWithRateLimit(deps);
	return { fetch: fetchFn, deps, inner, sleep, rateLimit, circuit, concurrency };
}

describe("wrapWithRateLimit -- happy path", () => {
	test("passes 200 through without retry", async () => {
		const { fetch: f, inner } = setup(() =>
			makeResponse(200, { body: "{}", headers: { "content-type": "application/json" } }),
		);
		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	test("records rate-limit headers on every response", async () => {
		const { fetch: f, rateLimit } = setup(() =>
			makeResponse(200, {
				body: "{}",
				headers: {
					"x-ratelimit-limit": "5000",
					"x-ratelimit-remaining": "4999",
					"x-ratelimit-reset": "1000",
				},
			}),
		);
		await f("https://api.github.com/user");
		expect(rateLimit.getSnapshot()?.remaining).toBe(4999);
	});

	test("success clears the circuit's 401 counter", async () => {
		const { fetch: f, circuit } = setup(() => makeResponse(200));
		circuit.record401(); // count=1
		expect(circuit.getConsecutiveFailures()).toBe(1);

		await f("https://api.github.com/user");
		expect(circuit.getConsecutiveFailures()).toBe(0);
	});
});

describe("wrapWithRateLimit -- 401 handling", () => {
	test("first 401 retries; success on retry returns 200", async () => {
		const responses = [
			makeResponse(401, { body: '{"message":"bad"}' }),
			makeResponse(200, { body: "{}" }),
		];
		const { fetch: f, inner, circuit } = setup((i) => responses[i]);

		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(2);
		// counter advanced to 1 but cleared by subsequent success
		expect(circuit.getConsecutiveFailures()).toBe(0);
		expect(circuit.isOpen()).toBe(false);
	});

	test("second consecutive 401 opens circuit and propagates the 401", async () => {
		const { fetch: f, inner, circuit } = setup(() => makeResponse(401));

		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(401);
		expect(inner).toHaveBeenCalledTimes(2); // first + retry
		expect(circuit.isOpen()).toBe(true);
		expect(circuit.getReason()).toContain("401");
	});

	test("subsequent call with open circuit throws CircuitOpenError", async () => {
		const { fetch: f, inner } = setup(() => makeResponse(401));
		await f("https://api.github.com/user");
		// Circuit now open. Next call must throw without firing inner.
		inner.mockClear();
		await expect(f("https://api.github.com/user")).rejects.toBeInstanceOf(
			CircuitOpenError,
		);
		expect(inner).toHaveBeenCalledTimes(0);
	});
});

describe("wrapWithRateLimit -- 403 handling", () => {
	test("403 with SSO header opens circuit immediately (no retry)", async () => {
		const { fetch: f, inner, circuit } = setup(() =>
			makeResponse(403, {
				headers: { "x-github-sso": "required; url=https://example" },
				body: "{}",
			}),
		);

		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(403);
		expect(inner).toHaveBeenCalledTimes(1);
		expect(circuit.isOpen()).toBe(true);
		expect(circuit.getReason()).toMatch(/SSO/);
	});

	test("403 rate-limit (X-RateLimit-Remaining: 0) retries after reset", async () => {
		const responses = [
			makeResponse(403, {
				headers: {
					"x-ratelimit-limit": "5000",
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 10),
				},
				body: "API rate limit exceeded",
			}),
			makeResponse(200, { body: "{}" }),
		];
		const { fetch: f, inner, sleep } = setup((i) => responses[i]);

		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalled();
	});

	test("403 rate-limit via body text when header is absent", async () => {
		const responses = [
			makeResponse(403, { body: "You have exceeded a secondary rate limit" }),
			makeResponse(200, { body: "{}" }),
		];
		const { fetch: f, inner } = setup((i) => responses[i]);

		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(2);
	});

	test("non-SSO non-rate-limit 403 propagates without retry", async () => {
		const { fetch: f, inner, circuit } = setup(() =>
			makeResponse(403, { body: "Resource not accessible by personal access token" }),
		);

		const res = await f("https://api.github.com/user");
		expect(res.status).toBe(403);
		expect(inner).toHaveBeenCalledTimes(1);
		expect(circuit.isOpen()).toBe(false);
	});
});

describe("wrapWithRateLimit -- 429 handling", () => {
	test("429 sleeps Retry-After then retries", async () => {
		const responses = [
			makeResponse(429, { headers: { "retry-after": "7" } }),
			makeResponse(200, { body: "{}" }),
		];
		const { fetch: f, inner, sleep } = setup((i) => responses[i]);

		const res = await f("https://api.github.com/x");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(2);
		// 7s retry-after should dominate the 100ms backoff
		const sleptMs = sleep.mock.calls[0][0];
		expect(sleptMs).toBeGreaterThanOrEqual(7000);
	});

	test("429 exhausts retries and propagates the last response", async () => {
		const { fetch: f, inner } = setup(() =>
			makeResponse(429, { headers: { "retry-after": "1" } }),
		);

		const res = await f("https://api.github.com/x");
		expect(res.status).toBe(429);
		// initial + maxRetries=3 retries = 4 calls
		expect(inner).toHaveBeenCalledTimes(4);
	});
});

describe("wrapWithRateLimit -- 5xx handling", () => {
	test("5xx retries with exponential backoff", async () => {
		const responses = [
			makeResponse(503),
			makeResponse(502),
			makeResponse(200, { body: "{}" }),
		];
		const { fetch: f, inner, sleep } = setup((i) => responses[i]);

		const res = await f("https://api.github.com/x");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(3);
		// Exponential (100, 200) with 0 jitter
		expect(sleep.mock.calls[0][0]).toBe(100);
		expect(sleep.mock.calls[1][0]).toBe(200);
	});

	test("5xx exhausts retries and propagates final response", async () => {
		const { fetch: f, inner } = setup(() => makeResponse(500));

		const res = await f("https://api.github.com/x");
		expect(res.status).toBe(500);
		expect(inner).toHaveBeenCalledTimes(4);
	});
});

describe("wrapWithRateLimit -- transport failures", () => {
	test("TypeError from inner retries with backoff", async () => {
		let calls = 0;
		const inner = jest.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => {
				calls += 1;
				if (calls < 3) throw new TypeError("network unreachable");
				return makeResponse(200);
			},
		) as jest.MockedFunction<typeof fetch>;

		const sleep = jest.fn(async (_ms: number) => undefined) as jest.MockedFunction<
			(ms: number) => Promise<void>
		>;
		const fetchFn = wrapWithRateLimit({
			inner,
			rateLimit: new RateLimitTracker(),
			circuit: new CircuitBreaker(),
			concurrency: new Semaphore(),
			sleep,
			backoff: { random: () => 0, baseMs: 10, jitterMs: 0 },
			maxRetries: 3,
		});

		const res = await fetchFn("https://api.github.com/x");
		expect(res.status).toBe(200);
		expect(inner).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	test("TypeError exhausts retries and throws", async () => {
		const inner = jest.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => {
				throw new TypeError("down");
			},
		) as jest.MockedFunction<typeof fetch>;

		const fetchFn = wrapWithRateLimit({
			inner,
			rateLimit: new RateLimitTracker(),
			circuit: new CircuitBreaker(),
			concurrency: new Semaphore(),
			sleep: async () => undefined,
			backoff: { random: () => 0, baseMs: 1, jitterMs: 0 },
			maxRetries: 2,
		});

		await expect(fetchFn("https://api.github.com/x")).rejects.toBeInstanceOf(
			TypeError,
		);
		expect(inner).toHaveBeenCalledTimes(3); // initial + 2 retries
	});

	test("non-TypeError exceptions do not retry", async () => {
		const inner = jest.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => {
				throw new Error("bug in inner");
			},
		) as jest.MockedFunction<typeof fetch>;

		const fetchFn = wrapWithRateLimit({
			inner,
			rateLimit: new RateLimitTracker(),
			circuit: new CircuitBreaker(),
			concurrency: new Semaphore(),
			sleep: async () => undefined,
			maxRetries: 5,
		});

		await expect(fetchFn("https://api.github.com/x")).rejects.toThrow("bug in inner");
		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe("wrapWithRateLimit -- circuit pre-flight", () => {
	test("open circuit throws immediately without firing inner", async () => {
		const { fetch: f, inner, circuit } = setup(() => makeResponse(200));
		circuit.open("pre-existing lockout");

		await expect(f("https://api.github.com/user")).rejects.toBeInstanceOf(
			CircuitOpenError,
		);
		expect(inner).toHaveBeenCalledTimes(0);
	});

	test("CircuitOpenError carries the reason", async () => {
		const { fetch: f, circuit } = setup(() => makeResponse(200));
		circuit.open("tripped manually");

		try {
			await f("https://api.github.com/user");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CircuitOpenError);
			expect((err as CircuitOpenError).reason).toBe("tripped manually");
		}
	});
});

describe("wrapWithRateLimit -- concurrency", () => {
	test("respects semaphore cap (max=2) across overlapping requests", async () => {
		const sem = new Semaphore({ max: 2 });
		let active = 0;
		let peak = 0;
		const inner = jest.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => {
				active += 1;
				peak = Math.max(peak, active);
				await Promise.resolve();
				active -= 1;
				return makeResponse(200);
			},
		) as jest.MockedFunction<typeof fetch>;

		const fetchFn = wrapWithRateLimit({
			inner,
			rateLimit: new RateLimitTracker(),
			circuit: new CircuitBreaker(),
			concurrency: sem,
			sleep: async () => undefined,
			maxRetries: 0,
		});

		await Promise.all(
			Array.from({ length: 10 }, () => fetchFn("https://api.github.com/x")),
		);
		expect(peak).toBeLessThanOrEqual(2);
		expect(inner).toHaveBeenCalledTimes(10);
	});
});

describe("parseRetryAfter", () => {
	test("returns integer seconds when header is numeric", () => {
		const h = new Headers({ "retry-after": "42" });
		expect(parseRetryAfter(h)).toBe(42);
	});

	test("parses HTTP-date format", () => {
		const future = new Date(Date.now() + 30_000).toUTCString();
		const h = new Headers({ "retry-after": future });
		expect(parseRetryAfter(h)).toBeGreaterThanOrEqual(28);
		expect(parseRetryAfter(h)).toBeLessThanOrEqual(31);
	});

	test("returns 0 when header is missing", () => {
		expect(parseRetryAfter(new Headers())).toBe(0);
	});

	test("returns 0 on unparseable header", () => {
		const h = new Headers({ "retry-after": "nonsense" });
		expect(parseRetryAfter(h)).toBe(0);
	});
});

describe("hasSsoRequired", () => {
	test("detects required-variant SSO header", () => {
		const h = new Headers({ "x-github-sso": "required; url=https://x" });
		expect(hasSsoRequired(h)).toBe(true);
	});

	test("false when header absent", () => {
		expect(hasSsoRequired(new Headers())).toBe(false);
	});

	test("false on non-required SSO header variants", () => {
		const h = new Headers({ "x-github-sso": "partial-results" });
		expect(hasSsoRequired(h)).toBe(false);
	});

	test("case-insensitive on value", () => {
		const h = new Headers({ "x-github-sso": "REQUIRED; url=x" });
		expect(hasSsoRequired(h)).toBe(true);
	});
});

describe("is403RateLimit", () => {
	test("true when X-RateLimit-Remaining is 0", async () => {
		const r = makeResponse(403, { headers: { "x-ratelimit-remaining": "0" } });
		expect(await is403RateLimit(r)).toBe(true);
	});

	test("true when body contains 'rate limit'", async () => {
		const r = makeResponse(403, { body: "API rate limit exceeded for user." });
		expect(await is403RateLimit(r)).toBe(true);
	});

	test("true when body mentions secondary rate limit", async () => {
		const r = makeResponse(403, { body: "You have exceeded a secondary rate limit." });
		expect(await is403RateLimit(r)).toBe(true);
	});

	test("false when neither signal present", async () => {
		const r = makeResponse(403, {
			body: "Resource not accessible by personal access token",
		});
		expect(await is403RateLimit(r)).toBe(false);
	});

	test("cloning leaves original body consumable", async () => {
		const r = makeResponse(403, { body: "rate limit" });
		await is403RateLimit(r);
		// Original body should still be readable by downstream consumers.
		expect(await r.text()).toBe("rate limit");
	});
});
