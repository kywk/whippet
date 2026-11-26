// This image replaces only outbound provider fetches with synthetic responses.
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://opencode.ai/inference/go/openai/v1/responses") throw new Error("fixture provider URL");
  const authorization = new Headers(init.headers).get("authorization");
  const responseName = new Map([
    ["Bearer adm-synthetic-key-a", "Agent A"],
    ["Bearer adm-synthetic-key-b", "Agent B"],
  ]).get(authorization);
  if (!responseName) return new Response(null, { status: 401 });
  if (typeof init.body !== "string" || init.body.includes("adm-synthetic-key-")) throw new Error("fixture secret in request body");
  const body = JSON.parse(init.body);
  let text = JSON.stringify({ message: responseName });
  if (body.max_output_tokens === 128) {
    const challenge = JSON.stringify(body.input).match(/WHIPPET_PROBE:[0-9a-f-]{36}/)?.[0];
    if (!challenge || body.tools?.length !== 0 || body.stream !== false) throw new Error("fixture probe contract");
    text = challenge;
  }
  return Response.json({ id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: body.model,
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
};
