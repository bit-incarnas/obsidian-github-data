/**
 * Node-fetch-backed adapter matching the `HttpFn` contract.
 *
 * Used by integration tests to hit real GitHub from Node without a full
 * Obsidian host. NOT shipped as part of the plugin bundle.
 */

import type { HttpFn } from "../../src/github/http";

export const nodeHttpFn: HttpFn = async (params) => {
	let body: BodyInit | undefined;
	if (typeof params.body === "string") {
		body = params.body;
	} else if (params.body instanceof ArrayBuffer) {
		body = new Uint8Array(params.body);
	}

	const res = await fetch(params.url, {
		method: params.method,
		headers: params.headers as HeadersInit,
		body,
	});

	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});

	const text = await res.text();
	let json: unknown = null;
	try {
		json = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		json = null;
	}

	const arrayBuffer = new TextEncoder().encode(text).buffer as ArrayBuffer;

	// Cast to RequestUrlResponse; the minimal set of fields Octokit consumers
	// read is `status`, `headers`, `json`, `text`, `arrayBuffer`.
	return {
		status: res.status,
		headers,
		text,
		json,
		arrayBuffer,
	} as unknown as ReturnType<HttpFn> extends Promise<infer R> ? R : never;
};
