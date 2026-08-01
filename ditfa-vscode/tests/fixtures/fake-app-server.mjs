/**
 * A stand-in for `ditfa app-server`, speaking the same newline-delimited
 * JSON-RPC dialect over stdio.
 *
 * It is deliberately literal about the wire format — including omitting the
 * `"jsonrpc"` member — so the client is tested against the protocol as shipped
 * rather than against a convenient approximation.
 */
const SERVER_REQUEST_ID = 9001;

let buffer = "";
/** Client request id waiting on the answer to our own server-initiated request. */
let pendingEcho = null;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      handle(JSON.parse(line));
    }
    newline = buffer.indexOf("\n");
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  // The client's answer to our own request comes back as a bare result.
  if (pendingEcho !== null && message.id === SERVER_REQUEST_ID && message.method === undefined) {
    send({ id: pendingEcho, result: { echoed: message.result ?? message.error } });
    pendingEcho = null;
    return;
  }

  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          userAgent: "fake-app-server/0.0.0",
          ditfaHome: "/tmp/fake-ditfa-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      return;

    case "initialized":
      // Prove notifications flow server -> client after the handshake.
      send({ method: "warning", params: { threadId: null, message: "handshake complete" } });
      return;

    case "thread/start":
      // Emitted before the response so tests can observe notification delivery
      // without racing the handshake.
      send({ method: "warning", params: { threadId: null, message: "starting a thread" } });
      send({
        id: message.id,
        result: {
          thread: { id: "thread-1", name: null },
          model: "test-model",
          modelProvider: "test-provider",
          cwd: message.params?.cwd ?? "/tmp",
        },
      });
      return;

    case "boom":
      send({ id: message.id, error: { code: -32000, message: "exploded on purpose" } });
      return;

    case "provoke/approval":
      pendingEcho = message.id;
      send({
        id: SERVER_REQUEST_ID,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 0,
          environmentId: null,
          command: "rm -rf /",
          cwd: "/tmp",
        },
      });
      return;

    case "exit":
      process.exit(0);
      return;

    default:
      send({ id: message.id, error: { code: -32601, message: `no such method: ${message.method}` } });
  }
}
