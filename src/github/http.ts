/**
 * HTTP dependency-injection surface.
 *
 * The GitHub client calls through an `HttpFn` rather than importing
 * `requestUrl` directly. In production inside Obsidian the default wires
 * up to Obsidian's `requestUrl`; in Node-side integration tests we swap
 * in a `fetch`-backed adapter so we can hit real GitHub without needing
 * a full Obsidian host.
 *
 * Contract:
 * - Calls never throw on non-2xx (the underlying `requestUrl` uses
 *   `throw: false`). The client layer inspects `status` and raises
 *   `RequestError` itself.
 * - `status === 0` means a transport-level failure (Capacitor / network
 *   unreachable). The client maps this to an explicit throw so Octokit
 *   never sees a zero status.
 */

import {
	requestUrl as obsidianRequestUrl,
	type RequestUrlParam,
	type RequestUrlResponse,
} from "obsidian";

export type HttpFn = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

export const defaultHttpFn: HttpFn = (params) => obsidianRequestUrl(params);
