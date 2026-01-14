# Async-Guard-JS
### If there's any issues, please email me at xamenia.officialhd@gmail.com

---
[![npm version](https://img.shields.io/npm/v/async-guard-js.svg)](https://www.npmjs.com/package/async-guard-js)
[![Downloads/month](https://img.shields.io/npm/dm/async-guard-js.svg)]

Use [npm](https://www.npmjs.com/) To Install
```
npm install async-guard-js
```
---

## Quick Start
```js
import AsyncGuardJS from "./src/AsyncGuardJS.js";

const unstable_api = async({ attempt, signal }) => {
    const response = await fetch("", { signal }); // TEST API: https://thequoteshub.com/api/

    if (!response.ok) {
        throw new Error("API Error");
    }

    return response.json();
};

const result = await AsyncGuardJS.run(unstable_api, {
    retries: 3,
    timeout: 5000,
    backoff: attempt => 1000 * attempt
});

console.log(result);
```

---
## Features
- Automatic retries
- Timeout control
- Exponential backoff
- Abort support
- Circuit breaker (new)
- Context tracking
- Built-in metrics & monitoring
- Zero-dependency
- TS Support
---

## Basic Usage
Simple Retry
```js
import AsyncGuardJS from "./src/AsyncGuardJS.js";

let attempt_count = 0;

const fetch_data = async ({ signal }) => {
    attempt_count++;

    await new Promise((resolve, reject) => {
        const timeout_id = setTimeout(resolve, 500);

        signal?.addEventListener("abort", () => {
            clearTimeout(timeout_id);

            reject(
                new Error("Request Aborted")
            );
        }, { once: true });
    });

    if (attempt_count < 3) {
        throw new Error("Temp Network Issue");
    }

    return { data: "Success" };
}

try {
    const result = await AsyncGuardJS.run(fetch_data, {
        retries: 5,
        timeout: 1000,
        backoff: attempt => 200 * attempt,
        max_backoff: 1000,
        retry_if: (error) => {
            return error.message.includes("Network");
        }
    });

    console.log(result);
} catch (error) {
    console.error(error);
}
```

---
## Circuit Breaker (NEW)
Prevent hammering failling services by automatically "opening" the circuit after too many failures
```js
await AsyncGuardJS.run(call_payment_api, {
    retries: 2,
    timeout: 5000,
    
    circuit_breaker: {
        name: "payment-service",
        threshold: 5,
        window: 60000,
        recovery: 30000
    }
});

const status = AsyncGuardJS.get_circuit_status("payment-service");

console.log(status);
// { state: "OPEN", failures: 5, opened_at: 1234567890 }

// Manual Reset
AsyncGuardJS.reset_circuit("payment-service");
```
---

---
## Fallback Mechanism
Provide a graceful fallback when all retries are exhausted:
```js
// Static Fallback Value
const user = await AsyncGuardJS.run(fetch_user, {
    retries: 3,
    timeout: 2000,
    fallback: { id: null, name: "Guest" } // Returns default
});

// Fallback Function
const data = await AsyncGuardJS.run(fetch_from_api, {
    retries: 2,

    fallback: async () => {
        console.log("Primary failed, trying backup.");
        return await fetch_from_backup_api();
    }
});

// Returns Cachd Data
const latest = await AsyncGuardJS.run(fetch_latest, {
    retries: 3,
    fallback: () => get_cached_data(),
    circuit_breaker: { name: "api", threshold: 5 }
});
```

### **When is fallback used ?**
- All retries exhausted
- Circuit breaker is open
- Operation aborted
- Any terminal failure

**Fallback Metrics:**
- `asyncguardjs.fallback.used` ~ Successful fallback invocations
- `asyncguardjs.fallback.failed` ~ Fallback function threw error
---

## Metrics & Monitoring (Experimental)
AsyncGuardJS exposes lightweifht, built-in metrics to help you understand
retries, failures, latency and circuit breaker behaviors in production.
Metrics are **optional**, **dependency-free**, and **disabled by default unless read**

> **Note:** This API is experimental and may change in future versions.

### What is collected
#### Counters
- `asyncguardjs.attempt` ~ Total execution attempts
- `asyncguardjs.retry` ~ Number of retries performed
- `asyncguardjs.failure` ~ Failed attempts (including aborted execs)
- `asyncguardjs.circuit.open` ~ Circuit breaker opened events
- `asyncguardjs.circuit.recovered` ~ Circuit breaker recovery events
#### Timers
- `asyncguardjs.task.duration_ms` ~ Execution duration of successful tasks (ms)

---
### Reading Metrics
Metrics are stored in-memory and can be accessed at any time:
```js
const metrics = AsyncGuardJS.get_metrics();

console.log(metrics.counters);
/*
{
    "asyncguardjs.attempt{'attempt': 1}": 3,
    "asyncguardjs.retry{'attempt': 2}": 1,
    "asyncguardjs.failure{'attempt': 1, 'aborted': false}": 2
}
*/

console.log(metrics.timers);
/*
{
    "asyncguardjs.task.duration_ms{'attempt': 1}": [120.3, 98.7]
}
*/
```
---

---
### Reseting Metrics
```js
AsyncGuardJS.reset_metrics();
```
---

### States
- `CLOSED` ~ Normal Operation
- `OPEN` ~ Too many failures, immediate rejection
- `HALF_OPEN` ~ testing if recovered