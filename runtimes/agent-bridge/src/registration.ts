import { runModelProbe } from '../../worker/dist/author/model-probe.js';
import type { AIConfig } from '../../worker/dist/ai/config.js';
import { BridgeError, object, uuid } from './safety.js';
import type { MCPClient } from './transport.js';
import type { ProbeReceipt } from './state.js';

function expiry(value: unknown): number {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time <= Date.now()) throw new BridgeError('invalid_response');
  return time;
}

export async function registerAgent(client: MCPClient, config: AIConfig, options: {
  signal?: AbortSignal; fetcher?: typeof fetch; guard: (value: unknown) => void; intervalMs?: number;
  previousProbe?: ProbeReceipt; saveProbe: (receipt: ProbeReceipt) => void;
}): Promise<() => Promise<void>> {
  const intervalMs = options.intervalMs ?? 30000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 30000) throw new BridgeError('invalid_input');
  const registration = await client.agent('register', { engine: config.engine, provider: config.provider ?? 'opencode', model: config.model, skillIds: ['test-author'] }, options.signal);
  if (!uuid(registration.registrationId) || registration.heartbeatIntervalMs !== 30000) throw new BridgeError('invalid_response');
  expiry(registration.expiresAt);
  if (registration.challenge !== null) {
    const challenge = object(registration.challenge);
    if (!uuid(challenge.id)) throw new BridgeError('invalid_response');
    const expiresAt = expiry(challenge.expiresAt);
    const pin = { registrationId: registration.registrationId, challengeId: challenge.id };
    const prior = options.previousProbe;
    let status = prior?.registrationId === pin.registrationId && prior.challengeId === pin.challengeId ? prior.status ?? 'probe_failed' : undefined;
    if (status === undefined) {
      options.saveProbe(pin);
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(30000, expiresAt - Date.now())));
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      status = await runModelProbe(config, challenge.id, { signal, fetcher: options.fetcher, guard: options.guard });
    }
    options.saveProbe({ ...pin, status });
    options.signal?.throwIfAborted();
    const result = await client.agent('probe', { ...pin, status }, options.signal);
    if (status !== 'passed' || result.status !== 'ready' || result.reason !== null) throw new BridgeError('agent_not_ready');
  }
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || signal.aborted) return;
    pending = client.agent('heartbeat', { registrationId: registration.registrationId }, signal)
      .then(reply => { expiry(reply.expiresAt); })
      .catch(() => { clearInterval(timer); }) // The existing task lease remains authoritative for an accepted claim.
      .finally(() => { pending = undefined; });
  }, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); stop.abort(); await pending; };
}
