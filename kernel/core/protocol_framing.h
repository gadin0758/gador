#ifndef CHROME_BROWSER_AGENT_KERNEL_CORE_PROTOCOL_FRAMING_H_
#define CHROME_BROWSER_AGENT_KERNEL_CORE_PROTOCOL_FRAMING_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace agent_kernel::core {

inline constexpr uint32_t kMaxFrameBytes = 64u * 1024u * 1024u;  // 64 MiB

// Encodes UTF-8 JSON/payload with a 4-byte big-endian length prefix.
// Returns empty vector if payload exceeds kMaxFrameBytes.
std::vector<uint8_t> EncodeFrame(std::string_view payload);

// Streaming decoder that handles arbitrarily fragmented or coalesced chunks.
class FrameDecoder {
 public:
  struct PushResult {
    bool ok = true;
    std::string error;
    std::vector<std::string> frames;
  };

  PushResult Push(const uint8_t* data, size_t size);
  void Reset();

 private:
  std::vector<uint8_t> buffer_;
};

}  // namespace agent_kernel::core

#endif  // CHROME_BROWSER_AGENT_KERNEL_CORE_PROTOCOL_FRAMING_H_
