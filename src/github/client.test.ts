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

describe("createGithubClient -- hook.wrap bridge", () => {
	test("returns parsed JSON data for a successful REST call", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "bit-incarnas", id: 42 }) as never,
		);
		const client = createGithubClient({ token: "test-token", httpFn: http });

		const res = await client.rest.users.getAuthenticated();

		expect(res.status).toBe(200);
		expect(res.data.login).toBe("bit-incarnas");
		expect(http).toHaveBeenCalledTimes(1);
	});

	test("includes Authorization header with the provided token", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "bit-incarnas" }) as never,
		);
		const client = createGithubClient({ token: "mytoken", httpFn: http });

		await client.rest.users.getAuthenticated();

		const call = http.mock.calls[0][0];
		const headers = call.headers ?? {};
		const authKey = Object.keys(headers).find(
			(k) => k.toLowerCase() === "authorization",
		);
		expect(authKey).toBeDefined();
		expect(String(headers[authKey!])).toBe("Bearer mytoken");
	});

	test("resolves relative URLs against api.github.com", async () => {
		const http = mockHttp(async () =>
			okJson({ login: "bit-incarnas" }) as never,
		);
		const client = createGithubClient({ token: "t", httpFn: http });

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
		const client = createGithubClient({ token: "t", httpFn: http });

		await expect(
			client.rest.repos.get({ owner: "does-not-exist", repo: "nope" }),
		).rejects.toBeInstanceOf(RequestError);
	});

	test("throws RequestError with correct status on 401", async () => {
		const http = mockHttp(async () => ({
			status: 401,
			headers: { "content-type": "application/json" },
			json: { message: "Bad credentials" },
			text: '{"message":"Bad credentials"}',
			arrayBuffer: new ArrayBuffer(0),
		}) as never);
		const client = createGithubClient({ token: "bad", httpFn: http });

		try {
			await client.rest.users.getAuthenticated();
			fail("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RequestError);
			expect((err as RequestError).status).toBe(401);
		}
	});

	test("maps transport-level status 0 to an explicit throw", async () => {
		const http = mockHttp(async () => ({
			status: 0,
			headers: {},
			text: "",
			json: null,
			arrayBuffer: new ArrayBuffer(0),
		}) as never);
		const client = createGithubClient({ token: "t", httpFn: http });

		await expect(
			client.rest.users.getAuthenticated(),
		).rejects.toBeInstanceOf(RequestError);
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
		const client = createGithubClient({ token: "t", httpFn: http });

		const res = await client.rest.rateLimit.get();

		expect(res.status).toBe(200);
		// Headers must be lowercased so downstream code reads them reliably.
		expect(res.headers["x-ratelimit-remaining"]).toBe("4998");
	});

	test("paginate plugin is wired (pagination helper available)", () => {
		const http = mockHttp(async () =>
			okJson({ login: "x" }) as never,
		);
		const client = createGithubClient({ token: "t", httpFn: http });
		expect(typeof client.paginate).toBe("function");
	});
});
