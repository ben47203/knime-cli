/**
 * Raw HTTP via node:http, for the security and request-parsing tests: lets us forge Host/Origin (which fetch won't set
 * reliably), drop the token, and send bodies JSON.stringify can't produce (e.g. `1.0`, trailing garbage).
 */
import { request } from "node:http";

import type { Instance } from "../../src/discovery.ts";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Parsed body, or undefined if it isn't JSON. */
  json: unknown;
}

export interface RawOptions {
  method?: string;
  path: string;
  /** Raw body; objects are JSON-encoded. */
  body?: string | object;
  /**
   * Header overrides. Defaults are a valid Host, the bearer token and (with a body) a JSON content type; set a header
   * to null to leave it out entirely.
   */
  headers?: Record<string, string | null>;
}

export function raw(instance: Instance, options: RawOptions): Promise<RawResponse> {
  const defaults: Record<string, string> = {
    Host: `127.0.0.1:${instance.port}`,
    Authorization: `Bearer ${instance.token}`,
  };
  const body =
    options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  if (body !== undefined) defaults["Content-Type"] = "application/json";
  const headers: Record<string, string> = { ...defaults };
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    const req = request(
      // setHost: false so a deleted Host header really is absent rather than filled in by node:http.
      { host: "127.0.0.1", port: instance.port, method: options.method ?? "GET", path: options.path, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`Timed out: ${options.method ?? "GET"} ${options.path}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST a raw JSON string to an /api route and return the response (status not checked). */
export function rawPost(instance: Instance, path: string, body: string | object): Promise<RawResponse> {
  return raw(instance, { method: "POST", path, body });
}
