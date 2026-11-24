#ifndef CHROME_BROWSER_AGENT_KERNEL_CORE_RPC_ROUTER_H_
#define CHROME_BROWSER_AGENT_KERNEL_CORE_RPC_ROUTER_H_

#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "kernel_state.h"

namespace agent_kernel::core {

enum class RuntimeMode {
  kDesktop,
  kDaemon,
};

// Minimal clean-room JSON-RPC router translating length-prefixed JSON requests
// into KernelState operations and structured JSON responses / events matching
// clients/protocol/schema.json.
class RpcRouter {
 public:
  using EventCallback = std::function<void(const std::string& event_json)>;

  explicit RpcRouter(EventCallback on_event = {},
                     RuntimeMode runtime_mode = RuntimeMode::kDesktop);

  void SetRuntimeMode(RuntimeMode mode);
  RuntimeMode runtime_mode() const;

  // Thread-safe RPC entrypoint invoked by UdsPosixServer workers.
  std::string HandleRequestJson(const std::string& request_json);

  // Returns serialized dialog.opened events to replay to newly connected clients.
  std::vector<std::string> BuildReconnectReplayEvents() const;

  // Test/runtime hooks for browser-originated events.
  void SeedPersonalCookie(const std::string& name, const std::string& value);
  OpStatus NotifyPopupCaptured(const std::string& source_page_id,
                               const std::string& target_url,
                               PageInfo* out_page = nullptr);
  OpStatus NotifyDialogOpened(const std::string& page_id, OpenDialog dialog);
  OpStatus NotifyTunnelHealth(const std::string& scope, bool healthy);

 private:
  void EmitEvent(const std::string& event_name, const std::string& params_json);

  mutable std::mutex mu_;
  KernelState state_;
  EventCallback on_event_;
  RuntimeMode runtime_mode_ = RuntimeMode::kDesktop;
  std::map<std::string, std::string> personal_cookies_;
  std::map<std::string, std::map<std::string, std::string>> private_cookies_;
};

}  // namespace agent_kernel::core

#endif  // CHROME_BROWSER_AGENT_KERNEL_CORE_RPC_ROUTER_H_
