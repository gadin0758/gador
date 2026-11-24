#include "kernel_state.h"

#include <utility>

#include "security_guard.h"

namespace agent_kernel::core {

const char* AuthModeToString(AuthMode mode) {
  switch (mode) {
    case AuthMode::kShared:
      return "shared";
    case AuthMode::kPrivate:
      return "private";
  }
  return "shared";
}

const char* ControlStateToString(ControlState state) {
  switch (state) {
    case ControlState::kAgentRunning:
      return "AGENT_RUNNING";
    case ControlState::kUserObserving:
      return "USER_OBSERVING";
    case ControlState::kUserActive:
      return "USER_ACTIVE";
  }
  return "AGENT_RUNNING";
}

const char* RouteModeToString(RouteMode mode) {
  switch (mode) {
    case RouteMode::kStrictTunnel:
      return "strict_tunnel";
    case RouteMode::kDirectOnly:
      return "direct_only";
    case RouteMode::kCustom:
      return "custom";
  }
  return "direct_only";
}

KernelState::KernelState() {
  TunnelPolicy default_route;
  default_route.scope = "browser";
  default_route.mode = RouteMode::kDirectOnly;
  default_route.os_proxy_disabled = true;
  default_route.webrtc_policy = "disable_non_proxied_udp";
  default_route.fail_closed = false;
  default_route.tunnel_healthy = true;
  routes_.emplace("browser", std::move(default_route));
}

std::string KernelState::CreateSpace(const std::string& name,
                                     AuthMode auth_mode,
                                     Viewport default_viewport) {
  const std::string space_id = "sp_" + std::to_string(next_space_seq_++);
  SpaceInfo info;
  info.space_id = space_id;
  info.name = name.empty() ? space_id : name;
  info.auth_mode = auth_mode;
  info.control_state = ControlState::kAgentRunning;
  info.default_viewport =
      (default_viewport.width > 0 && default_viewport.height > 0)
          ? default_viewport
          : Viewport{1280, 800};
  spaces_.emplace(space_id, std::move(info));
  return space_id;
}

OpStatus KernelState::CloseSpace(const std::string& space_id,
                                 std::vector<std::string>* closed_pages) {
  auto it = spaces_.find(space_id);
  if (it == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  for (auto pit = pages_.begin(); pit != pages_.end();) {
    if (pit->second.space_id == space_id) {
      if (closed_pages) {
        closed_pages->push_back(pit->first);
      }
      pit = pages_.erase(pit);
    } else {
      ++pit;
    }
  }
  routes_.erase("space:" + space_id);
  spaces_.erase(it);
  return OpStatus::Ok();
}

std::optional<SpaceInfo> KernelState::GetSpace(
    const std::string& space_id) const {
  auto it = spaces_.find(space_id);
  if (it == spaces_.end()) {
    return std::nullopt;
  }
  return it->second;
}

std::vector<SpaceInfo> KernelState::ListSpaces() const {
  std::vector<SpaceInfo> out;
  out.reserve(spaces_.size());
  for (const auto& [id, space] : spaces_) {
    out.push_back(space);
  }
  return out;
}

OpStatus KernelState::OpenPage(const std::string& space_id,
                               const std::string& url,
                               std::optional<Viewport> viewport,
                               PageInfo* out_page) {
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  if (sit->second.control_state == ControlState::kUserActive) {
    return OpStatus::Error("ERR_HUMAN_IN_CONTROL",
                           "Space is under USER_ACTIVE control");
  }
  if (OpStatus net = CheckNetworkAllowedForSpace(space_id); !net.ok) {
    return net;
  }

  const std::string target_url = url.empty() ? "about:blank" : url;
  if (auto sec = CheckAgentUrlPolicy(target_url); !sec.Allowed()) {
    return OpStatus::Error("ERR_DOMAIN_DENIED", sec.message);
  }

  const Viewport vp = viewport.value_or(sit->second.default_viewport);
  if (vp.width <= 0 || vp.height <= 0) {
    return OpStatus::Error("ERR_INVALID_PARAMS", "Viewport must be non-zero");
  }

  const std::string page_id = "pg_" + std::to_string(next_page_seq_++);
  PageInfo page;
  page.page_id = page_id;
  page.space_id = space_id;
  page.url = target_url;
  page.viewport = vp;
  page.view_attached = false;
  page.mount_count = 0;
  page.in_personal_tab_strip = false;
  pages_.emplace(page_id, page);
  if (out_page) {
    *out_page = std::move(page);
  }
  return OpStatus::Ok();
}

OpStatus KernelState::CapturePopupPage(const std::string& source_page_id,
                                       const std::string& target_url,
                                       PageInfo* out_page) {
  auto pit = pages_.find(source_page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_PAGE_NOT_FOUND", "Source page not found");
  }
  const std::string page_id = "pg_" + std::to_string(next_page_seq_++);
  PageInfo child;
  child.page_id = page_id;
  child.space_id = pit->second.space_id;
  child.url = target_url.empty() ? "about:blank" : target_url;
  child.viewport = pit->second.viewport;
  child.view_attached = false;
  child.mount_count = 0;
  child.in_personal_tab_strip = false;
  pages_.emplace(page_id, child);
  if (out_page) {
    *out_page = std::move(child);
  }
  return OpStatus::Ok();
}

OpStatus KernelState::ClosePage(const std::string& page_id) {
  auto pit = pages_.find(page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  auto sit = spaces_.find(pit->second.space_id);
  if (sit != spaces_.end() &&
      sit->second.control_state == ControlState::kUserActive) {
    return OpStatus::Error("ERR_HUMAN_IN_CONTROL",
                           "Space is under USER_ACTIVE control");
  }
  pages_.erase(pit);
  return OpStatus::Ok();
}

std::optional<PageInfo> KernelState::GetPage(const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return std::nullopt;
  }
  return it->second;
}

std::vector<PageInfo> KernelState::ListPages(
    const std::optional<std::string>& space_id) const {
  std::vector<PageInfo> out;
  for (const auto& [id, page] : pages_) {
    if (!space_id.has_value() || page.space_id == *space_id) {
      out.push_back(page);
    }
  }
  return out;
}

OpStatus KernelState::AttachView(const std::string& page_id,
                                 bool interactive,
                                 PageInfo* out_page,
                                 ControlState* out_state) {
  auto pit = pages_.find(page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  auto sit = spaces_.find(pit->second.space_id);
  if (sit == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Owning space missing");
  }

  pit->second.view_attached = true;
  pit->second.mount_count += 1;
  if (interactive) {
    sit->second.control_state = ControlState::kUserActive;
  } else if (sit->second.control_state != ControlState::kUserActive) {
    sit->second.control_state = ControlState::kUserObserving;
  }

  if (out_page) {
    *out_page = pit->second;
  }
  if (out_state) {
    *out_state = sit->second.control_state;
  }
  return OpStatus::Ok();
}

OpStatus KernelState::DetachView(const std::string& page_id,
                                 PageInfo* out_page,
                                 ControlState* out_state) {
  auto pit = pages_.find(page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  auto sit = spaces_.find(pit->second.space_id);
  if (sit == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Owning space missing");
  }

  pit->second.view_attached = false;
  if (sit->second.control_state == ControlState::kUserObserving) {
    sit->second.control_state = ControlState::kAgentRunning;
  }
  if (out_page) {
    *out_page = pit->second;
  }
  if (out_state) {
    *out_state = sit->second.control_state;
  }
  return OpStatus::Ok();
}

OpStatus KernelState::RequestTakeover(const std::string& space_id) {
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  sit->second.control_state = ControlState::kUserActive;
  return OpStatus::Ok();
}

OpStatus KernelState::ReleaseTakeover(const std::string& space_id) {
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  sit->second.control_state = ControlState::kAgentRunning;
  return OpStatus::Ok();
}

OpStatus KernelState::AuthorizeAgentMutation(const std::string& page_id) const {
  auto pit = pages_.find(page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_TARGET_OUT_OF_SCOPE",
                           "Target is not an Agent-owned page");
  }
  auto sit = spaces_.find(pit->second.space_id);
  if (sit == spaces_.end()) {
    return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Owning space missing");
  }
  if (sit->second.control_state == ControlState::kUserActive) {
    return OpStatus::Error("ERR_HUMAN_IN_CONTROL",
                           "Space is currently under USER_ACTIVE control");
  }
  return CheckNetworkAllowedForSpace(sit->first);
}

OpStatus KernelState::RecordDialogOpened(const std::string& page_id,
                                         OpenDialog dialog) {
  auto pit = pages_.find(page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  pit->second.open_dialog = std::move(dialog);
  return OpStatus::Ok();
}

OpStatus KernelState::HandleDialog(
    const std::string& page_id,
    bool /*accept*/,
    const std::optional<std::string>& /*prompt_text*/,
    std::string* out_dialog_type) {
  auto pit = pages_.find(page_id);
  if (pit == pages_.end()) {
    return OpStatus::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  if (!pit->second.open_dialog.has_value()) {
    return OpStatus::Error("ERR_DIALOG_NOT_OPEN", "No open dialog on page");
  }
  if (out_dialog_type) {
    *out_dialog_type = pit->second.open_dialog->type;
  }
  pit->second.open_dialog.reset();
  return OpStatus::Ok();
}

std::vector<std::pair<std::string, OpenDialog>> KernelState::ListOpenDialogs()
    const {
  std::vector<std::pair<std::string, OpenDialog>> out;
  for (const auto& [pid, page] : pages_) {
    if (page.open_dialog.has_value()) {
      out.emplace_back(pid, *page.open_dialog);
    }
  }
  return out;
}

OpStatus KernelState::SetTunnelPolicy(TunnelPolicy policy,
                                      TunnelPolicy* out_effective) {
  if (policy.scope.empty()) {
    policy.scope = "browser";
  }
  if (policy.scope.rfind("space:", 0) == 0) {
    const std::string space_id = policy.scope.substr(6);
    auto sit = spaces_.find(space_id);
    if (sit == spaces_.end()) {
      return OpStatus::Error("ERR_SPACE_NOT_FOUND", "Space not found");
    }
    if (sit->second.auth_mode != AuthMode::kPrivate) {
      return OpStatus::Error(
          "ERR_INVALID_PARAMS",
          "Per-space tunnel override requires authMode=private");
    }
  } else if (policy.scope != "browser") {
    return OpStatus::Error("ERR_INVALID_PARAMS", "Invalid tunnel scope");
  }

  if (policy.mode == RouteMode::kStrictTunnel &&
      (!policy.endpoint.has_value() || policy.endpoint->empty())) {
    return OpStatus::Error("ERR_INVALID_PARAMS",
                           "strict_tunnel mode requires a tunnel endpoint");
  }

  policy.os_proxy_disabled = true;
  if (policy.webrtc_policy.empty()) {
    policy.webrtc_policy = "disable_non_proxied_udp";
  }
  policy.tunnel_healthy = true;
  routes_[policy.scope] = policy;
  if (out_effective) {
    *out_effective = std::move(policy);
  }
  return OpStatus::Ok();
}

OpStatus KernelState::SetTunnelHealth(const std::string& scope, bool healthy) {
  auto it = routes_.find(scope);
  if (it == routes_.end()) {
    return OpStatus::Error("ERR_INVALID_PARAMS", "Unknown tunnel scope");
  }
  it->second.tunnel_healthy = healthy;
  return OpStatus::Ok();
}

OpStatus KernelState::CheckNetworkAllowedForSpace(
    const std::string& space_id) const {
  auto it = routes_.find("space:" + space_id);
  if (it == routes_.end()) {
    it = routes_.find("browser");
  }
  if (it != routes_.end() && it->second.mode == RouteMode::kStrictTunnel &&
      it->second.fail_closed && !it->second.tunnel_healthy) {
    return OpStatus::Error("ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED",
                           "Network blocked by Fail-Closed Kill-Switch");
  }
  return OpStatus::Ok();
}

std::vector<TunnelPolicy> KernelState::GetTunnelStatuses(
    const std::optional<std::string>& scope) const {
  std::vector<TunnelPolicy> out;
  for (const auto& [key, policy] : routes_) {
    if (!scope.has_value() || key == *scope) {
      out.push_back(policy);
    }
  }
  return out;
}

// static
std::string KernelState::ComputeEffectiveProxyRule(const TunnelPolicy& policy) {
  if (policy.mode == RouteMode::kDirectOnly) {
    return "direct://";
  }
  if (policy.mode == RouteMode::kStrictTunnel && policy.fail_closed &&
      !policy.tunnel_healthy) {
    // Non-routable blackhole proxy rule: guarantees Chromium never falls back
    // to host OS direct networking while VPN tunnel is disconnected.
    return "PROXY 0.0.0.0:0";
  }
  if (!policy.endpoint.has_value() || policy.endpoint->empty()) {
    return "direct://";
  }
  return *policy.endpoint;
}

}  // namespace agent_kernel::core
