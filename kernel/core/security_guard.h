#ifndef CHROME_BROWSER_AGENT_KERNEL_CORE_SECURITY_GUARD_H_
#define CHROME_BROWSER_AGENT_KERNEL_CORE_SECURITY_GUARD_H_

#include <string>
#include <string_view>

namespace agent_kernel::core {

enum class SecurityVerdict {
  kAllow,
  kDenyDomain,
  kRequireHumanTakeover,
};

struct SecurityDecision {
  SecurityVerdict verdict = SecurityVerdict::kAllow;
  std::string reason;
  std::string message;

  bool Allowed() const { return verdict == SecurityVerdict::kAllow; }
};

// Hard-blocks internal browser URLs (chrome://password-manager,
// chrome://settings/payments, chrome://wallet, devtools://, chrome-extension://)
// and local filesystem access (file://) so AI Agents can NEVER open or read
// saved passwords, saved payment methods, or profile SQLite files.
SecurityDecision CheckAgentUrlPolicy(std::string_view raw_url);

// Returns true when the URL corresponds to a payment checkout, card/billing
// entry, or password-management flow that requires mandatory human control.
bool IsSensitivePaymentOrCredentialUrl(std::string_view raw_url);

// Evaluates a CDP command against the kernel credential/payment firewall.
//  - Hard-denies Autofill.*, WebAuthn.*, FedCm.*, Browser.*, FileSystem.*, IO.*,
//    DOM.setFileInputFiles, and internal/file Page.navigate targets.
//  - Forces USER_ACTIVE human takeover (ERR_SENSITIVE_ACTION_REQUIRES_HUMAN)
//    whenever a password input is focused in Blink, the page is a payment/auth
//    flow, or the CDP payload targets password/credit-card/credential fields.
SecurityDecision CheckCdpPolicy(std::string_view cdp_method,
                                std::string_view cdp_params_json,
                                std::string_view current_page_url,
                                bool password_field_focused);

}  // namespace agent_kernel::core

#endif  // CHROME_BROWSER_AGENT_KERNEL_CORE_SECURITY_GUARD_H_
