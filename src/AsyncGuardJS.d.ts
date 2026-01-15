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

export type RateLimitConfig = {
    name?: string
    max_requests: number
    window_ms: number
    queue?: boolean
    queue_max_wait_ms?: number
}

export type AsyncGuardOptions<T = unknown> = {
    retries?: number
    timeout?: number
    retry_if?: (error: unknown, context: AttemptContext) => boolean | Promise<boolean>
    retry_if_timeout?: number
    backoff?: (attempt: number) => number
    max_backoff?: number
    signal?: AbortSignal
    circuit_breaker?: CircuitBreakerConfig
    rate_limit?: RateLimitConfig
    fallback?: T | (() => T | Promise<T>)
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export type CircuitStatus = {
    state: CircuitState
    failures: number
    opened_at: number | null
}

export type RateLimitStatus = {
    current_requests: number
    capacity_remaining: number
    oldest_request_timestamp: number | null
    ms_until_next_slot: number
    window_ms: number
    is_at_limit: boolean
}

export type MetricLabels = Record<string, string | number | boolean>

export type MetricsSnapshot = {
    counters: Record<string, number>
    timers: Record<string, number[]>  // Raw Measurements
}

export default class AsyncGuardJS extends Error {
    name: "AsyncGuardJS"
    cause?: unknown
    context?: AttemptContext
    attempt?: number
    circuit_state?: CircuitState
    rate_limit?: boolean
    original_error?: Error
    fallback_error?: Error
    active_operations?: number
    waited_ms?: number

    constructor(message: string, meta?: Record<string, unknown>)

    static run<T>(
        task: (context: AttemptContext) => Promise<T>,
        options?: AsyncGuardOptions<T>
    ): Promise<T>

    static get_circuit_status(name?: string): CircuitStatus | null
    static reset_circuit(name?: string): void

    static get_rate_limit_status(name?: string): RateLimitStatus | null
    static reset_rate_limit(name?: string): void

    /**
     * @experimental
     * Get a snapshot of all AsyncGuardJS metrics.
    */

    static get_metrics(): MetricsSnapshot

    /**
     * @experimental
     * Reset all AsyncGuardJS metrics (counters & timers).
    */

    static reset_metrics(): void
    static get_active_operations(): number
}