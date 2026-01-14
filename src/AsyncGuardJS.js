export class AsyncGuardJS extends Error {
    constructor(message, meta = {}) {
        super(message);

        this.name = "AsyncGuardJS";
        Object.assign(this, meta);
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
    */

    static _has_performance = typeof performance !== "undefined" && typeof performance.now === "function";

    static async run(task, options = {}) {
        if (typeof task !== "function") {
            throw new TypeError("[!] [AsyncGuardJS] Task Must Be A Function !");
        }

        const retries = Math.max(0, Math.min(50, Number(options.retries) || 0));
        const timeout = Math.max(0, Number(options.timeout) || 0);
        const max_backoff = Math.max(0, Number(options.max_backoff) || 5000);

        const {
            retry_if = () => true,
            backoff = (attempt) => Math.min(5000, 100 * 2 ** (attempt - 1)),
            signal,
            circuit_breaker,
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

            if (this._is_circuit_open(circuit_breaker)) {
                throw new AsyncGuardJS(
                    "[!] [AsyncGuardJS] Circuit Breaker Is 'OPEN' | Too Many Recent Failures.",
                    { circuit_state: "OPEN", attempt: 0 }
                );
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

                promise.then(
                    (value) => {
                        if (!settled) {
                            settled = true;
                            signal.removeEventListener("abort", abort_listener);
                            resolve(value);
                        }
                    },

                    (error) => {
                        if (!settled) {
                            settled = true;
                            signal.removeEventListener("abort", abort_listener);
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
                        should_retry = Boolean(await Promise.race([
                            retry_if(error, context),

                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error("'retry_if' Timeout")), 5000)
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
                        }
                    }

                    throw wrapped_error;
                }

                this._inc("asyncguardjs.retry", { attempt });

                let base_delay = 0;

                try {
                    base_delay = Number(backoff(attempt)) || 0;

                    if (!isFinite(base_delay) || base_delay < 0) {
                        base_delay = 100 * 2 ** (attempt - 1);
                    }
                } catch {
                    base_delay = 100 * 2 ** (attempt - 1); // Fallback !!
                }

                const delay = Math.min(max_backoff, jitter(base_delay));

                if (delay > 0) {
                    await wait_with_abort(delay, context);
                }
            }
        }
    }

    static _circuits = new Map();

    static _metrics = {
        counters: new Map(),
        timers: new Map()
    };

    static _inc(name, labels = {}) {
        const key = this._get_metric_key(name, labels);

        this._metrics.counters.set(
            key,
            (this._metrics.counters.get(key) || 0) + 1
        );
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

    static _observe(name, value, labels = {}) {
        const key = this._get_metric_key(name, labels);
        let arr = this._metrics.timers.get(key);

        if (!arr) {
            arr = [];
            this._metrics.timers.set(key, arr);
        }

        arr.push(value);

        while (arr.length > this._max_timer_values) {
            arr.shift();
        }
    }

    static _get_circuit_key(configuration) {
        return configuration.name || "__default__";
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
        const now = Date.now();
        const threshold = configuration.threshold || 5;
        const window = configuration.window || 60000;

        let circuit = this._circuits.get(key);

        if (!circuit) {
            circuit = { failures: [], state: "CLOSED", opened_at: null };
            this._circuits.set(key, circuit);
        }

        circuit.failures.push(now);
        circuit.failures = circuit.failures.filter(time => now - time < window);

        if (circuit.failures.length >= threshold && circuit.state === "CLOSED") {
            circuit.state = "OPEN";
            circuit.opened_at = now;

            this._inc("asyncguardjs.circuit.open", {
                name: configuration.name || "__default__"
            });
        }
    }

    /**
     * @param {string} [name="__default__"] Circuit Breaker Name
    */

    static reset_circuit(name = "__default__") {
        this._circuits.delete(name);
    }

    /**
     * Get Circuit Braeker Status
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
        return {
            counters: Object.fromEntries(this._metrics.counters),
            timers: Object.fromEntries(
                Array.from(this._metrics.timers.entries())
                    .map(([key, values]) => [key, [...values]])
            )
        };
    }

    /**
     * @experimental
     * Reset all AsyncGuardJS metrics (counters & timers).
    */

    static reset_metrics() {
        this._metrics.counters.clear();
        this._metrics.timers.clear();
    }
}

export default AsyncGuardJS;