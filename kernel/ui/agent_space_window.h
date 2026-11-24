#ifndef CHROME_BROWSER_AGENT_KERNEL_UI_AGENT_SPACE_WINDOW_H_
#define CHROME_BROWSER_AGENT_KERNEL_UI_AGENT_SPACE_WINDOW_H_

#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/view.h"

class Profile;

namespace content {
class WebContents;
}  // namespace content

namespace agent_kernel::ui {

// Dedicated expandable Agent Space window completely separate from personal
// Browser windows and TabStripModels.
// Supports:
//  - Zero-copy WebContents hot-mount via views::WebView::SetWebContents()
//  - Live observation (USER_OBSERVING) and automatic promotion to USER_ACTIVE
//    when the user directly interacts with the mounted page
//  - One-click collapse back to AgentDockButton (unmounting WebView while
//    preserving WebContents background execution and JS/DOM state)
class AgentSpaceWindow : public views::View {
 public:
  using InteractionCallback =
      base::RepeatingCallback<void(const std::string& page_id)>;

  AgentSpaceWindow(Profile* profile,
                   InteractionCallback on_user_interacted,
                   base::RepeatingClosure on_collapse_requested);
  AgentSpaceWindow(const AgentSpaceWindow&) = delete;
  AgentSpaceWindow& operator=(const AgentSpaceWindow&) = delete;
  ~AgentSpaceWindow() override;

  // Hot-mounts an Agent-owned WebContents without copying or reloading.
  void AttachWebContents(const std::string& page_id,
                         content::WebContents* web_contents);

  // Detaches the WebContents safely back to background execution before
  // hiding/collapsing the window so WebView never destroys the WebContents.
  void DetachWebContents();

  const std::string& mounted_page_id() const { return mounted_page_id_; }

  // views::View:
  void OnMouseEvent(::ui::MouseEvent* event) override;
  void OnKeyEvent(::ui::KeyEvent* event) override;

 private:
  void NotifyDirectUserInteraction();

  raw_ptr<views::WebView> web_view_ = nullptr;
  std::string mounted_page_id_;
  InteractionCallback on_user_interacted_;
  base::RepeatingClosure on_collapse_requested_;
};

}  // namespace agent_kernel::ui

#endif  // CHROME_BROWSER_AGENT_KERNEL_UI_AGENT_SPACE_WINDOW_H_
