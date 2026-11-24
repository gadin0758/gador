// Length-prefixed (uint32 BE) UTF-8 JSON framing over Unix Domain Socket.
// Clean-room implementation shared by protocol clients and test harnesses.

export const MAX_FRAME_BYTES = 64 * 1024 * 1024; // 64 MiB hard cap

export function encodeFrame(payload) {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new RangeError(
      `Frame size ${body.length} exceeds limit ${MAX_FRAME_BYTES}`
    );
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  #chunks = [];
  #bufferedBytes = 0;

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return [];
    this.#chunks.push(buf);
    this.#bufferedBytes += buf.length;

    const messages = [];
    while (this.#bufferedBytes >= 4) {
      const merged =
        this.#chunks.length === 1
          ? this.#chunks[0]
          : Buffer.concat(this.#chunks, this.#bufferedBytes);
      const length = merged.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.reset();
        throw new RangeError(
          `Incoming frame size ${length} exceeds limit ${MAX_FRAME_BYTES}`
        );
      }
      if (merged.length < 4 + length) {
        this.#chunks = [merged];
        this.#bufferedBytes = merged.length;
        break;
      }

      const body = merged.subarray(4, 4 + length).toString("utf8");
      messages.push(JSON.parse(body));

      const rest = merged.subarray(4 + length);
      if (rest.length > 0) {
        this.#chunks = [rest];
        this.#bufferedBytes = rest.length;
      } else {
        this.#chunks = [];
        this.#bufferedBytes = 0;
      }
    }
    return messages;
  }

  reset() {
    this.#chunks = [];
    this.#bufferedBytes = 0;
  }
}
