export type AttemptContext = {
    attempt: number
    signal?: AbortSignal
    timeout: number
}

export type CircuitBreakerConfig = {
    name?: string
    threshold?: number
    window?: number
    recovery?: number
}

export type AsyncGuardOptions = {
    retries?: number
    timeout?: number
    retry_if?: (error: unknown, context: AttemptContext) => boolean | Promise<boolean>
    backoff?: (attempt: number) => number
    max_backoff?: number
    signal?: AbortSignal
    circuit_breaker?: CircuitBreakerConfig
    fallback?: T | (() => T | Promise<T>)
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export type CircuitStatus = {
    state: CircuitState
    failures: number
    opened_at: number | null
}

export type MetricLabels = Record<string, string | number | boolean>

export type TimerStats = {
    count: number,
    min: number,
    max: number,
    avg: number,
    p50: number,
    p95: number,
    p99: number
}

export type MetricsSnapshot = {
    counters: Record<string, number>
    timers: Record<string, TimerStats>
}

export default class AsyncGuardJS extends Error {
    name: "AsyncGuardJS"
    cause?: unknown
    context?: AttemptContext
    attempt?: number
    circuit_state?: CircuitState

    constructor(message: string, meta?: Record<string, unknown>)

    static run<T>(
        task: (context: AttemptContext) => Promise<T>,
        options?: AsyncGuardOptions<T>
    ): Promise<T>

    static get_circuit_status(name?: string): CircuitStatus | null
    static reset_circuit(name?: string): void

    /**
     * @experimental
    */

    static get_metrics(): MetricsSnapshot
    static reset_metrics(): void
}