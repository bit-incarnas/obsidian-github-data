import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";

describe("CircuitBreaker", () => {
	test("starts closed", () => {
		const cb = new CircuitBreaker();
		expect(cb.isOpen()).toBe(false);
		expect(cb.getState()).toBe("closed");
		expect(cb.getReason()).toBeNull();
		expect(cb.getConsecutiveFailures()).toBe(0);
	});

	test("one 401 does not trip (threshold=2 by default)", () => {
		const cb = new CircuitBreaker();
		cb.record401("Bad credentials");
		expect(cb.isOpen()).toBe(false);
		expect(cb.getConsecutiveFailures()).toBe(1);
	});

	test("two consecutive 401s trip the circuit", () => {
		const cb = new CircuitBreaker();
		cb.record401("Bad credentials");
		cb.record401("Bad credentials");
		expect(cb.isOpen()).toBe(true);
		expect(cb.getState()).toBe("open");
		expect(cb.getReason()).toBe("Bad credentials");
	});

	test("custom threshold", () => {
		const cb = new CircuitBreaker({ threshold: 3 });
		cb.record401();
		cb.record401();
		expect(cb.isOpen()).toBe(false);
		cb.record401();
		expect(cb.isOpen()).toBe(true);
	});

	test("recordSuccess resets the counter", () => {
		const cb = new CircuitBreaker();
		cb.record401();
		expect(cb.getConsecutiveFailures()).toBe(1);
		cb.recordSuccess();
		expect(cb.getConsecutiveFailures()).toBe(0);
		cb.record401();
		expect(cb.isOpen()).toBe(false);
	});

	test("recordSuccess does not close an already-open circuit", () => {
		const cb = new CircuitBreaker();
		cb.open("manual open");
		cb.recordSuccess();
		expect(cb.isOpen()).toBe(true);
		expect(cb.getReason()).toBe("manual open");
	});

	test("record401 on an open circuit is a no-op (counter frozen)", () => {
		const cb = new CircuitBreaker();
		cb.record401("first");
		cb.record401("second"); // trips
		expect(cb.getConsecutiveFailures()).toBe(2);
		cb.record401("third"); // no-op
		expect(cb.getConsecutiveFailures()).toBe(2);
		expect(cb.getReason()).toBe("second");
	});

	test("open() trips immediately with the given reason", () => {
		const cb = new CircuitBreaker();
		cb.open("SAML SSO required");
		expect(cb.isOpen()).toBe(true);
		expect(cb.getReason()).toBe("SAML SSO required");
	});

	test("reset() restores closed state and clears reason", () => {
		const cb = new CircuitBreaker();
		cb.open("tripped");
		cb.reset();
		expect(cb.isOpen()).toBe(false);
		expect(cb.getReason()).toBeNull();
		expect(cb.getConsecutiveFailures()).toBe(0);
	});
});

describe("CircuitOpenError", () => {
	test("name and reason are preserved", () => {
		const err = new CircuitOpenError("Bad credentials (2x)");
		expect(err.name).toBe("CircuitOpenError");
		expect(err.reason).toBe("Bad credentials (2x)");
		expect(err.message).toContain("Bad credentials (2x)");
	});

	test("is throwable and catchable by instanceof", () => {
		try {
			throw new CircuitOpenError("test");
		} catch (e) {
			expect(e).toBeInstanceOf(CircuitOpenError);
			expect(e).toBeInstanceOf(Error);
		}
	});
});
