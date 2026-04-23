import { Semaphore } from "./concurrency";

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("Semaphore", () => {
	test("defaults to max=4", () => {
		const sem = new Semaphore();
		expect(sem.getMax()).toBe(4);
	});

	test("throws on max < 1", () => {
		expect(() => new Semaphore({ max: 0 })).toThrow();
		expect(() => new Semaphore({ max: -1 })).toThrow();
	});

	test("N <= max acquires resolve immediately", async () => {
		const sem = new Semaphore({ max: 3 });
		await sem.acquire();
		await sem.acquire();
		await sem.acquire();
		expect(sem.getInFlight()).toBe(3);
		expect(sem.getQueueLength()).toBe(0);
	});

	test("extra acquires queue until release", async () => {
		const sem = new Semaphore({ max: 2 });
		await sem.acquire();
		await sem.acquire();

		// Third acquire should not resolve until a release happens.
		let thirdResolved = false;
		const third = sem.acquire().then(() => {
			thirdResolved = true;
		});

		await Promise.resolve(); // flush microtasks
		expect(thirdResolved).toBe(false);
		expect(sem.getQueueLength()).toBe(1);

		sem.release();
		await third;
		expect(thirdResolved).toBe(true);
		expect(sem.getQueueLength()).toBe(0);
	});

	test("waiters resolve in FIFO order", async () => {
		const sem = new Semaphore({ max: 1 });
		await sem.acquire();

		const order: number[] = [];
		const p1 = sem.acquire().then(() => order.push(1));
		const p2 = sem.acquire().then(() => order.push(2));
		const p3 = sem.acquire().then(() => order.push(3));

		sem.release();
		await p1;
		sem.release();
		await p2;
		sem.release();
		await p3;

		expect(order).toEqual([1, 2, 3]);
	});

	test("release clamps at 0 (no negative in-flight)", () => {
		const sem = new Semaphore({ max: 2 });
		sem.release();
		sem.release();
		sem.release();
		expect(sem.getInFlight()).toBe(0);
	});

	test("run() acquires + releases around fn", async () => {
		const sem = new Semaphore({ max: 1 });
		const { promise, resolve } = deferred<string>();

		const p = sem.run(async () => {
			expect(sem.getInFlight()).toBe(1);
			return promise;
		});

		await Promise.resolve();
		expect(sem.getInFlight()).toBe(1);

		resolve("done");
		await expect(p).resolves.toBe("done");
		expect(sem.getInFlight()).toBe(0);
	});

	test("run() releases the slot even when fn throws", async () => {
		const sem = new Semaphore({ max: 1 });

		await expect(
			sem.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(sem.getInFlight()).toBe(0);
		// Next run should acquire immediately.
		await sem.run(async () => undefined);
		expect(sem.getInFlight()).toBe(0);
	});

	test("long queue drains as work completes", async () => {
		const sem = new Semaphore({ max: 2 });
		let completed = 0;

		const tasks = Array.from({ length: 10 }, () =>
			sem.run(async () => {
				await Promise.resolve();
				completed += 1;
			}),
		);

		await Promise.all(tasks);
		expect(completed).toBe(10);
		expect(sem.getInFlight()).toBe(0);
		expect(sem.getQueueLength()).toBe(0);
	});
});
