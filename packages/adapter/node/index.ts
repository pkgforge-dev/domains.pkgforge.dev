// @domains/adapter/node: the Node-only side of the adapter contract.
//   readRecordings, readTcpRecordings   a fixture directory's *.http.json and
//                    *.tcp.json, for runAdapter
//   readBits, readSourceFiles, readRegistry   config/ and adapters/ of a checkout
//   liveConnect      the ctx.connect of a production run: node:net, bounded
//   runSandboxed     runAdapter in a child that cannot reach the network
export { LIVE_CONNECT_LIMITS, type LiveConnectLimits, liveConnect, SocketError, type SocketErrorCode } from "./connect.ts";
export { ADAPTERS_DIR, BITS_PATH, REGISTRY_PATH, RECORDING_SUFFIX, readBits, readRecordings, readRegistry, readSourceFiles, readTcpRecordings } from "./files.ts";
export { REPO_ROOT, runSandboxed, SANDBOX_CHILD, SANDBOX_MAX_ANSWER, SANDBOX_TIMEOUT_MS, type SandboxAnswer, SandboxCause, type SandboxOptions, type SandboxRunJson } from "./sandbox.ts";
