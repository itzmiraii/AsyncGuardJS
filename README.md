# async-guard-js

[![NPM](https://nodei.co/npm/async-guard-js.svg?style=flat-square&data=n,v,u,d,s)](https://nodei.co/npm/async-guard-js/)

A dependency-free utility to run async functions with retries, timeouts, cancellation,
rate limiting, circuit breakers, fallbacks & lightweight metrics.

---

## Installation

```bash
npm install async-guard-js@latest
```

---

## Basic Usage

```js
import AsyncGuardJS from "async-guard-js";

const result = await AsyncGuardJS.run(
    async ({ attempt, signal, timeout }) => {
        return fetch("api-url", { signal });
    },

    {
        retries: 3,
        timeout: 2000
    }
);
```

---

## Retry & Timeout

```js
AsyncGuardJS.run(task, {
    retries: 5,
    timeout: 3000,

    retry_if: (error, context) => {
        return error instanceof NetworkError && context.attempt < 3;
    },

    backoff: (attempt) => attempt * 200,
    max_backoff: 2000
});
```

> Retries are bounded.
> Timeouts are enforced per attempt.
> Backoff supports jitter and hard caps.
> `retry_if` may be async and is itself time-bounded.

---

## AbortSignal Support

```js
const controller = new AbortController();

AsyncGuardJS.run(task,  {
    signal: controller.signal
});
```

Abort signals are respected across retries & timeouts.

---

## Circuit Breaker

```js
AsyncGuardJS.run(task, {
    circuit_breaker: {
        name: "external-api",
        threshold: 5,
        window: 10000,
        recovery: 5000
    }
});
```

**Circuit states:**
> `CLOSED` ~ Normal operation.
> `OPEN` ~ Requests fail immediatly.
> `HALF_OPEN` ~ Limited test execution after recovery.

### Circuit Status

```js
const status = AsyncGuardJS.get_circuit_status("external-api");
```

**Returns:**

```js
{
    state: "CLOSED" | "OPEN" | "HALF_OPEN",
    failures: number,
    opened_at: number | null
}
```

Reset manually if needed

```js
AsyncGuardJS.reset_circuit("external-api");
```

---

## Rate Limiting

AsyncGuardJS provides an in-memory sliding-window rate limiter.

```js
AsyncGuardJS.run(task, {
    rate_limit: {
        name: "api",
        max_requests: 10,
        window_ms: 1000,
        queue: true
    }
});
```

**Behavior:**
> Requests are tracked in a sliding time window.
> If `queue` is `false` (default), execution fails immediatly when the limit is reached.
> If `queue` is `true`, execution waits until a slot becomes available.

NOTE: Queueing is **time-based**, not FIFO.

### Rate Limit Status

```js
const status = AsyncGuardJS.get_rate_limit_status("api");
```

**Returns:**

```js
{
    current_requests: number,
    oldest_request: number | null,
    time_until_oldest_expires: number,
    is_full: boolean
}
```

**Reset manually:**

```js
AsyncGuardJS.reset_rate_limit("api");
```

---

## Fallbacks

```js
AsyncGuardJS.run(task, {
    fallback: () => "default value"
});
```

**Behavior:**
> If all attempts fail, the fallback is executed.
> If the fallback succeeds, it's value is returned.
> If the fallback fails, AsyncGuardJS throws an error containing:
    > The original error$
    > The fallback error
    > Execution context metadata

---

## Metrics **(EXPERIMENTAL)**

AsyncGuardJS collects lightweight, in-memory metrics by default.

> Metrics are process-local.
> Nothing is exported or persisted automatically.
> Metrics are only exposed when requested.

```js
const metrics = AsyncGuardJS.get_metrics();
```

**Returns:**

```js
{
    counters: Record<string, number>,

    timers: Record<string, {
        count: number,
        min: number,
        max: number,
        avg: number,
        p50: number,
        p95: number,
        p99: number
    }>
}
```

**Reset metrics:**

```js
AsyncGuardJS.reset_metrics();
```

---

## TypeScript Support

AsyncGuardJS ships with first-class TypeScript definitions (`.d.ts`) included in the package.
Public types includes:

> `AttemptContext`
> `AsyncGuardOptions<T>`
> `CircuitBreakerConfig`
> `CircuitStatus`
> `MetricsSnapshot`

No additional configurations is required.

### Example Usage

```ts
import AsyncGuardJS, { AttemptContext, AsyncGuardOptions } from "async-guard-js";

type User = { id: number; name: string };

const fetch_user = async ({ attempt, signal }: AttemptContext): Promise<user> => {
    console.log(`Attempt: #${attempt}`);

    const response = await fetch("api-url", { signal });

    if (!response.ok) {
        throw new Error("Failed To Fetch.");
    }

    return response.json();
};

const options: AsyncGuardOptions<user> = {
    retries: 3,
    timeout: 5000,
    backoff: attempt => 200 * attempt,
    fallback: { id: 0, name: "Fallback" }
};

console.log(await AsyncGuardJS.run(fetch_user, options));
```

---

## Notes & Limitations

> Circuit breakers, rate limiters, and metrics are **in-memory** & **process-local**.
> This library does not coordinate state across multiple processes or servers.
> No dependencies.
