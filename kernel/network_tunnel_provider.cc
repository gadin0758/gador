#include "chrome/browser/agent_kernel/network_tunnel_provider.h"

#include <utility>

#include "base/strings/string_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/browser_context.h"
#include "net/traffic_annotation/network_traffic_annotation.h"

namespace agent_kernel {

namespace {

NetworkTunnelProvider* g_global_provider = nullptr;

constexpr net::NetworkTrafficAnnotationTag kAgentTunnelProxyAnnotation =
    net::DefineNetworkTrafficAnnotation("agent_kernel_vpn_tunnel", R"(
      semantics {
        sender: "gador NetworkTunnelProvider"
        description:
          "Routes browser or isolated AgentSpace traffic through an explicitly "
          "configured VPN/tunnel endpoint while disabling OS proxy overrides."
        trigger: "Browser startup or network.setTunnel RPC call."
        data: "User-configured tunnel endpoint and bypass list."
        destination: OTHER
        destination_other: "User-selected local VPN or proxy tunnel."
      }
      policy {
        cookies_allowed: NO
        setting: "Configured via gador UDS control plane."
        policy_exception_justification: "Controlled locally by the browser user."
      })");

}  // namespace

// static
NetworkTunnelProvider* NetworkTunnelProvider::GetGlobalInstance() {
  return g_global_provider;
}

// static
void NetworkTunnelProvider::SetGlobalInstance(NetworkTunnelProvider* instance) {
  g_global_provider = instance;
}

NetworkTunnelProvider::NetworkTunnelProvider() {
  TunnelStatus default_status;
  default_status.config.scope = "browser";
  default_status.config.mode = RouteMode::kDirectOnly;
  default_status.config.webrtc_policy = "disable_non_proxied_udp";
  default_status.os_proxy_disabled = true;
  default_status.tunnel_healthy = true;
  routes_.emplace("browser", std::move(default_status));
}

NetworkTunnelProvider::~NetworkTunnelProvider() {
  if (g_global_provider == this) {
    g_global_provider = nullptr;
  }
}

void NetworkTunnelProvider::ApplyToNetworkContextParams(
    content::BrowserContext* browser_context,
    network::mojom::NetworkContextParams* context_params) {
  if (!browser_context || !context_params) {
    return;
  }

  // Enforce WebRTC leak prevention on the profile prefs.
  if (Profile* profile = Profile::FromBrowserContext(browser_context)) {
    if (PrefService* prefs = profile->GetPrefs()) {
      prefs->SetString(prefs::kWebRTCIPHandlingPolicy,
                       "disable_non_proxied_udp");
    }
  }

  std::string scope_key = "browser";
  if (browser_context->IsOffTheRecord()) {
    const std::string ctx_id = browser_context->UniqueId();
    auto alias_it = context_id_to_space_scope_.find(ctx_id);
    scope_key = (alias_it != context_id_to_space_scope_.end())
                    ? alias_it->second
                    : ("space:" + ctx_id);
  }

  auto it = routes_.find(scope_key);
  if (it == routes_.end()) {
    it = routes_.find("browser");
  }
  if (it == routes_.end()) {
    return;
  }

  // Detach OS SystemProxyConfigService and bind our own ProxyConfigClient so
  // host OS proxy toggles / network switches can never override this browser.
  context_params->initial_proxy_config = net::ProxyConfigWithAnnotation(
      BuildEffectiveProxyConfig(it->second), kAgentTunnelProxyAnnotation);

  mojo::Remote<network::mojom::ProxyConfigClient> client;
  context_params->proxy_config_client_receiver =
      client.BindNewPipeAndPassReceiver();
  proxy_clients_[scope_key] = std::move(client);
  if (browser_context->IsOffTheRecord()) {
    space_scope_to_context_id_[scope_key] = browser_context->UniqueId();
  }
}

bool NetworkTunnelProvider::SetTunnel(const TunnelConfig& config) {
  if (config.mode == RouteMode::kStrictTunnel &&
      (!config.endpoint.has_value() || config.endpoint->empty())) {
    return false;
  }
  TunnelStatus status;
  status.config = config;
  if (status.config.webrtc_policy.empty()) {
    status.config.webrtc_policy = "disable_non_proxied_udp";
  }
  status.os_proxy_disabled = true;
  status.tunnel_healthy = true;

  const std::string scope =
      status.config.scope.empty() ? "browser" : status.config.scope;
  status.config.scope = scope;
  routes_[scope] = status;

  PushProxyConfigIfBound(scope, status);
  return true;
}

void NetworkTunnelProvider::OnTunnelHealthChanged(const std::string& scope,
                                                  bool healthy) {
  auto it = routes_.find(scope);
  if (it == routes_.end()) {
    return;
  }
  it->second.tunnel_healthy = healthy;
  PushProxyConfigIfBound(scope, it->second);
}

void NetworkTunnelProvider::RegisterSpaceContextAlias(
    const std::string& space_id,
    const std::string& browser_context_unique_id) {
  const std::string scope = "space:" + space_id;
  context_id_to_space_scope_[browser_context_unique_id] = scope;
  space_scope_to_context_id_[scope] = browser_context_unique_id;
  // If a proxy client was already bound under the raw context unique id, re-key it.
  const std::string raw_key = "space:" + browser_context_unique_id;
  auto raw_it = proxy_clients_.find(raw_key);
  if (raw_it != proxy_clients_.end()) {
    proxy_clients_[scope] = std::move(raw_it->second);
    proxy_clients_.erase(raw_it);
  }
}

void NetworkTunnelProvider::RemoveSpaceScope(const std::string& space_id) {
  const std::string scope = "space:" + space_id;
  routes_.erase(scope);
  proxy_clients_.erase(scope);
  auto it = space_scope_to_context_id_.find(scope);
  if (it != space_scope_to_context_id_.end()) {
    context_id_to_space_scope_.erase(it->second);
    space_scope_to_context_id_.erase(it);
  }
}

bool NetworkTunnelProvider::CheckNetworkAllowedForSpace(
    const std::string& space_id) const {
  auto it = routes_.find("space:" + space_id);
  if (it == routes_.end()) {
    it = routes_.find("browser");
  }
  if (it == routes_.end()) {
    return true;
  }
  const TunnelStatus& st = it->second;
  if (st.config.mode == RouteMode::kStrictTunnel && st.config.fail_closed &&
      !st.tunnel_healthy) {
    return false;
  }
  return true;
}

void NetworkTunnelProvider::PushProxyConfigIfBound(
    const std::string& scope,
    const TunnelStatus& status) {
  if (auto it = proxy_clients_.find(scope);
      it != proxy_clients_.end() && it->second.is_bound()) {
    it->second->OnProxyConfigUpdated(net::ProxyConfigWithAnnotation(
        BuildEffectiveProxyConfig(status), kAgentTunnelProxyAnnotation));
  }
}

std::vector<TunnelStatus> NetworkTunnelProvider::GetStatus(
    const std::optional<std::string>& scope) const {
  std::vector<TunnelStatus> out;
  for (const auto& [key, status] : routes_) {
    if (!scope.has_value() || key == *scope) {
      out.push_back(status);
    }
  }
  return out;
}

net::ProxyConfig NetworkTunnelProvider::BuildEffectiveProxyConfig(
    const TunnelStatus& status) const {
  net::ProxyConfig config;
  if (status.config.mode == RouteMode::kDirectOnly) {
    return net::ProxyConfig::CreateDirect();
  }
  if (status.config.mode == RouteMode::kStrictTunnel &&
      status.config.fail_closed && !status.tunnel_healthy) {
    // Fail-Closed Kill-Switch: route into non-routable blackhole proxy so
    // requests fail immediately rather than falling back to host OS direct net.
    config.proxy_rules().ParseFromString("PROXY 0.0.0.0:0");
    return config;
  }
  if (status.config.endpoint.has_value() && !status.config.endpoint->empty()) {
    config.proxy_rules().ParseFromString(*status.config.endpoint);
    if (!status.config.bypass_list.empty()) {
      config.proxy_rules().bypass_rules.ParseFromString(
          base::JoinString(status.config.bypass_list, ";"));
    }
    return config;
  }
  return net::ProxyConfig::CreateDirect();
}

}  // namespace agent_kernel
