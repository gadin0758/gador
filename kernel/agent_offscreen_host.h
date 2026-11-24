#ifndef CHROME_BROWSER_AGENT_KERNEL_AGENT_OFFSCREEN_HOST_H_
#define CHROME_BROWSER_AGENT_KERNEL_AGENT_OFFSCREEN_HOST_H_

#include <memory>

#include "ui/gfx/geometry/size.h"

namespace content {
class WebContents;
}  // namespace content

namespace agent_kernel {

// Clean-room offscreen compositing host for detached Agent WebContents.
// On Aura (Linux X11/Wayland), attaches the hidden WebContents native view to
// an invisible WindowTreeHost backed by a null AcceleratedWidget (Viz
// SkiaOutputDeviceOffscreen), enabling full Blink/Viz screenshot & screencast
// capture in windowless daemon mode without creating or showing any OS window.
class AgentOffscreenHost {
 public:
  explicit AgentOffscreenHost(const gfx::Size& viewport);
  AgentOffscreenHost(const AgentOffscreenHost&) = delete;
  AgentOffscreenHost& operator=(const AgentOffscreenHost&) = delete;
  ~AgentOffscreenHost();

  void AdoptWebContents(content::WebContents* web_contents,
                        const gfx::Size& viewport);
  void Resize(const gfx::Size& viewport);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace agent_kernel

#endif  // CHROME_BROWSER_AGENT_KERNEL_AGENT_OFFSCREEN_HOST_H_
