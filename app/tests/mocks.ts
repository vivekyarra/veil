import Fastify from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "node:fs";
const screenshot =
  "data:image/png;base64," +
  readFileSync(
    new URL("./fixtures/synthetic-mail.png", import.meta.url),
  ).toString("base64");

/** Minimal Helix/device contracts absent from many Twitch CLI mock versions. */
export async function twitchMock() {
  const server = Fastify({ logger: false });
  const requests: { method: string; path: string; body: unknown }[] = [];
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  let polls = 0;
  server.all("/*", async (request, reply) => {
    requests.push({
      method: request.method,
      path: request.url,
      body: request.body,
    });
    if (request.url === "/oauth2/device")
      return {
        device_code: "synthetic-device",
        user_code: "SYNTHETIC",
        verification_uri: "https://www.twitch.tv/activate",
        interval: 0,
        expires_in: 60,
      };
    if (request.url === "/oauth2/token") {
      const body = request.body as Record<string, string>;
      if (body.grant_type !== "refresh_token" && ++polls === 1)
        return reply.status(400).send({ message: "authorization_pending" });
      return {
        access_token: "synthetic-access",
        refresh_token: "rotated-synthetic-refresh",
        expires_in: 14400,
      };
    }
    if (request.method === "DELETE") return reply.status(204).send();
    if (request.url.startsWith("/helix/streams/markers"))
      return {
        data: [
          {
            id: "marker-1",
            created_at: new Date().toISOString(),
            position_seconds: 74,
            description: "VEIL incident",
          },
        ],
      };
    if (request.url.startsWith("/helix/clips"))
      return { data: [], pagination: {} };
    return { data: [] };
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local mock address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => server.close(),
  };
}
export async function obsMock() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const offsets: Record<string, number> = { Mic: 25, Desktop: -10 };
  const filters: Record<string, Record<string, unknown>[]> = { Live: [] };
  const requests: string[] = [];
  let program = "Live";
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        op: 0,
        d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        op: number;
        d: {
          requestType: string;
          requestId: string;
          requestData?: Record<string, unknown>;
        };
      };
      if (frame.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (frame.op !== 6) return;
      const { requestType: type, requestId, requestData: data = {} } = frame.d;
      requests.push(type);
      let result: Record<string, unknown> = {};
      let success = true;
      if (type === "GetSceneList")
        result = {
          currentProgramSceneName: program,
          scenes: Object.keys(filters).map((sceneName) => ({ sceneName })),
        };
      else if (type === "GetSourceFilterKindList")
        result = { sourceFilterKinds: ["veil_guard"] };
      else if (type === "GetSourceFilterList")
        result = { filters: filters[String(data.sourceName)] ?? [] };
      else if (type === "CreateSourceFilter")
        filters[String(data.sourceName)].push({
          filterKind: "veil_guard",
          filterName: "VEIL Guard",
          filterEnabled: true,
          filterSettings: data.filterSettings,
        });
      else if (type === "GetInputList")
        result = {
          inputs: Object.keys(offsets).map((inputName) => ({
            inputName,
            inputKind: "wasapi_input_capture",
          })),
        };
      else if (type === "GetInputAudioSyncOffset")
        result = { inputAudioSyncOffset: offsets[String(data.inputName)] };
      else if (type === "SetInputAudioSyncOffset")
        offsets[String(data.inputName)] = Number(data.inputAudioSyncOffset);
      else if (type === "CreateScene") filters[String(data.sceneName)] = [];
      else if (type === "GetSceneItemList")
        result = {
          sceneItems:
            data.sceneName === "Live"
              ? [{ sourceName: "Synthetic fixture", sceneItemEnabled: true }]
              : [],
        };
      else if (type === "GetSourceScreenshot")
        result = { imageData: screenshot };
      else if (type === "SetCurrentProgramScene")
        program = String(data.sceneName);
      else if (type === "GetCurrentProgramScene")
        result = { currentProgramSceneName: program };
      else if (
        ![
          "CreateInput",
          "SetSourceFilterSettings",
          "SetSourceFilterEnabled",
        ].includes(type)
      )
        success = false;
      socket.send(
        JSON.stringify({
          op: 7,
          d: {
            requestType: type,
            requestId,
            requestStatus: { result: success, code: success ? 100 : 204 },
            responseData: result,
          },
        }),
      );
    });
  });
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Mock OBS address missing");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    offsets,
    filters,
    requests,
    get program() {
      return program;
    },
    close: async () => {
      server.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export async function eventSubMock() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  server.on("connection", (socket) =>
    socket.send(
      JSON.stringify({
        metadata: {
          message_id: "welcome",
          message_type: "session_welcome",
          message_timestamp: new Date().toISOString(),
        },
        payload: {
          session: { id: "synthetic-session", keepalive_timeout_seconds: 10 },
        },
      }),
    ),
  );
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Mock EventSub address missing");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    send: (frame: unknown) => {
      for (const socket of server.clients)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify(frame));
    },
    close: async () => {
      server.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
