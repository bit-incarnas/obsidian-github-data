/**
 * GitHub API client built on `@octokit/core` + REST endpoint methods + paginate.
 *
 * Integrates with Obsidian's network layer via Octokit's `request.fetch`
 * override. Octokit's own `fetchWrapper` handles URL template expansion,
 * query-string construction, body serialization, header defaults, auth
 * injection (via the `@octokit/auth-token` plugin), and response parsing.
 * Our custom fetch just needs to receive the fully-resolved request and
 * return a Response-like object.
 *
 * Why not `hook.wrap("request", ...)` (the original approach)?
 *
 * `hook.wrap` receives options AFTER `endpoint.merge` but BEFORE
 * `endpoint.parse`. Bypassing the default request (as `hook.wrap` permits)
 * means URL template expansion never runs -- direct calls like
 * `client.rest.repos.get({owner, repo})` would send the literal template
 * `/repos/{owner}/{repo}` to the server and 404. Paginated calls happened
 * to work because `paginateRest.iterator` explicitly calls
 * `route.endpoint(parameters)` first, resolving the URL before the hook
 * chain fires.
 *
 * `request.fetch` is the canonical integration point -- everything below
 * the fetchWrapper boundary is the HTTP transport, which is exactly what
 * we need to replace.
 *
 * Design invariants (from 01_DESIGN.md Security Invariants -- HTTP layer):
 * - `@octokit/core` + plugins, not the meta `octokit` package.
 * - Auth via `auth: token` option, so `@octokit/auth-token` injects the
 *   `Authorization` header through Octokit's standard flow.
 * - `status === 0` (Capacitor / native-transport failure) maps to an
 *   explicit throw so Octokit never sees a "0 OK".
 * - HTTP dependency is injectable (`HttpFn`) for integration testability.
 */

import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

import { defaultHttpFn, type HttpFn } from "./http";

const GithubOctokit = Octokit.plugin(paginateRest, restEndpointMethods);

export type GithubClient = InstanceType<typeof GithubOctokit>;

export interface CreateGithubClientOptions {
	token: string;
	userAgent?: string;
	/**
	 * Injected HTTP function. Defaults to Obsidian's `requestUrl`.
	 * Tests swap in a Node-fetch adapter to hit real GitHub from Node.
	 */
	httpFn?: HttpFn;
}

export function createGithubClient(
	options: CreateGithubClientOptions,
): GithubClient {
	const http: HttpFn = options.httpFn ?? defaultHttpFn;
	const userAgent = options.userAgent ?? "obsidian-github-data";

	return new GithubOctokit({
		auth: options.token,
		userAgent,
		request: {
			fetch: createRequestUrlFetch(http),
		},
	});
}

/**
 * Build a `fetch`-compatible function that routes every call through the
 * provided `HttpFn`. Octokit's fetchWrapper calls this with a fully-
 * resolved URL, fully-composed headers, and a serialized body.
 */
function createRequestUrlFetch(http: HttpFn): typeof fetch {
	return (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		const method = (init?.method ?? "GET").toUpperCase();
		const headers = normalizeInitHeaders(init?.headers);
		const body = normalizeBody(init?.body);

		const response = await http({
			url,
			method,
			headers,
			body,
			throw: false,
		});

		// Capacitor / native-transport failure -- never let Octokit see 0 OK.
		if (response.status === 0) {
			throw new TypeError(`Network request failed: ${method} ${url}`);
		}

		return toResponse(response, url);
	}) as typeof fetch;
}

function normalizeInitHeaders(
	h: HeadersInit | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!h) return out;
	if (h instanceof Headers) {
		h.forEach((v, k) => {
			out[k] = v;
		});
	} else if (Array.isArray(h)) {
		for (const [k, v] of h) out[k] = v;
	} else {
		for (const [k, v] of Object.entries(h as Record<string, string>)) {
			if (v !== undefined && v !== null) out[k] = String(v);
		}
	}
	return out;
}

function normalizeBody(
	body: BodyInit | null | undefined,
): string | ArrayBuffer | undefined {
	if (body == null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return body;
	if (body instanceof Uint8Array) {
		return body.buffer.slice(
			body.byteOffset,
			body.byteOffset + body.byteLength,
		) as ArrayBuffer;
	}
	// FormData / Blob / ReadableStream: out of scope for this client.
	return undefined;
}

function toResponse(
	response: {
		status: number;
		headers: unknown;
		text?: string;
		json?: unknown;
		arrayBuffer?: ArrayBuffer;
	},
	url: string,
): Response {
	const headers = new Headers();
	for (const [k, v] of Object.entries(
		(response.headers ?? {}) as Record<string, unknown>,
	)) {
		if (v === undefined || v === null) continue;
		headers.set(k, String(v));
	}

	// Prefer arrayBuffer (preserves binary); fall back to text -> encode.
	let body: BodyInit | null;
	if (response.arrayBuffer && response.arrayBuffer.byteLength > 0) {
		body = response.arrayBuffer;
	} else if (typeof response.text === "string" && response.text.length > 0) {
		body = response.text;
	} else if (response.status === 204 || response.status === 205) {
		body = null;
	} else {
		body = "";
	}

	// `new Response` is standard in Electron renderer + modern Node.
	const resp = new Response(body as BodyInit | null, {
		status: response.status,
		statusText: statusTextFor(response.status),
		headers,
	});
	// Response.url is read-only; Octokit reads it for paginate link parsing.
	Object.defineProperty(resp, "url", { value: url, writable: false });
	return resp;
}

function statusTextFor(status: number): string {
	const map: Record<number, string> = {
		200: "OK",
		201: "Created",
		202: "Accepted",
		204: "No Content",
		205: "Reset Content",
		301: "Moved Permanently",
		302: "Found",
		304: "Not Modified",
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		409: "Conflict",
		410: "Gone",
		422: "Unprocessable Entity",
		429: "Too Many Requests",
		500: "Internal Server Error",
		502: "Bad Gateway",
		503: "Service Unavailable",
		504: "Gateway Timeout",
	};
	return map[status] ?? "";
}
