#include "chrome/browser/agent_kernel/agent_web_contents_delegate.h"

#include <map>
#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/agent_kernel/agent_space_manager.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/javascript_dialog_manager.h"
#include "content/public/browser/media_stream_request.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"
#include "url/gurl.h"

namespace agent_kernel {

namespace {

std::string DialogTypeToString(content::JavaScriptDialogType type) {
  switch (type) {
    case content::JAVASCRIPT_DIALOG_TYPE_ALERT:
      return "alert";
    case content::JAVASCRIPT_DIALOG_TYPE_CONFIRM:
      return "confirm";
    case content::JAVASCRIPT_DIALOG_TYPE_PROMPT:
      return "prompt";
  }
  return "alert";
}

}  // namespace

// Non-blocking JavaScriptDialogManager that retains open dialog callbacks
// across UDS client disconnects/reconnects without stealing focus or flipping
// AgentSpace ownership to USER_ACTIVE.
class AgentWebContentsDelegate::AgentJavaScriptDialogManager
    : public content::JavaScriptDialogManager {
 public:
  struct PendingDialog {
    PendingDialogInfo info;
    DialogClosedCallback callback;
  };

  explicit AgentJavaScriptDialogManager(AgentSpaceManager* manager)
      : manager_(manager) {}

  ~AgentJavaScriptDialogManager() override {
    for (auto& [wc, pending] : pending_) {
      if (pending.callback) {
        std::move(pending.callback).Run(false, std::u16string());
      }
    }
    pending_.clear();
  }

  void RunJavaScriptDialog(content::WebContents* web_contents,
                           content::RenderFrameHost* /*render_frame_host*/,
                           content::JavaScriptDialogType dialog_type,
                           const std::u16string& message_text,
                           const std::u16string& default_prompt_text,
                           DialogClosedCallback callback,
                           bool* did_suppress_message) override {
    *did_suppress_message = false;
    CancelDialogs(web_contents, /*reset_state=*/false);
    PendingDialogInfo info;
    info.type = DialogTypeToString(dialog_type);
    info.message = base::UTF16ToUTF8(message_text);
    info.default_prompt = base::UTF16ToUTF8(default_prompt_text);
    info.url = web_contents ? web_contents->GetLastCommittedURL().spec() : "";
    pending_[web_contents] = PendingDialog{info, std::move(callback)};
    if (manager_) {
      manager_->NotifyDialogOpened(web_contents, info);
    }
  }

  void RunBeforeUnloadDialog(content::WebContents* web_contents,
                             content::RenderFrameHost* /*render_frame_host*/,
                             bool /*is_reload*/,
                             DialogClosedCallback callback) override {
    CancelDialogs(web_contents, /*reset_state=*/false);
    PendingDialogInfo info;
    info.type = "beforeunload";
    info.message = "beforeunload";
    info.default_prompt = "";
    info.url = web_contents ? web_contents->GetLastCommittedURL().spec() : "";
    pending_[web_contents] = PendingDialog{info, std::move(callback)};
    if (manager_) {
      manager_->NotifyDialogOpened(web_contents, info);
    }
  }

  bool HandleJavaScriptDialog(content::WebContents* web_contents,
                              bool accept,
                              const std::u16string* prompt_override) override {
    std::optional<std::string> prompt_utf8;
    if (prompt_override) {
      prompt_utf8 = base::UTF16ToUTF8(*prompt_override);
    }
    return HandleWithType(web_contents, accept, prompt_utf8, nullptr);
  }

  bool HandleWithType(content::WebContents* web_contents,
                      bool accept,
                      const std::optional<std::string>& prompt_text,
                      std::string* out_dialog_type) {
    auto it = pending_.find(web_contents);
    if (it == pending_.end()) {
      return false;
    }
    const std::string dtype = it->second.info.type;
    std::u16string input =
        prompt_text.has_value()
            ? base::UTF8ToUTF16(*prompt_text)
            : base::UTF8ToUTF16(it->second.info.default_prompt);
    DialogClosedCallback cb = std::move(it->second.callback);
    pending_.erase(it);
    if (out_dialog_type) {
      *out_dialog_type = dtype;
    }
    if (cb) {
      std::move(cb).Run(accept, input);
    }
    return true;
  }

  bool HasOpenDialog(content::WebContents* web_contents) const {
    return pending_.find(web_contents) != pending_.end();
  }

  std::optional<PendingDialogInfo> GetOpenDialogInfo(
      content::WebContents* web_contents) const {
    auto it = pending_.find(web_contents);
    if (it == pending_.end()) {
      return std::nullopt;
    }
    return it->second.info;
  }

  void CancelDialogs(content::WebContents* web_contents,
                     bool /*reset_state*/) override {
    auto it = pending_.find(web_contents);
    if (it == pending_.end()) {
      return;
    }
    DialogClosedCallback cb = std::move(it->second.callback);
    pending_.erase(it);
    if (cb) {
      std::move(cb).Run(false, std::u16string());
    }
  }

 private:
  raw_ptr<AgentSpaceManager> manager_;
  std::map<content::WebContents*, PendingDialog> pending_;
};

AgentWebContentsDelegate::AgentWebContentsDelegate(AgentSpaceManager* manager)
    : manager_(manager),
      dialog_manager_(
          std::make_unique<AgentJavaScriptDialogManager>(manager)) {}

AgentWebContentsDelegate::~AgentWebContentsDelegate() = default;

bool AgentWebContentsDelegate::HandleOpenDialog(
    content::WebContents* web_contents,
    bool accept,
    const std::optional<std::string>& prompt_text,
    std::string* out_dialog_type) {
  return dialog_manager_->HandleWithType(web_contents, accept, prompt_text,
                                         out_dialog_type);
}

bool AgentWebContentsDelegate::HasOpenDialog(
    content::WebContents* web_contents) const {
  return dialog_manager_->HasOpenDialog(web_contents);
}

std::optional<PendingDialogInfo> AgentWebContentsDelegate::GetOpenDialogInfo(
    content::WebContents* web_contents) const {
  return dialog_manager_->GetOpenDialogInfo(web_contents);
}

void AgentWebContentsDelegate::ClearDialogsForWebContents(
    content::WebContents* web_contents) {
  dialog_manager_->CancelDialogs(web_contents, /*reset_state=*/true);
}

content::WebContents* AgentWebContentsDelegate::OpenURLFromTab(
    content::WebContents* source,
    const content::OpenURLParams& params,
    base::OnceCallback<void(content::NavigationHandle&)>
        navigation_handle_callback) {
  if (!source) {
    return nullptr;
  }
  // Keep navigation inside the AgentSpace WebContents rather than escaping into
  // a personal Browser window.
  content::NavigationController::LoadURLParams load_params(params);
  base::WeakPtr<content::NavigationHandle> handle =
      source->GetController().LoadURLWithParams(load_params);
  if (navigation_handle_callback && handle) {
    std::move(navigation_handle_callback).Run(*handle);
  }
  return source;
}

content::WebContents* AgentWebContentsDelegate::AddNewContents(
    content::WebContents* source,
    std::unique_ptr<content::WebContents> new_contents,
    const GURL& target_url,
    WindowOpenDisposition /*disposition*/,
    const blink::mojom::WindowFeatures& /*window_features*/,
    bool /*user_gesture*/,
    bool* was_blocked) {
  if (was_blocked) {
    *was_blocked = false;
  }
  if (!source || !new_contents || !manager_) {
    return nullptr;
  }
  // Capture popup inside the owning AgentSpace; never escape to personal UI.
  return manager_->CapturePopupWebContents(source, std::move(new_contents),
                                           target_url.spec());
}

void AgentWebContentsDelegate::CloseContents(content::WebContents* source) {
  if (manager_ && source) {
    manager_->CloseWebContents(source);
  }
}

content::JavaScriptDialogManager*
AgentWebContentsDelegate::GetJavaScriptDialogManager(
    content::WebContents* /*source*/) {
  return dialog_manager_.get();
}

void AgentWebContentsDelegate::RunFileChooser(
    content::RenderFrameHost* /*render_frame_host*/,
    scoped_refptr<content::FileSelectListener> listener,
    const blink::mojom::FileChooserParams& /*params*/) {
  // Never spawn an OS native file picker that steals focus from the user.
  if (listener) {
    listener->FileSelectionCanceled();
  }
}

void AgentWebContentsDelegate::RequestMediaAccessPermission(
    content::WebContents* /*web_contents*/,
    const content::MediaStreamRequest& /*request*/,
    content::MediaResponseCallback callback) {
  // Deny automatic camera/mic grant in background; require explicit human
  // takeover before granting sensitive hardware permissions.
  if (callback) {
    std::move(callback).Run(
        blink::mojom::StreamDevicesSet(),
        blink::mojom::MediaStreamRequestResult::PERMISSION_DENIED,
        /*ui=*/nullptr);
  }
}

}  // namespace agent_kernel
