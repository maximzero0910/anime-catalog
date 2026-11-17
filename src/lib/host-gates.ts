import { BoundedGate, ResourceLimitError } from './resource-limits';

export function createHostGateRegistry(options: {
  caps?: Record<string, number>;
  defaultActive?: number;
  maxHosts?: number;
  waitersPerSlot?: number;
  waitMs?: number;
} = {}) {
  const caps = options.caps ?? {};
  const defaultActive = options.defaultActive ?? 3;
  const maxHosts = options.maxHosts ?? 32;
  const waitersPerSlot = options.waitersPerSlot ?? 8;
  const waitMs = options.waitMs ?? 15_000;
  if (!Number.isSafeInteger(defaultActive) || defaultActive < 1 || !Number.isSafeInteger(maxHosts) || maxHosts < 1 || !Number.isSafeInteger(waitersPerSlot) || waitersPerSlot < 0) throw new Error('invalid host gate registry limits');
  const gates = new Map<string, BoundedGate>();

  function gateFor(hostname: string): BoundedGate {
    let gate = gates.get(hostname);
    if (gate) return gate;
    for (const [host, current] of gates) {
      const state = current.snapshot();
      if (state.active === 0 && state.waiting === 0) gates.delete(host);
    }
    if (gates.size >= maxHosts) throw new ResourceLimitError(503, 'provider host capacity exhausted');
    const cap = caps[hostname] ?? defaultActive;
    gate = new BoundedGate(`provider-host:${hostname}`, cap, cap * waitersPerSlot, waitMs);
    gates.set(hostname, gate);
    return gate;
  }

  return {
    run<T>(url: string, task: () => Promise<T>): Promise<T> {
      let hostname: string;
      try { hostname = new URL(url).hostname.toLowerCase(); }
      catch { return Promise.reject(new Error('invalid provider host URL')); }
      return gateFor(hostname).run(task);
    },
    snapshot(): Array<ReturnType<BoundedGate['snapshot']>> { return [...gates.values()].map(gate => gate.snapshot()); },
  };
}
