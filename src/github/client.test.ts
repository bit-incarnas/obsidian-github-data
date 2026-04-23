/**
 * @jest-environment node
 */
import { RequestError } from "@octokit/request-error";
import { createGithubClient } from "./client";
import type { HttpFn } from "./http";

function mockHttp(
	impl: (args: Parameters<HttpFn>[0]) => ReturnType<HttpFn>,
): jest.MockedFunction<HttpFn> {
	return jest.fn(impl) as jest.MockedFunction<HttpFn>;
}

function okJson(data: unknown, extraHeaders: Record<string, string> = {}) {
	return {
		status: 200,
		headers: { "content-type": "application/json", ...extraHeaders },
		json: data,
		text: JSON.stringify(data),
		arrayBuffer: new ArrayBuffer(0),
	};
}

/**
 * Default options for tests: no-op sleep so retry paths are instant, and
 * the backoff table is deterministic. Fresh rate-limit state per client
 * via omission (createGithubClient constructs defaults).
 */
const fastOpts = {
	sleep: async () => undefined,
	backoff: { random: () => 0, baseMs: 1, jitterMs: 0 },
};

describe("createGithubClient -- request.fetch bridge", () => {
	test("returns parsed JSON data for a successful REST call", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "bit-incarnas", id: 42 }) as never,
		);
		const client = createGithubClient({
			token: "test-token",
			httpFn: http,
			...fastOpts,
		});

		const res = await client.rest.users.getAuthenticated();

		expect(res.status).toBe(200);
		expect(res.data.login).toBe("bit-incarnas");
		expect(http).toHaveBeenCalledTimes(1);
	});

	test("includes Authorization header with the provided token", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "bit-incarnas" }) as never,
		);
		const client = createGithubClient({
			token: "mytoken",
			httpFn: http,
			...fastOpts,
		});

		await client.rest.users.getAuthenticated();

		const call = http.mock.calls[0][0];
		const headers = call.headers ?? {};
		const authKey = Object.keys(headers).find(
			(k) => k.toLowerCase() === "authorization",
		);
		expect(authKey).toBeDefined();
		// @octokit/auth-token uses `token <pat>` by default; accepts `Bearer` too.
		// GitHub accepts both; we don't pin the format.
		expect(String(headers[authKey!])).toMatch(/^(token|Bearer) mytoken$/);
	});

	test("resolves relative URLs against api.github.com", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "bit-incarnas" }) as never,
		);
		const client = createGithubClient({ token: "t", httpFn: http, ...fastOpts });

		await client.rest.users.getAuthenticated();

		const call = http.mock.calls[0][0];
		expect(call.url).toBe("https://api.github.com/user");
	});

	test("includes custom user-agent", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "x" }) as never,
		);
		const client = createGithubClient({
			token: "t",
			userAgent: "test-ua/1.0",
			httpFn: http,
			...fastOpts,
		});

		await client.rest.users.getAuthenticated();

		const call = http.mock.calls[0][0];
		const headers = call.headers ?? {};
		const uaKey = Object.keys(headers).find(
			(k) => k.toLowerCase() === "user-agent",
		);
		expect(uaKey).toBeDefined();
		expect(String(headers[uaKey!])).toMatch(/test-ua\/1\.0/);
	});

	test("throws RequestError on 404", async () => {
		const http = mockHttp(async () => ({
			status: 404,
			headers: { "content-type": "application/json" },
			json: { message: "Not Found" },
			text: '{"message":"Not Found"}',
			arrayBuffer: new ArrayBuffer(0),
		}) as never);
		const client = createGithubClient({ token: "t", httpFn: http, ...fastOpts });

		await expect(
			client.rest.repos.get({ owner: "does-not-exist", repo: "nope" }),
		).rejects.toBeInstanceOf(RequestError);
		// 404 is not retried -- single call.
		expect(http).toHaveBeenCalledTimes(1);
	});

	test("throws RequestError with correct status on 401 (after one retry)", async () => {
		const http = mockHttp(async () => ({
			status: 401,
			headers: { "content-type": "application/json" },
			json: { message: "Bad credentials" },
			text: '{"message":"Bad credentials"}',
			arrayBuffer: new ArrayBuffer(0),
		}) as never);
		const client = createGithubClient({ token: "bad", httpFn: http, ...fastOpts });

		try {
			await client.rest.users.getAuthenticated();
			fail("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RequestError);
			expect((err as RequestError).status).toBe(401);
		}
		// Wrapper retries once on first 401 (design: "retry once with a fresh
		// connection"), then propagates the second 401.
		expect(http).toHaveBeenCalledTimes(2);
	});

	test("maps transport-level status 0 to an explicit throw after retries", async () => {
		const http = mockHttp(async () => ({
			status: 0,
			headers: {},
			text: "",
			json: null,
			arrayBuffer: new ArrayBuffer(0),
		}) as never);
		const client = createGithubClient({
			token: "t",
			httpFn: http,
			maxRetries: 2,
			...fastOpts,
		});

		await expect(
			client.rest.users.getAuthenticated(),
		).rejects.toBeInstanceOf(RequestError);
		// Initial + 2 retries = 3 attempts before the TypeError propagates.
		expect(http).toHaveBeenCalledTimes(3);
	});

	test("rate-limit headers are normalized to lowercase in response", async () => {
		const http = mockHttp(async () => ({
			status: 200,
			headers: {
				"content-type": "application/json",
				"X-RateLimit-Remaining": "4998",
				"X-RateLimit-Reset": "1234567890",
			},
			json: {
				resources: {},
				rate: { limit: 5000, remaining: 4998, reset: 1234567890, used: 2 },
			},
			text: "{}",
			arrayBuffer: new ArrayBuffer(0),
		}) as never);
		const client = createGithubClient({ token: "t", httpFn: http, ...fastOpts });

		const res = await client.rest.rateLimit.get();

		expect(res.status).toBe(200);
		// Headers must be lowercased so downstream code reads them reliably.
		expect(res.headers["x-ratelimit-remaining"]).toBe("4998");
	});

	test("paginate plugin is wired (pagination helper available)", () => {
		const http = mockHttp(async () =>
			okJson({ login: "x" }) as never,
		);
		const client = createGithubClient({ token: "t", httpFn: http, ...fastOpts });
		expect(typeof client.paginate).toBe("function");
	});
});

describe("createGithubClient -- rate-limit integration", () => {
	test("shared RateLimitTracker records headers from every call", async () => {
		const { RateLimitTracker } = await import("./rate-limit");
		const rateLimit = new RateLimitTracker();

		const http = mockHttp(async () => ({
			status: 200,
			headers: {
				"content-type": "application/json",
				"x-ratelimit-limit": "5000",
				"x-ratelimit-remaining": "4900",
				"x-ratelimit-reset": "1000",
			},
			json: { login: "x" },
			text: '{"login":"x"}',
			arrayBuffer: new ArrayBuffer(0),
		}) as never);

		const client = createGithubClient({
			token: "t",
			httpFn: http,
			rateLimit,
			...fastOpts,
		});
		await client.rest.users.getAuthenticated();

		expect(rateLimit.getSnapshot()?.remaining).toBe(4900);
	});

	test("shared CircuitBreaker trips after two 401s", async () => {
		const { CircuitBreaker } = await import("./circuit-breaker");
		const circuit = new CircuitBreaker();

		const http = mockHttp(async () => ({
			status: 401,
			headers: {},
			json: { message: "bad" },
			text: '{"message":"bad"}',
			arrayBuffer: new ArrayBuffer(0),
		}) as never);

		const client = createGithubClient({
			token: "bad",
			httpFn: http,
			circuit,
			...fastOpts,
		});

		await expect(client.rest.users.getAuthenticated()).rejects.toBeDefined();
		expect(circuit.isOpen()).toBe(true);
	});

	test("open circuit blocks subsequent calls without hitting HTTP", async () => {
		const { CircuitBreaker } = await import("./circuit-breaker");
		const circuit = new CircuitBreaker();
		circuit.open("preset lockout");

		const http = mockHttp(async () =>
			okJson({ login: "x" }) as never,
		);

		const client = createGithubClient({
			token: "t",
			httpFn: http,
			circuit,
			...fastOpts,
		});

		await expect(client.rest.users.getAuthenticated()).rejects.toBeDefined();
		expect(http).toHaveBeenCalledTimes(0);
	});
});
