import net from "node:net";
import { EventEmitter } from "node:events";
import { encodeFrame, FrameDecoder } from "./framing.mjs";

export class ProtocolError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
}

export class AgentKernelClient extends EventEmitter {
  #socket = null;
  #decoder = new FrameDecoder();
  #nextId = 1;
  #pending = new Map();
  #defaultTimeoutMs;

  constructor({ socketPath, timeoutMs = 15000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.#defaultTimeoutMs = timeoutMs;
  }

  async connect() {
    if (this.#socket) return;
    await new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const onError = (err) => {
        sock.destroy();
        reject(err);
      };
      sock.once("error", onError);
      sock.once("connect", () => {
        sock.off("error", onError);
        this.#socket = sock;
        this.#wireSocket(sock);
        resolve();
      });
    });
  }

  #wireSocket(sock) {
    sock.on("data", (chunk) => {
      let messages;
      try {
        messages = this.#decoder.push(chunk);
      } catch (err) {
        this.emit("error", err);
        sock.destroy();
        return;
      }
      for (const msg of messages) {
        if (typeof msg.id === "number") {
          const entry = this.#pending.get(msg.id);
          if (!entry) continue;
          this.#pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(
              new ProtocolError(
                msg.error.code || "ERR_INTERNAL",
                msg.error.message || "Unknown protocol error",
                msg.error.data
              )
            );
          } else {
            entry.resolve(msg.result);
          }
        } else if (typeof msg.event === "string") {
          this.emit("event", msg);
          this.emit(msg.event, msg.params);
        }
      }
    });

    const rejectAll = (reason) => {
      for (const [id, entry] of this.#pending) {
        clearTimeout(entry.timer);
        entry.reject(reason);
        this.#pending.delete(id);
      }
      this.#socket = null;
      this.emit("close");
    };

    sock.on("close", () => rejectAll(new Error("UDS connection closed")));
    sock.on("error", (err) => rejectAll(err));
  }

  call(method, params = {}, timeoutMs = this.#defaultTimeoutMs) {
    if (!this.#socket) {
      return Promise.reject(new Error("Client is not connected"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ProtocolError(
            "ERR_TIMEOUT",
            `RPC ${method} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(encodeFrame({ id, method, params }));
    });
  }

  async close() {
    if (!this.#socket) return;
    const sock = this.#socket;
    this.#socket = null;
    await new Promise((resolve) => {
      sock.once("close", resolve);
      sock.end();
    });
  }

  // Convenience typed methods matching clients/protocol/schema.json
  capabilities() {
    return this.call("agent.capabilities");
  }
  createSpace(params) {
    return this.call("space.create", params);
  }
  listSpaces() {
    return this.call("space.list");
  }
  closeSpace(spaceId) {
    return this.call("space.close", { spaceId });
  }
  openPage(params) {
    return this.call("page.open", params);
  }
  listPages(spaceId = undefined) {
    return this.call("page.list", spaceId ? { spaceId } : {});
  }
  closePage(pageId) {
    return this.call("page.close", { pageId });
  }
  attachView(pageId, interactive = false) {
    return this.call("page.attachView", { pageId, interactive });
  }
  detachView(pageId) {
    return this.call("page.detachView", { pageId });
  }
  requestTakeover(spaceId, reason, pageId = undefined) {
    return this.call("takeover.request", { spaceId, reason, pageId });
  }
  releaseTakeover(spaceId) {
    return this.call("takeover.release", { spaceId });
  }
  handleDialog(pageId, accept, promptText = undefined) {
    return this.call("dialog.handle", { pageId, accept, promptText });
  }
  sendCdp(pageId, cdpMethod, cdpParams = {}, sessionId = undefined) {
    return this.call("cdp.send", { pageId, cdpMethod, cdpParams, sessionId });
  }
  setTunnel(params) {
    return this.call("network.setTunnel", params);
  }
  getNetworkStatus(scope = undefined) {
    return this.call("network.getStatus", scope ? { scope } : {});
  }
}
