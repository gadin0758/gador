#include "chrome/browser/agent_kernel/agent_cdp_bridge.h"

#include <utility>

#include "chrome/browser/agent_kernel/agent_space_manager.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace agent_kernel {

AgentCdpBridge::AgentCdpBridge(AgentSpaceManager* manager,
                               MessageCallback on_message)
    : manager_(manager), on_message_(std::move(on_message)) {}

AgentCdpBridge::~AgentCdpBridge() {
  for (auto& [page_id, host] : attached_) {
    if (host) {
      host->DetachClient(this);
    }
  }
  attached_.clear();
}

bool AgentCdpBridge::EnsureAttached(const std::string& page_id) {
  if (attached_.find(page_id) != attached_.end()) {
    return true;
  }
  content::WebContents* wc = manager_->GetWebContentsByPageId(page_id);
  if (!wc || !manager_->IsAgentOwnedWebContents(wc)) {
    return false;
  }
  scoped_refptr<content::DevToolsAgentHost> host =
      content::DevToolsAgentHost::GetOrCreateFor(wc);
  if (!host || !host->AttachClient(this)) {
    return false;
  }
  attached_.emplace(page_id, std::move(host));
  return true;
}

void AgentCdpBridge::Detach(const std::string& page_id) {
  auto it = attached_.find(page_id);
  if (it == attached_.end()) {
    return;
  }
  if (it->second) {
    it->second->DetachClient(this);
  }
  attached_.erase(it);
}

bool AgentCdpBridge::DispatchMessage(const std::string& page_id,
                                     base::span<const uint8_t> message) {
  if (!EnsureAttached(page_id)) {
    return false;
  }
  auto it = attached_.find(page_id);
  if (it == attached_.end() || !it->second) {
    return false;
  }
  it->second->DispatchProtocolMessage(this, message);
  return true;
}

void AgentCdpBridge::DispatchProtocolMessage(
    content::DevToolsAgentHost* agent_host,
    base::span<const uint8_t> message) {
  for (const auto& [page_id, host] : attached_) {
    if (host.get() == agent_host) {
      if (on_message_) {
        on_message_.Run(page_id, message);
      }
      return;
    }
  }
}

void AgentCdpBridge::AgentHostClosed(content::DevToolsAgentHost* agent_host) {
  for (auto it = attached_.begin(); it != attached_.end(); ++it) {
    if (it->second.get() == agent_host) {
      attached_.erase(it);
      return;
    }
  }
}

bool AgentCdpBridge::MayAttachToRenderFrameHost(
    content::RenderFrameHost* render_frame_host) {
  if (!render_frame_host) {
    return false;
  }
  content::WebContents* wc =
      content::WebContents::FromRenderFrameHost(render_frame_host);
  // Strict physical scope wall: personal browser tabs are NEVER inspectable.
  return manager_ && manager_->IsAgentOwnedWebContents(wc);
}

bool AgentCdpBridge::IsTrusted() {
  return true;
}

bool AgentCdpBridge::MayReadLocalFiles() {
  return false;
}

bool AgentCdpBridge::MayWriteLocalFiles() {
  return false;
}

}  // namespace agent_kernel
