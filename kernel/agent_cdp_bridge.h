#ifndef CHROME_BROWSER_AGENT_KERNEL_AGENT_CDP_BRIDGE_H_
#define CHROME_BROWSER_AGENT_KERNEL_AGENT_CDP_BRIDGE_H_

#include <map>
#include <string>

#include "base/containers/span.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"

namespace agent_kernel {

class AgentSpaceManager;

// In-process trusted DevToolsAgentHostClient scoped strictly to Agent-owned
// WebContents. Does NOT open a TCP debugging port, does NOT trigger the global
// remote-debugging infobar, and never enables Runtime.enable by default.
class AgentCdpBridge : public content::DevToolsAgentHostClient {
 public:
  using MessageCallback =
      base::RepeatingCallback<void(const std::string& page_id,
                                   base::span<const uint8_t> payload)>;

  AgentCdpBridge(AgentSpaceManager* manager, MessageCallback on_message);
  AgentCdpBridge(const AgentCdpBridge&) = delete;
  AgentCdpBridge& operator=(const AgentCdpBridge&) = delete;
  ~AgentCdpBridge() override;

  bool EnsureAttached(const std::string& page_id);
  void Detach(const std::string& page_id);
  bool DispatchMessage(const std::string& page_id,
                       base::span<const uint8_t> message);

  // content::DevToolsAgentHostClient:
  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override;
  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override;
  bool MayAttachToRenderFrameHost(
      content::RenderFrameHost* render_frame_host) override;
  bool IsTrusted() override;
  bool MayReadLocalFiles() override;
  bool MayWriteLocalFiles() override;

 private:
  raw_ptr<AgentSpaceManager> manager_;
  MessageCallback on_message_;
  std::map<std::string, scoped_refptr<content::DevToolsAgentHost>> attached_;
};

}  // namespace agent_kernel

#endif  // CHROME_BROWSER_AGENT_KERNEL_AGENT_CDP_BRIDGE_H_
