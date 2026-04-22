/**
 * GitHub API client built on `@octokit/core` + REST endpoint methods + paginate.
 *
 * Integrates with Obsidian's network layer via `octokit.hook.wrap("request", ...)`
 * rather than a `request.fetch` swap. The hook operates above the fetch layer,
 * so we return Octokit's expected `{data, status, headers, url}` shape directly
 * -- no need to forge a `Response` object. This avoids the impedance gap that
 * breaks binary uploads and GraphQL responses with a naive `customFetch`.
 *
 * Octokit v7 ships without a default auth plugin, so we set the `Authorization`
 * header directly inside the wrap. This keeps the dep footprint smaller and
 * makes the auth path fully explicit / auditable (matches the Security
 * Invariants requirement to disclose every outbound request header).
 *
 * Non-2xx responses are mapped to `@octokit/request-error#RequestError` so
 * Octokit consumers behave normally.
 *
 * Design invariants (from 01_DESIGN.md Security Invariants -- HTTP layer):
 * - `@octokit/core` + plugins, not the meta `octokit` package.
 * - `hook.wrap("request", ...)`, not `request.fetch` swap.
 * - `status === 0` maps to an explicit throw.
 * - HTTP dependency is injectable (`HttpFn`) for integration testability.
 */

import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { RequestError } from "@octokit/request-error";

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

const DEFAULT_BASE_URL = "https://api.github.com";

export function createGithubClient(
	options: CreateGithubClientOptions,
): GithubClient {
	const http: HttpFn = options.httpFn ?? defaultHttpFn;
	const token = options.token;
	const userAgent = options.userAgent ?? "obsidian-github-data";

	const octokit = new GithubOctokit({ userAgent });

	octokit.hook.wrap("request", async (_defaultRequest, requestOptions) => {
		const url = resolveUrl(requestOptions);
		const method = (requestOptions.method ?? "GET").toUpperCase();
		const headers = normalizeHeaders(requestOptions.headers);
		// Octokit v7 has no default auth plugin; set the header explicitly.
		// GitHub accepts `Bearer <pat>` for fine-grained PATs; also works for
		// classic PATs. The fine-grained path is what v0.1 documents.
		headers.authorization = `Bearer ${token}`;
		const body = serializeBody(requestOptions.body);

		const response = await http({
			url,
			method,
			headers,
			body,
			throw: false,
		});

		// Capacitor / native-transport failure -- never let Octokit see 0 OK.
		if (response.status === 0) {
			throw new RequestError(
				"Network request failed (status 0)",
				500,
				{ request: requestOptions },
			);
		}

		const responseHeaders = normalizeResponseHeaders(response.headers);
		const data = extractData(response, responseHeaders);

		if (response.status >= 400) {
			throw new RequestError(
				deriveErrorMessage(data, response.status),
				response.status,
				{
					request: requestOptions,
					response: {
						data,
						status: response.status,
						headers: responseHeaders,
						url,
					},
				},
			);
		}

		return {
			data,
			status: response.status,
			headers: responseHeaders,
			url,
		};
	});

	return octokit;
}

function resolveUrl(requestOptions: {
	url: string;
	baseUrl?: string;
}): string {
	const { url } = requestOptions;
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return url;
	}
	const base = (requestOptions.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const path = url.startsWith("/") ? url : `/${url}`;
	return `${base}${path}`;
}

function normalizeHeaders(
	headers: Record<string, string | number | undefined> | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	for (const [k, v] of Object.entries(headers)) {
		if (v !== undefined && v !== null) {
			out[k] = String(v);
		}
	}
	return out;
}

function normalizeResponseHeaders(
	headers: unknown,
): Record<string, string> {
	if (!headers || typeof headers !== "object") return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
		if (v !== undefined && v !== null) {
			out[k.toLowerCase()] = String(v);
		}
	}
	return out;
}

function serializeBody(body: unknown): string | ArrayBuffer | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return body;
	if (body instanceof Uint8Array) {
		return body.buffer.slice(
			body.byteOffset,
			body.byteOffset + body.byteLength,
		) as ArrayBuffer;
	}
	return JSON.stringify(body);
}

function extractData(
	response: {
		status: number;
		json?: unknown;
		text?: string;
	},
	headers: Record<string, string>,
): unknown {
	// 204 No Content / 205 Reset Content -- no body
	if (response.status === 204 || response.status === 205) return undefined;

	const contentType = headers["content-type"] ?? "";
	if (contentType.includes("application/json")) {
		return response.json ?? null;
	}
	return response.text ?? response.json ?? null;
}

function deriveErrorMessage(data: unknown, status: number): string {
	if (typeof data === "string" && data.length > 0) return data;
	if (data && typeof data === "object") {
		const msg = (data as { message?: unknown }).message;
		if (typeof msg === "string" && msg.length > 0) return msg;
		try {
			return JSON.stringify(data);
		} catch {
			// fall through
		}
	}
	return `HTTP ${status}`;
}
