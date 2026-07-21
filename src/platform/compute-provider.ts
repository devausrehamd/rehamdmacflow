// src/platform/compute-provider.ts
//
// The compute plane's swap point (SPEC-operational-control-plane.md, decision 7).
//
// A ComputeProvider provisions and destroys a running agent INSTANCE. It is the
// one place that changes when the substrate changes: DockerProvider fulfils the
// contract with a local container, a cloud provider with a VM. Everything above
// it — the Provisioning API, the Supervisor's ApiLauncher, the orchestrator —
// binds to this interface and to the API in front of it, never to Docker or a
// cloud SDK. "VM" versus "container" disappears here: the contract is *provision a
// ready instance / destroy it*.

/** What to provision. `manifest` is the role manifest path baked into the image
 *  (e.g. "agents/researcher.json"); the provider maps it to the in-instance path. */
export interface InstanceSpec {
  manifest: string;
  /** Extra environment for the instance, overriding forwarded service config. */
  env?: Record<string, string>;
}

/** A provisioned, READY instance. `instanceId` is the provider's own handle
 *  (container name, VM id); `guid` is the agent's Discovery identity. */
export interface ProvisionedInstance {
  instanceId: string;
  guid: string;
  address: string;
  status: "ready";
}

export interface InstanceStatus {
  instanceId: string;
  running: boolean;
  address?: string;
  health?: "healthy" | "unhealthy" | "unknown";
}

export interface ComputeProvider {
  /** The provider's name, for the Provisioning API to report which substrate is live. */
  readonly kind: string;
  /** Provision an instance and resolve ONLY when it is ready (health + registered). */
  provision(spec: InstanceSpec): Promise<ProvisionedInstance>;
  /** Stop and destroy an instance. Idempotent — destroying an unknown id is a no-op. */
  destroy(instanceId: string): Promise<void>;
  status(instanceId: string): Promise<InstanceStatus>;
  /** Every instance this provider owns — for reconciliation against Discovery. */
  list(): Promise<InstanceStatus[]>;
}
