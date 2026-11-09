import type { Instance } from "./discovery.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(`JSON-RPC ${code}: ${message}${data ? ` (${JSON.stringify(data)})` : ""}`);
    this.code = code;
    this.data = data;
  }
}

export interface Status {
  apiVersion: number;
  knimeVersion: string;
  pid: number;
  ready: boolean;
}

/** Thin client for one KNIME instance. Gateway methods are addressed as `Service.method` with named params. */
export class KnimeClient {
  readonly instance: Instance;
  #nextId = 1;

  constructor(instance: Instance) {
    this.instance = instance;
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.instance.url + path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.instance.token}` },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      let message = body;
      try {
        message = JSON.parse(body).error ?? body;
      } catch {
        // non-JSON error body; use as-is
      }
      throw new HttpError(res.status, message);
    }
    return res;
  }

  async status(): Promise<Status> {
    return (await this.#request("/status")).json() as Promise<Status>;
  }

  /** Polls /status until the KNIME UI has initialised the gateway. */
  async waitUntilReady(timeoutMs = 60_000): Promise<Status> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.status();
      if (s.ready) return s;
      if (Date.now() > deadline) throw new Error("Timed out waiting for KNIME UI to initialise");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Side-effect-free read endpoints (`/api/*`). Use these instead of gateway read methods. */
  async api<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.#request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
  }

  /** Allowlisted gateway methods only (see RpcAllowlist in the plugin); others return JSON-RPC error -32001. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    const res = await this.#request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const msg = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (msg.error) throw new RpcError(msg.error.code, msg.error.message, msg.error.data);
    return msg.result as T;
  }
}
