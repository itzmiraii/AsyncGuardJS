/**
 * 15/01/2026
 * 
 * Made By ItzMiMi (DC: 844900332303024128)
*/

export class AsyncGuardJS extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = "AsyncGuardJS";

        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
            const safe_keys = Object.keys(meta).filter(key =>
                key !== "__proto__" &&
                key !== "constructor" &&
                key !== "prototype"
            );

            for (const key of safe_keys) {
                this[key] = meta[key];
            }
        }
    }

    /**
     * @template T
     * @param {(context: { attempt: number, signal?: AbortSignal, timeout: number }) => Promise<T>} task The Async Function tO Run.
     * @param {Object} [options]
     * @param {number} [options.retries=0] Number Of Retry Attempts.
     * @param {number} [options.timeout=0] Timeout Per Attempt In Milliseconds (0 : No Timeout).
     * @param {(error: any, context: { attempt: number, signal?: AbortSignal, timeout: number }) => boolean | Promise<boolean>} [options.retry_if] Function To Decide If Retry Should Occur.
     * @param {(attempt: number) => number} [options.backoff] Function To Compute Backoff Delay Between Retries.
     * @param {number} [options.max_backoff=5000] Maximum Backoff Delay In Milliseconds.
     * @param {AbortSignal} [options.signal] External AbortSignal To Cancel The Operation.
     * @param {() => T | Promise<T>} [options.fallback] Fallback Value/Function When All Retries Fail
     * 
     * @param {Object} [options.circuit_breaker] Circuit Breaker Config.
     * @param {string} [options.circuit_breaker.name] Unique Name For Circuit (Default: "__default__").
     * @param {number} [options.circuit_breaker.threshold=5] Failures Before Opening Circuit.
     * @param {number} [options.circuit_breaker.window=60000] Time Window For Failure Tracking (MS).
     * @param {number} [options.circuit_breaker.recovery=30000] Time To Wait Before Attempting Recovery (MS).
     * 
     * @param {Object} [options.rate_limit] Rate Limiter Config.
     * @param {String} [options.rate_limit.name] Unique Name For Rate Limiter (Default: "__default__").
     * @param {number} [options.rate_limit.max_requests] Max Requests Allowed In Window.
     * @param {number} [options.rate_limit.window_ms] Time Window For Rate Limiting (MS).
     * @param {number} [options.rate_limit.queue=false] Queue Requests When Limit Hit (Default: Throw Error).
     * @param {number} [options.rate_limit.queue_max_wait_ms=30000] Max MS To Wait In Queue Before Throwing (Prevents Hangs).
     * 
     * Note: Queuing Uses Time-Based Waiting + Jitter To Reduce Thundering Herd.
    */

    static _has_performance = typeof performance !== "undefined" && typeof performance.now === "function";
    static _active_operations = 0;
    static _max_concurrent_operations = 100;

    static async run(task, options = {}) {
        if (typeof task !== "function") {
            throw new TypeError("[!] [AsyncGuardJS] Task Must Be A Function !");
        }

        if (this._active_operations >= this._max_concurrent_operations) {
            throw new AsyncGuardJS(
                "[!] [AsyncGuardJS] Maximum Concurrent Operations Exceeded.",
                { active_operations: this._active_operations }
            );
        }

        this._active_operations++;

        const parse_safe_number = (value, fallback, min = 0, max = Infinity) => {
            const num = Number(value);

            if (!Number.isFinite(num) || num < min || num > max) {
                return fallback;
            }

            return Math.floor(num);
        }

        try {
            const retries = parse_safe_number(options.retries, 0, 0, 50);
            const timeout = parse_safe_number(options.timeout, 0, 0, 300000);
            const max_backoff = parse_safe_number(options.max_backoff, 5000, 0, 60000);

            const {
                retry_if = () => true,
                backoff = (attempt) => Math.min(5000, 100 * 2 ** (attempt - 1)),
                signal,
                circuit_breaker,
                rate_limit,
                fallback
            } = options;

            if (typeof backoff !== "function") {
                throw new TypeError("[!] [AsyncGuardJS] Backoff Must Be A Function !");
            }

            if (circuit_breaker) {
                if (typeof circuit_breaker !== "object") {
                    throw new TypeError("[!] [AsyncGuardJS] Circuit Breaker Configuration Must Be An Object !");
                }

                if (circuit_breaker.threshold !== undefined &&
                    (!Number.isInteger(circuit_breaker.threshold) || circuit_breaker.threshold < 1)) {
                    throw new TypeError("[!] [AsyncGuardJS] Circuit Breaker Threshold Must Be A Positive Integer !");
                }

                if (circuit_breaker.window !== undefined &&
                    (!Number.isInteger(circuit_breaker.window) || circuit_breaker.window < 1000)) {
                    throw new TypeError("[!] [AsyncGuardJS] Circuit Breaker Window Must Be At Least 1000MS !");
                }

                if (circuit_breaker.recovery !== undefined &&
                    (!Number.isInteger(circuit_breaker.recovery) || circuit_breaker.recovery < 1000)) {
                    throw new TypeError("[!] [AsyncGuardJS] Circuit Breaker Recovery Must Be At Least 1000MS !");
                }

                if (this._is_circuit_open(circuit_breaker)) {
                    throw new AsyncGuardJS(
                        "[!] [AsyncGuardJS] Circuit Breaker Is 'OPEN' | Too Many Recent Failures.",
                        { circuit_state: "OPEN", attempt: 0 }
                    );
                }
            }

            if (rate_limit) {
                if (typeof rate_limit !== "object") {
                    throw new TypeError("[!] [AsyncGuardJS] Rate Limit Configuration Must Be An Object !");
                }

                if (!Number.isInteger(rate_limit.max_requests) || rate_limit.max_requests < 1) {
                    throw new TypeError("[!] [AsyncGuardJS] Rate Limit 'max_requests' Must Be A Positive Integer !");
                }

                if (!Number.isInteger(rate_limit.window_ms) || rate_limit.window_ms < 1) {
                    throw new TypeError("[!] [AsyncGuardJS] Rate Limit 'window_ms' Must Be A Positive Integer !");
                }

                while (true) {
                    if (this._can_proceed_rate_limit(rate_limit)) {
                        this._register_rate_limit_request(rate_limit);
                        break;
                    }

                    await this._wait_for_rate_limit(rate_limit, signal);
                }
            }

            const wait_with_abort = (ms, context) => {
                return new Promise((resolve, reject) => {
                    const { signal, attempt } = context;

                    if (signal?.aborted) {
                        return reject(
                            new AsyncGuardJS(
                                "[!] [AsyncGuardJS] Operation Aborted During Backoff.",
                                { attempt }
                            )
                        );
                    }

                    const timeout_id = setTimeout(resolve, ms);

                    if (signal) {
                        const abort_listener = () => {
                            clearTimeout(timeout_id);

                            reject(
                                new AsyncGuardJS(
                                    "[!] [AsyncGuardJS] Operation Aborted During Backoff.",
                                    { attempt }
                                )
                            );
                        };

                        signal.addEventListener("abort", abort_listener, { once: true });
                    }
                });
            };

            const enforce_abort = (promise, signal, attempt) => {
                if (!signal) {
                    return promise;
                }

                if (signal.aborted) {
                    return Promise.reject(
                        new AsyncGuardJS(
                            "[!] [AsyncGuardJS] Task Started After Abort.",
                            { attempt }
                        )
                    );
                }

                return new Promise((resolve, reject) => {
                    let settled = false;
                    const controller = new AbortController();

                    const abort_listener = () => {
                        if (!settled) {
                            settled = true;

                            reject(
                                new AsyncGuardJS(
                                    "[!] [AsyncGuardJS] Operation Aborted During Task Execution",
                                    { attempt }
                                )
                            );
                        }
                    };

                    signal.addEventListener("abort", abort_listener, { once: true });

                    const timeout = setTimeout(() => {
                        if (!settled) {
                            signal.removeEventListener("abort", abort_listener);
                        }
                    }, 300000);

                    promise.then(
                        (value) => {
                            if (!settled) {
                                settled = true;
                                clearTimeout(timeout);
                                resolve(value);
                            }
                        },

                        (error) => {
                            if (!settled) {
                                settled = true;
                                clearTimeout(timeout);
                                reject(error);
                            }
                        }
                    );
                });
            };

            const merge_signals = (a, b) => {
                if (!a && !b) {
                    return undefined;
                }

                if (!a) {
                    return b;
                }

                if (!b) {
                    return a;
                }

                if (AbortSignal.any) {
                    return AbortSignal.any([a, b]);
                }

                const controller = new AbortController();

                const abort = (signal) => {
                    if (controller.signal.aborted) {
                        return;
                    }

                    controller.abort(signal.reason);
                };

                a.addEventListener("abort", () => abort(a), { once: true });
                b.addEventListener("abort", () => abort(b), { once: true });

                return controller.signal;
            }

            const jitter = (ms) => ms * (0.8 + Math.random() * 0.4);
            const max_attempts = Math.min(retries + 1, 51);
            const is_dev = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

            for (let attempt = 1; attempt <= max_attempts; attempt++) {
                this._inc("asyncguardjs.attempt", { attempt });

                if (signal?.aborted) {
                    throw new AsyncGuardJS(
                        "[!] [AsyncGuardJS] Operation Aborted Before Start",
                        { attempt: 0 }
                    );
                }

                const timeout_controller = timeout ? new AbortController() : null;
                let timeout_id = null;

                if (timeout_controller) {
                    timeout_id = setTimeout(() => {
                        timeout_controller.abort(
                            new Error(`[!] [AsyncGuardJS] Operation Timed Out After '${timeout}' MS.`)
                        );
                    }, timeout);
                }

                const combined_signal = merge_signals(signal, timeout_controller?.signal);

                const context = Object.freeze({
                    attempt,
                    signal: combined_signal,
                    timeout
                });

                try {
                    const start = this._has_performance ? performance.now() : Date.now();

                    const result = await enforce_abort(
                        task(context),
                        combined_signal,
                        attempt
                    );

                    if (timeout_id) {
                        clearTimeout(timeout_id);
                    }

                    if (circuit_breaker) {
                        this._record_success(circuit_breaker);
                    }

                    if (this._has_performance) {
                        this._observe(
                            "asyncguardjs.task.duration_ms",
                            performance.now() - start,
                            { attempt }
                        );
                    } else {
                        this._observe(
                            "asyncguardjs.task.duration_ms",
                            Date.now() - start,
                            { attempt }
                        );
                    }

                    return result;
                } catch (error) {
                    if (timeout_id) {
                        clearTimeout(timeout_id);
                    }

                    this._inc("asyncguardjs.failure", {
                        attempt,
                        aborted: Boolean(combined_signal?.aborted)
                    });

                    const is_aborted = combined_signal?.aborted; // Est-ce que l'opération a été annulée ?
                    const is_last_attempt = attempt >= max_attempts;
                    let should_retry = false;

                    if (!is_aborted && !is_last_attempt) {
                        try {
                            const retry_if_timeout = parse_safe_number(options.retry_if_timeout, 5000, 100, 30000);
                            const _jittered_timeout = retry_if_timeout * (0.9 + Math.random() * 0.2);

                            should_retry = Boolean(await Promise.race([
                                retry_if(error, context),

                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error("'retry_if' Timeout")), _jittered_timeout)
                                )
                            ]));
                        } catch {
                            should_retry = false;
                        }
                    }

                    if (is_aborted || is_last_attempt || !should_retry) {
                        let message = error?.message || "Async Failure";

                        if (is_aborted) {
                            const reason = combined_signal.reason;

                            if (reason instanceof Error) {
                                message = reason.message;
                            } else if (reason) {
                                message = String(reason);
                            } else {
                                message = "[!] [AsyncGuardJS] Operation Aborted";
                            }
                        }

                        const wrapped_error = new AsyncGuardJS(message, {
                            cause: error,
                            context,
                            attempt
                        });

                        if (is_dev && !(error instanceof AsyncGuardJS) && error instanceof Error && error.stack) {
                            wrapped_error.stack += `\nCaused By:\n${error.stack}`;
                        }

                        if (circuit_breaker) {
                            this._record_failure(circuit_breaker);
                        }

                        if (fallback) {
                            try {
                                const fallback_result = typeof fallback === "function"
                                    ? await fallback()
                                    : fallback;

                                this._inc("asyncguardjs.fallback.used", {
                                    reason: is_aborted ? "aborted" : "exhausted"
                                });

                                return fallback_result;
                            } catch (fallback_error) {
                                this._inc("asyncguardjs.fallback.failed", {});

                                const final_error = new AsyncGuardJS(
                                    "[!] [AsyncGuardJS] Fallback Failed After Exhausting All Retries",
                                    {
                                        cause: fallback_error,
                                        original_error: wrapped_error,
                                        fallback_error,
                                        attempt,
                                        context
                                    }
                                );

                                if (is_dev) {
                                    if (wrapped_error?.stack) {
                                        final_error.stack += `\n\n[Original Task Error]\n${wrapped_error.stack}`;
                                    }

                                    if (fallback_error?.stack) {
                                        final_error.stack += `\n\n[Fallback Error]\n${fallback_error.stack}`;
                                    }
                                }

                                throw final_error;
                            }
                        }

                        throw wrapped_error;
                    }

                    this._inc("asyncguardjs.retry", { attempt });

                    let base_delay = 0;

                    try {
                        base_delay = Number(backoff(attempt)) || 0;

                        if (!isFinite(base_delay) || base_delay < 0) {
                            base_delay = Math.min(max_backoff, 100 * Math.pow(2, Math.min(attempt - 1, 10)));
                        }
                    } catch {
                        base_delay = Math.min(max_backoff, 100 * Math.pow(2, Math.min(attempt - 1, 10))); // Fallback !!
                    }

                    const delay = Math.min(max_backoff, jitter(base_delay));

                    if (delay > 0) {
                        await wait_with_abort(delay, context);
                    }
                }
            }
        } finally {
            this._active_operations--;
        }
    }

    static _circuits = new Map();
    static _rate_limiters = new Map();

    static _max_circuits = 1000;
    static _max_rate_limiters = 1000;
    static _max_metric_keys = 2000;

    static _circuit_access_order = [];

    static _maybe_cleanup_circuits() {
        if (this._circuits.size >= this._max_circuits) {
            const lru_key = this._circuit_access_order.shift();

            if (lru_key) {
                this._circuits.delete(lru_key);
                this._inc("asyncguardjs.circuit.evicted", { name: lru_key });
            }
        }
    }

    static _metrics = {
        counters: new Map(),
        timers: new Map()
    };

    static _get_rate_limit_key(configuration) {
        const name = this._sanitize_name(configuration.name);
        const key = name || "__default__";

        const index = this._rate_limiter_access_order.indexOf(key);

        if (index !== -1) {
            this._rate_limiter_access_order.splice(index, 1);
        }

        this._rate_limiter_access_order.push(key);
        return key;
    }

    static _rate_limiter_access_order = [];

    static _maybe_cleanup_rate_limiters() {
        if (this._rate_limiters.size >= this._max_rate_limiters) {
            const lru_key = this._rate_limiter_access_order.shift();

            if (lru_key) {
                this._rate_limiters.delete(lru_key);
                this._inc("asyncguardjs.ratelimit.evicted", { name: lru_key });
            }
        }
    }

    static _can_proceed_rate_limit(configuration) {
        const key = this._get_rate_limit_key(configuration);
        const now = Date.now();
        const window_ms = configuration.window_ms || 1000;

        this._maybe_cleanup_rate_limiters();

        let limiter = this._rate_limiters.get(key);

        if (!limiter) {
            limiter = {
                requests: [],

                configuration: {
                    max_requests: configuration.max_requests,
                    window_ms: configuration.window_ms
                }
            };

            this._rate_limiters.set(key, limiter);
        }

        const cutoff = now - window_ms;

        limiter.requests = limiter.requests.filter(timestamp => timestamp >= cutoff);
        const max_requests = configuration.max_requests || 10;

        if (limiter.requests.length >= max_requests) {
            this._inc("asyncguardjs.ratelimit.hit", {
                name: configuration.name || "__default__"
            });

            return false;
        }

        return true;
    }

    static _register_rate_limit_request(configuration) {
        const key = this._get_rate_limit_key(configuration);
        const now = Date.now();
        let limiter = this._rate_limiters.get(key);

        if (!limiter) {
            limiter = { requests: [] };
            this._rate_limiters.set(key, limiter);
        }

        limiter.requests.push(now);
    }

    static _jittered_delay(base_ms) {
        const spread = base_ms * (0.7 + Math.random() * 0.6);
        const extra_stagger = Math.random() * 200;

        return Math.round(spread + extra_stagger);
    }

    static async _wait_for_rate_limit(configuration, signal) {
        if (!configuration.queue) {
            throw new AsyncGuardJS(
                "[!] [AsyncGuardJS] Rate Limit Exceeded",
                { rate_limit: true }
            );
        }

        const key = this._get_rate_limit_key(configuration);
        const limiter = this._rate_limiters.get(key);

        if (!limiter) {
            return;
        }

        const now = Date.now();
        const effective_configuration = limiter.configuration || configuration;
        const window_ms = effective_configuration.window_ms;
        let wait_ms = 0;

        if (limiter.requests.length > 0) {
            const oldest = limiter.requests[0];
            wait_ms = Math.max(0, oldest + window_ms - now);
        }

        if (wait_ms <= 0) {
            return;
        }

        const effective_wait = this._jittered_delay(wait_ms);

        this._inc("asyncguardjs.ratelimit.queued", {
            name: configuration.name || "__default__",
            original_wait_ms: wait_ms,
            effective_wait_ms: effective_wait
        });

        const max_wait = configuration.queue_max_wait_ms || 30000;

        if (effective_wait > max_wait) {
            throw new AsyncGuardJS(
                "[!] [AsyncGuardJS] Rate Limit Queue Timeout - Wait Too Long",
                { rate_limit: true, waited_ms: effective_wait }
            );
        }

        await new Promise((resolve, reject) => {
            if (signal?.aborted) {
                return reject(new AsyncGuardJS("[!] [AsyncGuardJS] Aborted While Queued.", {}));
            }

            const timeout_id = setTimeout(resolve, effective_wait);

            if (signal) {
                const abort_listener = () => {
                    clearTimeout(timeout_id);
                    reject(new AsyncGuardJS("[!] [AsyncGuardJS] Aborted While Queued.", {}));
                };

                signal.addEventListener("abort", abort_listener, { once: true });
            }
        });
    }

    /**
     * Reset rate limiter
     * @param {string} [name="__default__"]
    */

    static reset_rate_limit(name = "__default__") {
        this._rate_limiters.delete(name);
    }

    /**
     * Get rate limiter status
     * @param {string} [name="__default__"] 
     * @returns {{
     * current_requests: number,
     * capacity_remaining: number,
     * oldest_request_timestamp: number | null,
     * ms_until_next_slot: number,
     * window_ms: number,
     * is_at_limit: boolean
     * } | null}
    */

    static get_rate_limit_status(name = "__default__") {
        const limiter = this._rate_limiters.get(name);

        if (!limiter) {
            return null;
        }

        const now = Date.now();

        const { max_requests, window_ms } = limiter.configuration || {
            max_requests: 10,
            window_ms: 1000
        };

        const cutoff = now - window_ms;
        const requests = [...limiter.requests];

        while (requests.length > 0 && requests[0] < cutoff) {
            requests.shift();
        }

        const current = requests.length;
        let ms_until_next = 0;

        if (requests.length > 0) {
            ms_until_next = Math.max(0, requests[0] + window_ms - now);
        }

        return {
            current_requests: current,
            capacity_remaining: Math.max(0, max_requests - current),
            oldest_request_timestamp: requests[0] || null,
            ms_until_next_slot: ms_until_next,
            window_ms: window_ms,
            is_at_limit: current >= max_requests
        };
    }

    static _exporter = null;

    static _inc(name, labels = {}, value = 1) {
        const key = this._get_metric_key(name, labels);

        if (this._metrics.counters.size >= this._max_metric_keys) {
            const first_key = this._metrics.counters.keys().next().value;

            this._metrics.counters.delete(first_key);
        }

        this._metrics.counters.set(
            key,
            (this._metrics.counters.get(key) || 0) + value
        );

        if (this._exporter?.inc) {
            this._exporter.inc(name, labels, value);
        }
    }

    static _get_metric_key(name, labels = {}) {
        const keys = Object.keys(labels);

        if (keys.length === 0) {
            return name;
        }

        const sorted = keys.sort()
            .map(key => `${key}:${labels[key]}`)
            .join(",");

        return `${name}{${sorted}}`;
    }

    static _max_timer_values = 1000;
    static _percentiles = [0.5, 0.9, 0.95, 0.99]

    static _observe(name, value, labels = {}) {
        const key = this._get_metric_key(name, labels);

        if (this._metrics.timers.size >= this._max_metric_keys) {
            const first_key = this._metrics.timers.keys().next().value;

            this._metrics.timers.delete(first_key);
        }

        let arr = this._metrics.timers.get(key);

        if (!arr) {
            arr = [];
            this._metrics.timers.set(key, arr);
        }

        arr.push(value);

        while (arr.length > this._max_timer_values) {
            arr.shift();
        }

        if (this._exporter?.observe) {
            this._exporter.observe(name, labels, value);
        }
    }

    static _parse_metric_key(key) {
        const match = key.match(/^([^'{]+)(?:\{(.+)\})?$/);

        if (!match) {
            return { name: key, labels: {} };
        }

        const [, name, label_str] = match;
        const labels = {};

        if (label_str) {
            label_str.split(",").forEach(part => {
                const [k, v] = part.split(":");
                labels[k] = v;
            });
        }

        return { name, labels };
    }

    static _compute_timer_stats(values) {
        if (values.length === 0) {
            return { count: 0, sum: 0, min: 0, max: 0, mean: 0, percentiles: {} };
        }

        const sorted = [...values].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        const min = sorted[0];
        const max = sorted[count - 1];
        const mean = sum / count;
        const percentiles = {};

        this._percentiles.forEach(p => {
            const idx = Math.max(0, Math.min(count - 1, Math.floor(p * count)));
            const key = `p${Math.floor(p * 100)}`;

            percentiles[key] = sorted[idx];
        });

        return { count, sum, min, max, mean, percentiles };
    }

    static _sanitize_name(name) {
        if (typeof name !== "string") {
            return "__default__";
        }

        const sanitized = name.slice(0, 100);

        return sanitized.replace(/[{}:,\n\r\t]/g, "_");
    }

    static _max_access_order_size = 10000;

    static _get_circuit_key(configuration) {
        const name = this._sanitize_name(configuration.name)
        const key = name || "__default__";
        const index = this._circuit_access_order.indexOf(key);

        if (index !== -1) {
            this._circuit_access_order.splice(index, 1);
        }

        this._circuit_access_order.push(key);

        if (this._circuit_access_order.length > this._max_access_order_size) {
            this._circuit_access_order.shift();
        }

        return key;
    }

    static _is_circuit_open(configuration) {
        const key = this._get_circuit_key(configuration);
        const circuit = this._circuits.get(key);

        if (!circuit) {
            return false;
        }

        const now = Date.now();
        const recovery_time = configuration.recovery || 30000;

        if (circuit.state === "OPEN" && now - circuit.opened_at >= recovery_time) {
            circuit.state = "HALF_OPEN";
        }

        return circuit.state === "OPEN";
    }

    static _record_success(configuration) {
        const key = this._get_circuit_key(configuration);
        const circuit = this._circuits.get(key);

        if (circuit?.state === "HALF_OPEN") {
            this._inc("asyncguardjs.circuit.recovered", {
                name: configuration.name || "__default__"
            });

            this._circuits.delete(key);
        }
    }

    static _record_failure(configuration) {
        const key = this._get_circuit_key(configuration);

        this._maybe_cleanup_circuits();

        const now = Date.now();
        const threshold = configuration.threshold || 5;
        const window = configuration.window || 60000;

        let circuit = this._circuits.get(key);

        if (!circuit) {
            circuit = { failures: [], state: "CLOSED", opened_at: null };
            this._circuits.set(key, circuit);
        }

        circuit.failures.push(now);

        const cutoff = now - window;

        while (circuit.failures.length > 0 && circuit.failures[0] < cutoff) {
            circuit.failures.shift();
        }

        if (circuit.failures.length >= threshold && circuit.state === "CLOSED") {
            circuit.state = "OPEN";
            circuit.opened_at = now;

            this._inc("asyncguardjs.circuit.open", {
                name: configuration.name || "__default__"
            });
        }
    }

    /**
     * @param {string} [name="__default__"] Circuit breaker name
    */

    static reset_circuit(name = "__default__") {
        this._circuits.delete(name);
    }

    /**
     * Get circuit breaker status
     * @param {string} [name="__default__"]
     * @returns {{state: string, failures: number} | null}
    */

    static get_circuit_status(name = "__default__") {
        const circuit = this._circuits.get(name);

        if (!circuit) {
            return null;
        }

        this._inc("asyncguardjs.circuit.state", {
            name,
            state: circuit.state
        });

        return {
            state: circuit.state,
            failures: circuit.failures.length,
            opened_at: circuit.opened_at
        };
    }

    /**
     * @experimental
     * Get a snapshot of all AsyncGuardJS metrics.
     * @returns {{ counters: Record<string, number>, timers: Record<string, number[]> }}
    */

    static get_metrics() {
        if (format === "raw") {
            return {
                counters: Object.fromEntries(this._metrics.counters),
                timers: Object.fromEntries(
                    Array.from(this._metrics.timers.entries())
                        .map(([key, values]) => [key, [...values]])
                )
            };
        }

        const grouped = { counters: {}, timers: {} };

        for (const [key, value] of this._metrics.counters) {
            const { name, labels } = this._parse_metric_key(key);

            if (!grouped.counters[name]) {
                grouped.counters[name] = [];
            }

            grouped.counters[name].push({ labels, value });
        }

        for (const [key, values] of this._metrics.timers) {
            const { name, labels } = this._parse_metric_key(key);

            if (!grouped.timers[name]) {
                grouped.timers[name] = [];
            }

            const stats = this._compute_timer_stats(values);

            grouped.timers[name].push({ labels, stats });
        }

        if (format === "json") {
            return grouped;
        }

        if (format === "prometheus") {
            let output = "";

            for (const [name, entries] of Object.entries(grouped.counters)) {
                output += `# TYPE ${name} counter\n`;

                entries.forEach(({ labels, value }) => {
                    const label_str = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
                    output += `${name}{${label_str}} ${value}\n`;
                });
            }

            for (const [name, entries] of Object.entries(grouped.timers)) {
                output += `# TYPE ${name} summary\n`;

                entries.forEach(({ labels, stats }) => {
                    const label_str = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");

                    Object.entries(stats.percentiles).forEach(([p, val]) => {
                        output += `${name}{${label_str},quantile="${p.replace('p', '0.')}" } ${val}\n`;
                    });

                    output += `${name}_sum{${label_str}} ${stats.sum}\n`;
                    output += `${name}_count{${label_str}} ${stats.count}\n`;
                });
            }

            return output;
        }

        throw new Error("[!] [AsyncGuardJS] Invalid Metrics Format !");
    }

    /**
     * @experimental
     * Reset all AsyncGuardJS metrics (counters & timers).
    */

    static reset_metrics() {
        this._metrics.counters.clear();
        this._metrics.timers.clear();
    }

    /**
     * @param {{ inc?: (name: string, labels: object, value: number) => void, observe?: (name: string, labels: object, value: number) => void } | null} exporter
    */

    static set_exporter(exporter) {
        this._exporter = exporter;
    }
}

export default AsyncGuardJS;