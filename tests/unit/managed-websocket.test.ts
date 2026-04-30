import { expect, test } from "bun:test";
import { createManagedWebSocket } from "../../src/internal/managed-websocket.ts";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) {
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(): void {}

  emitJson(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  close(code = 1000, reason = "manual close"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: true,
      }),
    );
  }
}

test("managed websocket can run without a message watchdog", async () => {
  const socket = new FakeWebSocket("wss://example.test/ws");

  const session = createManagedWebSocket<{ value?: string }>({
    url: socket.url,
    initialMessageTimeoutMs: 50,
    parseMessage(data) {
      return JSON.parse(data) as { value?: string };
    },
    onMessage() {},
    onUnexpectedClose() {},
    createWebSocket() {
      return socket as unknown as WebSocket;
    },
    messageWatchdog: undefined,
    onError(event) {
      throw new Error(`Unexpected websocket error: ${event.type}`);
    },
  });

  socket.emitJson({ value: "ready" });
  await session.ready;
  await Bun.sleep(30);

  expect(socket.readyState).toBe(FakeWebSocket.OPEN);

  session.close();
});
