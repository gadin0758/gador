#ifndef CHROME_BROWSER_AGENT_KERNEL_AGENT_WEB_CONTENTS_DELEGATE_H_
#define CHROME_BROWSER_AGENT_KERNEL_AGENT_WEB_CONTENTS_DELEGATE_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "content/public/browser/web_contents_delegate.h"

namespace agent_kernel {

class AgentSpaceManager;

struct PendingDialogInfo {
  std::string type;  // alert | confirm | prompt | beforeunload
  std::string message;
  std::string default_prompt;
  std::string url;
};

// WebContentsDelegate attached to all Agent-owned WebContents.
// Guarantees:
//  1. window.open / target="_blank" popups stay inside the owning AgentSpace
//     and never escape into personal Browser windows.
//  2. alert/confirm/prompt/beforeunload dialogs are handled without blocking
//     CDP sessions or losing state across client reconnects.
//  3. Sensitive hardware/media permissions suspend and request human takeover.
class AgentWebContentsDelegate : public content::WebContentsDelegate {
 public:
  explicit AgentWebContentsDelegate(AgentSpaceManager* manager);
  AgentWebContentsDelegate(const AgentWebContentsDelegate&) = delete;
  AgentWebContentsDelegate& operator=(const AgentWebContentsDelegate&) = delete;
  ~AgentWebContentsDelegate() override;

  // Live JS dialog governance invoked from control plane RPCs.
  bool HandleOpenDialog(content::WebContents* web_contents,
                        bool accept,
                        const std::optional<std::string>& prompt_text,
                        std::string* out_dialog_type);
  bool HasOpenDialog(content::WebContents* web_contents) const;
  std::optional<PendingDialogInfo> GetOpenDialogInfo(
      content::WebContents* web_contents) const;
  void ClearDialogsForWebContents(content::WebContents* web_contents);

  // content::WebContentsDelegate:
  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override;

  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override;

  void CloseContents(content::WebContents* source) override;

  content::JavaScriptDialogManager* GetJavaScriptDialogManager(
      content::WebContents* source) override;

  void RunFileChooser(
      content::RenderFrameHost* render_frame_host,
      scoped_refptr<content::FileSelectListener> listener,
      const blink::mojom::FileChooserParams& params) override;

  void RequestMediaAccessPermission(
      content::WebContents* web_contents,
      const content::MediaStreamRequest& request,
      content::MediaResponseCallback callback) override;

 private:
  class AgentJavaScriptDialogManager;

  raw_ptr<AgentSpaceManager> manager_;
  std::unique_ptr<AgentJavaScriptDialogManager> dialog_manager_;
};

}  // namespace agent_kernel

#endif  // CHROME_BROWSER_AGENT_KERNEL_AGENT_WEB_CONTENTS_DELEGATE_H_
