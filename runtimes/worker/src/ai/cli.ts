import { AIError, checkAIConfig, readAIConfig } from "./config.js";
import { PROBE_PROMPT, requestCodingResponse } from "./responses.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check" && args.length === 0) {
    // Local validation only; never construct a client or call fetch here.
    console.log(JSON.stringify(checkAIConfig(readAIConfig(process.env))));
    return;
  }
  if (command !== "probe") throw new AIError("invalid_arguments");
  if (!args.includes("--live")) throw new AIError("live_required");
  if (args.length !== 2 || args.filter((arg) => arg === "--live").length !== 1 || args.filter((arg) => arg.startsWith("--session=")).length !== 1) {
    throw new AIError("invalid_arguments");
  }
  const sessionId = args.find((arg) => arg.startsWith("--session="))!.slice("--session=".length);
  const response = await requestCodingResponse(readAIConfig(process.env), { sessionId, input: PROBE_PROMPT });
  // A probe reports only metadata, not model output, request headers, or raw
  // provider bodies. It never writes scripts, manifests, journals or reports.
  console.log(JSON.stringify({ ok: true, status: response.status, textCharacters: response.text.length, requests: 1 }));
}

main().catch((error: unknown) => {
  const safe = error instanceof AIError ? error : new AIError("internal_error");
  console.error(JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message, httpStatus: safe.httpStatus } }));
  process.exitCode = 1;
});
