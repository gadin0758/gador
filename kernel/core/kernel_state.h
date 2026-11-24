#ifndef CHROME_BROWSER_AGENT_KERNEL_CORE_KERNEL_STATE_H_
#define CHROME_BROWSER_AGENT_KERNEL_CORE_KERNEL_STATE_H_

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace agent_kernel::core {

enum class AuthMode {
  kShared,
  kPrivate,
};

enum class ControlState {
  kAgentRunning,
  kUserObserving,
  kUserActive,
};

enum class RouteMode {
  kStrictTunnel,
  kDirectOnly,
  kCustom,
};

struct Viewport {
  int width = 1280;
  int height = 800;
};

struct OpenDialog {
  std::string type;  // alert | confirm | prompt | beforeunload
  std::string message;
  std::string default_prompt;
  std::string url;
};

struct SpaceInfo {
  std::string space_id;
  std::string name;
  AuthMode auth_mode = AuthMode::kShared;
  ControlState control_state = ControlState::kAgentRunning;
  Viewport default_viewport;
};

struct PageInfo {
  std::string page_id;
  std::string space_id;
  std::string url;
  Viewport viewport;
  bool view_attached = false;
  uint64_t mount_count = 0;
  bool in_personal_tab_strip = false;  // Invariant: always false
  std::optional<OpenDialog> open_dialog;
};

struct TunnelPolicy {
  std::string scope = "browser";  // "browser" or "space:<spaceId>"
  RouteMode mode = RouteMode::kDirectOnly;
  std::optional<std::string> endpoint;
  std::optional<std::string> doh_server;
  std::vector<std::string> bypass_list = {"localhost", "127.0.0.1"};
  std::string webrtc_policy = "disable_non_proxied_udp";
  bool os_proxy_disabled = true;
  bool fail_closed = false;
  bool tunnel_healthy = true;
};

struct OpStatus {
  bool ok = true;
  std::string error_code;
  std::string message;

  static OpStatus Ok() { return {}; }
  static OpStatus Error(std::string code, std::string msg) {
    return {false, std::move(code), std::move(msg)};
  }
};

// Pure C++20 core kernel state machine shared by Chromium glue and standalone
// host tests. Enforces all P0/P1 invariants:
//  - Dual-mode auth isolation (shared vs private)
//  - Strict non-zero viewport and detached-from-TabStrip invariant
//  - Hot attach/detach view & USER_ACTIVE write-freeze (ERR_HUMAN_IN_CONTROL)
//  - Cross-connection JS dialog persistence
//  - Independent VPN policy & Fail-Closed Kill-Switch
class KernelState {
 public:
  KernelState();

  std::string CreateSpace(const std::string& name,
                          AuthMode auth_mode,
                          Viewport default_viewport = {});
  OpStatus CloseSpace(const std::string& space_id,
                      std::vector<std::string>* closed_pages = nullptr);
  std::optional<SpaceInfo> GetSpace(const std::string& space_id) const;
  std::vector<SpaceInfo> ListSpaces() const;

  OpStatus OpenPage(const std::string& space_id,
                    const std::string& url,
                    std::optional<Viewport> viewport,
                    PageInfo* out_page);
  OpStatus CapturePopupPage(const std::string& source_page_id,
                            const std::string& target_url,
                            PageInfo* out_page);
  OpStatus ClosePage(const std::string& page_id);
  std::optional<PageInfo> GetPage(const std::string& page_id) const;
  std::vector<PageInfo> ListPages(
      const std::optional<std::string>& space_id = std::nullopt) const;

  // Hot-mount into AgentSpaceWindow WebView (zero-copy) or detach to dock.
  OpStatus AttachView(const std::string& page_id,
                      bool interactive,
                      PageInfo* out_page = nullptr,
                      ControlState* out_state = nullptr);
  OpStatus DetachView(const std::string& page_id,
                      PageInfo* out_page = nullptr,
                      ControlState* out_state = nullptr);

  OpStatus RequestTakeover(const std::string& space_id);
  OpStatus ReleaseTakeover(const std::string& space_id);

  // Validates scope (ERR_TARGET_OUT_OF_SCOPE), control state (ERR_HUMAN_IN_CONTROL),
  // and network Kill-Switch (ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED) before CDP/mutating ops.
  OpStatus AuthorizeAgentMutation(const std::string& page_id) const;

  // Non-blocking JS dialog lifecycle (survives client disconnects/reconnects).
  OpStatus RecordDialogOpened(const std::string& page_id, OpenDialog dialog);
  OpStatus HandleDialog(const std::string& page_id,
                        bool accept,
                        const std::optional<std::string>& prompt_text,
                        std::string* out_dialog_type = nullptr);
  std::vector<std::pair<std::string, OpenDialog>> ListOpenDialogs() const;

  // Independent VPN / Tunnel policy engine.
  OpStatus SetTunnelPolicy(TunnelPolicy policy, TunnelPolicy* out_effective = nullptr);
  OpStatus SetTunnelHealth(const std::string& scope, bool healthy);
  OpStatus CheckNetworkAllowedForSpace(const std::string& space_id) const;
  std::vector<TunnelPolicy> GetTunnelStatuses(
      const std::optional<std::string>& scope = std::nullopt) const;

  // Computes the Chromium net::ProxyConfig rules string.
  // When strict_tunnel + fail_closed + !tunnel_healthy, returns a Fail-Closed
  // blackhole rule ("PROXY 0.0.0.0:0") so traffic NEVER silently falls back direct.
  static std::string ComputeEffectiveProxyRule(const TunnelPolicy& policy);

 private:
  uint64_t next_space_seq_ = 1;
  uint64_t next_page_seq_ = 1;
  std::map<std::string, SpaceInfo> spaces_;
  std::map<std::string, PageInfo> pages_;
  std::map<std::string, TunnelPolicy> routes_;
};

const char* AuthModeToString(AuthMode mode);
const char* ControlStateToString(ControlState state);
const char* RouteModeToString(RouteMode mode);

}  // namespace agent_kernel::core

#endif  // CHROME_BROWSER_AGENT_KERNEL_CORE_KERNEL_STATE_H_
