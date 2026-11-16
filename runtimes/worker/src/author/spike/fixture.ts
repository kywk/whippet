import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AIConfig } from "../../ai/config.js";
import type { EngineRun } from "../engine.js";

export type Wire = Record<string, any>;
export const call = (name: string, id: string, args: unknown = {}) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: "completed" });
export const text = (value = '{"message":"完成"}') => ({ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] });
export function envelope(output: Wire[], extra: Wire = {}): Wire {
  return { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "muse-spark-1.3-contributor", output,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, ...extra };
}
export async function fixture(handler: (body: Wire, index: number, response: ServerResponse) => Wire | undefined) {
  const bodies: Wire[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const raw = handler(body, bodies.length, response);
    if (!raw) return;
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(raw)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    let sequence = 0;
    const send = (event: Wire) => response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
    send({ type: "response.created", response: { ...raw, status: "in_progress", output: [] } });
    for (const [index, item] of raw.output.entries()) {
      send({ type: "response.output_item.added", output_index: index, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } });
      if (item.type === "function_call") {
        send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: item.arguments });
        send({ type: "response.function_call_arguments.done", item_id: item.id, output_index: index, arguments: item.arguments });
      } else if (item.type === "message") {
        send({ type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        send({ type: "response.output_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
        send({ type: "response.output_text.done", item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text });
      }
      send({ type: "response.output_item.done", output_index: index, item });
    }
    send({ type: "response.completed", response: raw });
    response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const config: AIConfig = { enabled: true, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "muse-spark-1.3-contributor", reasoningEffort: "xhigh", apiKey: "synthetic-m12-provider-key" };
  return { config, bodies, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export function runInput(config: AIConfig, overrides: Partial<EngineRun> = {}): EngineRun {
  return { instructions: "Whippet test instructions", context: [{ role: "user", content: "fixture task" }], tools: [{ name: "read_draft" }],
    budget: { modelRequests: 2, toolExecutions: 2, maxOutputTokens: 8192 }, model: config, signal: new AbortController().signal,
    beforeRequest: context => context, checkpoint: () => undefined, execute: async () => ({ ok: true }),
    request: async body => {
      const response = await fetch(config.baseURL + "/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: overrides.signal });
      if (!response.ok) throw new Error("fixture_http_error");
      return response.json();
    }, ...overrides };
}
