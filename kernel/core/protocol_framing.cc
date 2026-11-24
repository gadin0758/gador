#include "protocol_framing.h"

#include <cstring>

namespace agent_kernel::core {

std::vector<uint8_t> EncodeFrame(std::string_view payload) {
  if (payload.size() > kMaxFrameBytes) {
    return {};
  }
  const uint32_t len = static_cast<uint32_t>(payload.size());
  std::vector<uint8_t> out(4 + payload.size());
  out[0] = static_cast<uint8_t>((len >> 24) & 0xFFu);
  out[1] = static_cast<uint8_t>((len >> 16) & 0xFFu);
  out[2] = static_cast<uint8_t>((len >> 8) & 0xFFu);
  out[3] = static_cast<uint8_t>(len & 0xFFu);
  if (!payload.empty()) {
    std::memcpy(out.data() + 4, payload.data(), payload.size());
  }
  return out;
}

FrameDecoder::PushResult FrameDecoder::Push(const uint8_t* data, size_t size) {
  PushResult res;
  if (size == 0) {
    return res;
  }
  buffer_.insert(buffer_.end(), data, data + size);

  size_t offset = 0;
  while (buffer_.size() - offset >= 4) {
    const uint32_t len =
        (static_cast<uint32_t>(buffer_[offset]) << 24) |
        (static_cast<uint32_t>(buffer_[offset + 1]) << 16) |
        (static_cast<uint32_t>(buffer_[offset + 2]) << 8) |
        static_cast<uint32_t>(buffer_[offset + 3]);

    if (len > kMaxFrameBytes) {
      Reset();
      res.ok = false;
      res.error = "Incoming frame exceeds 64 MiB limit";
      res.frames.clear();
      return res;
    }

    if (buffer_.size() - offset - 4 < len) {
      break;
    }

    res.frames.emplace_back(
        reinterpret_cast<const char*>(buffer_.data() + offset + 4), len);
    offset += 4 + len;
  }

  if (offset > 0) {
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(offset));
  }
  return res;
}

void FrameDecoder::Reset() {
  buffer_.clear();
}

}  // namespace agent_kernel::core
