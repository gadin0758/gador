#ifndef CHROME_BROWSER_AGENT_KERNEL_AGENT_IPC_SERVER_H_
#define CHROME_BROWSER_AGENT_KERNEL_AGENT_IPC_SERVER_H_

#include <atomic>
#include <cstdint>
#include <future>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/containers/span.h"
#include "base/files/file_path.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"

class Profile;
class ScopedProfileKeepAlive;

namespace agent_kernel {

namespace core {
class UdsPosixServer;
}  // namespace core

class AgentCdpBridge;
class AgentSpaceManager;
class NetworkTunnelProvider;

// Browser-process ExtraParts hosting the 0600 Unix Domain Socket control plane
// ($XDG_RUNTIME_DIR/gador/ctl.sock) with SO_PEERCRED UID verification and
// uint32 BE length-prefixed JSON framing bridged onto Chromium's UI thread.
// Supports desktop windowless daemon mode (--agent-daemon / --no-startup-window /
// AGENT_KERNEL_DAEMON=1), keeping Chromium alive in the background with zero
// visible windows unless explicitly attached/expanded by the user.
class ChromeBrowserMainExtraPartsAgentKernel
    : public ChromeBrowserMainExtraParts {
 public:
  ChromeBrowserMainExtraPartsAgentKernel();
  ChromeBrowserMainExtraPartsAgentKernel(
      const ChromeBrowserMainExtraPartsAgentKernel&) = delete;
  ChromeBrowserMainExtraPartsAgentKernel& operator=(
      const ChromeBrowserMainExtraPartsAgentKernel&) = delete;
  ~ChromeBrowserMainExtraPartsAgentKernel() override;

  // ChromeBrowserMainExtraParts:
  void PostEarlyInitialization() override;
  void PostProfileInit(Profile* profile, bool is_initial_profile) override;
  void PostMainMessageLoopRun() override;

  const base::FilePath& socket_path() const { return socket_path_; }
  bool daemon_mode() const { return daemon_mode_; }
  NetworkTunnelProvider* network_tunnel_provider() {
    return network_tunnel_provider_.get();
  }

 private:
  struct PendingCdpCall {
    int64_t rpc_id = 0;
    std::string page_id;
    std::shared_ptr<std::promise<std::string>> promise;
  };

  // Called on POSIX UDS worker thread; bridges cleanly to Chromium UI thread.
  std::string HandleUdsRequestOnWorkerThread(const std::string& request_json);
  std::vector<std::string> BuildReconnectReplayEventsOnWorkerThread();

  // Executed strictly on Chromium UI thread.
  void DispatchRequestOnUiThread(
      const std::string& request_json,
      std::shared_ptr<std::promise<std::string>> reply_promise);
  void OnCdpMessageOnUiThread(const std::string& page_id,
                              base::span<const uint8_t> payload);
  void FailPendingCdpCallsForPageOnUiThread(const std::string& page_id);
  void FailAllPendingCdpCallsOnUiThread();

  base::FilePath socket_path_;
  bool daemon_mode_ = false;
  std::atomic<bool> shutting_down_{false};

  raw_ptr<Profile> profile_ = nullptr;
  raw_ptr<AgentSpaceManager> space_manager_ = nullptr;
  scoped_refptr<base::SequencedTaskRunner> ui_task_runner_;
  std::unique_ptr<NetworkTunnelProvider> network_tunnel_provider_;
  std::unique_ptr<AgentCdpBridge> cdp_bridge_;
  std::unique_ptr<core::UdsPosixServer> uds_server_;
  std::unique_ptr<ScopedKeepAlive> daemon_keep_alive_;
  std::unique_ptr<ScopedProfileKeepAlive> daemon_profile_keep_alive_;

  int64_t next_cdp_id_ = 1;
  std::map<int64_t, PendingCdpCall> pending_cdp_calls_;
};

}  // namespace agent_kernel

#endif  // CHROME_BROWSER_AGENT_KERNEL_AGENT_IPC_SERVER_H_
