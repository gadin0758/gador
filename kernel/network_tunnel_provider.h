#ifndef CHROME_BROWSER_AGENT_KERNEL_NETWORK_TUNNEL_PROVIDER_H_
#define CHROME_BROWSER_AGENT_KERNEL_NETWORK_TUNNEL_PROVIDER_H_

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "mojo/public/cpp/bindings/remote.h"
#include "net/proxy_resolution/proxy_config.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "services/network/public/mojom/proxy_config.mojom.h"

namespace content {
class BrowserContext;
}  // namespace content

namespace agent_kernel {

enum class RouteMode {
  // All traffic must traverse the configured VPN/tunnel; drop traffic if down.
  kStrictTunnel,
  // Explicitly ignore OS proxy settings and connect directly.
  kDirectOnly,
  // Custom proxy + bypass rules without hard Kill-Switch.
  kCustom,
};

struct TunnelConfig {
  std::string scope = "browser";  // "browser" or "space:<spaceId>"
  RouteMode mode = RouteMode::kDirectOnly;
  // e.g. "socks5://127.0.0.1:10808", "https://...", or "unix:///path/to.sock"
  std::optional<std::string> endpoint;
  std::optional<std::string> doh_server;
  std::vector<std::string> bypass_list = {"localhost", "127.0.0.1"};
  std::string webrtc_policy = "disable_non_proxied_udp";
  bool fail_closed = true;
};

struct TunnelStatus {
  TunnelConfig config;
  bool os_proxy_disabled = true;
  bool tunnel_healthy = true;
};

// Decouples Chromium NetworkContext proxy/DNS/WebRTC routing from host OS
// network settings so an external or managed sidecar VPN controls egress.
class NetworkTunnelProvider {
 public:
  static NetworkTunnelProvider* GetGlobalInstance();
  static void SetGlobalInstance(NetworkTunnelProvider* instance);

  NetworkTunnelProvider();
  NetworkTunnelProvider(const NetworkTunnelProvider&) = delete;
  NetworkTunnelProvider& operator=(const NetworkTunnelProvider&) = delete;
  ~NetworkTunnelProvider();

  // Hook called during NetworkContextParams construction (parallel to
  // TargetHandler::ApplyNetworkContextParamsOverrides) to detach OS proxy
  // tracking and bind our ProxyConfigClient remote.
  void ApplyToNetworkContextParams(
      content::BrowserContext* browser_context,
      network::mojom::NetworkContextParams* context_params);

  // Runtime hot-switch without restarting Chromium.
  bool SetTunnel(const TunnelConfig& config);
  void OnTunnelHealthChanged(const std::string& scope, bool healthy);
  void RegisterSpaceContextAlias(const std::string& space_id,
                                 const std::string& browser_context_unique_id);
  void RemoveSpaceScope(const std::string& space_id);
  bool CheckNetworkAllowedForSpace(const std::string& space_id) const;
  std::vector<TunnelStatus> GetStatus(
      const std::optional<std::string>& scope = std::nullopt) const;

 private:
  net::ProxyConfig BuildEffectiveProxyConfig(const TunnelStatus& status) const;
  void PushProxyConfigIfBound(const std::string& scope,
                              const TunnelStatus& status);

  std::map<std::string, TunnelStatus> routes_;
  std::map<std::string, std::string> context_id_to_space_scope_;
  std::map<std::string, std::string> space_scope_to_context_id_;
  std::map<std::string, mojo::Remote<network::mojom::ProxyConfigClient>>
      proxy_clients_;
};

}  // namespace agent_kernel

#endif  // CHROME_BROWSER_AGENT_KERNEL_NETWORK_TUNNEL_PROVIDER_H_
