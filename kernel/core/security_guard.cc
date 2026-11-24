#include "security_guard.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <string>
#include <string_view>

namespace agent_kernel::core {

namespace {

std::string ToLowerTrimmed(std::string_view input) {
  size_t start = 0;
  while (start < input.size() &&
         std::isspace(static_cast<unsigned char>(input[start]))) {
    ++start;
  }
  size_t end = input.size();
  while (end > start &&
         std::isspace(static_cast<unsigned char>(input[end - 1]))) {
    --end;
  }
  std::string out;
  out.reserve(end - start);
  for (size_t i = start; i < end; ++i) {
    out.push_back(
        static_cast<char>(std::tolower(static_cast<unsigned char>(input[i]))));
  }
  return out;
}

bool StartsWith(std::string_view s, std::string_view prefix) {
  return s.size() >= prefix.size() && s.substr(0, prefix.size()) == prefix;
}

bool ContainsAny(std::string_view haystack,
                 const std::initializer_list<std::string_view>& needles) {
  for (std::string_view n : needles) {
    if (haystack.find(n) != std::string_view::npos) {
      return true;
    }
  }
  return false;
}

// Lightweight JSON string field extractor for checking `"url":"..."` in
// Page.navigate parameters without external dependencies.
std::string ExtractJsonStringField(std::string_view json,
                                   std::string_view key) {
  std::string needle = "\"";
  needle.append(key);
  needle.push_back('"');
  size_t pos = json.find(needle);
  if (pos == std::string_view::npos) {
    return "";
  }
  pos = json.find(':', pos + needle.size());
  if (pos == std::string_view::npos) {
    return "";
  }
  ++pos;
  while (pos < json.size() &&
         std::isspace(static_cast<unsigned char>(json[pos]))) {
    ++pos;
  }
  if (pos >= json.size() || json[pos] != '"') {
    return "";
  }
  ++pos;
  std::string value;
  while (pos < json.size()) {
    char c = json[pos++];
    if (c == '\\' && pos < json.size()) {
      value.push_back(json[pos++]);
      continue;
    }
    if (c == '"') {
      return value;
    }
    value.push_back(c);
  }
  return "";
}

bool IsMutatingOrInspectingCdpMethod(std::string_view method) {
  return StartsWith(method, "Input.") ||
         StartsWith(method, "Runtime.") ||
         StartsWith(method, "DOM.") ||
         method == "Page.captureScreenshot" ||
         method == "Page.startScreencast";
}

bool IsMutatingCdpMethod(std::string_view method) {
  return StartsWith(method, "Input.") ||
         method == "Runtime.evaluate" ||
         method == "Runtime.callFunctionOn" ||
         method == "DOM.focus" ||
         method == "DOM.setAttributeValue" ||
         method == "DOM.setAttributesAsText" ||
         method == "DOM.setNodeValue" ||
         method == "DOM.setOuterHTML";
}

}  // namespace

SecurityDecision CheckAgentUrlPolicy(std::string_view raw_url) {
  std::string url = ToLowerTrimmed(raw_url);
  if (url.empty() || url == "about:blank") {
    return {};
  }

  // Strip nested view-source: wrappers to prevent bypasses like
  // view-source:chrome://password-manager or view-source:file:///...
  while (StartsWith(url, "view-source:")) {
    url.erase(0, 12);
  }

  static constexpr std::array<std::string_view, 9> kBlockedPrefixes = {
      "chrome://",
      "chrome-untrusted://",
      "chrome-extension://",
      "chrome-search://",
      "devtools://",
      "file://",
      "filesystem:",
      "blob:chrome://",
      "blob:file://",
  };

  for (std::string_view prefix : kBlockedPrefixes) {
    if (StartsWith(url, prefix)) {
      return {
          SecurityVerdict::kDenyDomain,
          "blocked_internal_or_local_scheme",
          "Access to browser internals, password/payment storage, and local "
          "files is strictly forbidden for AI Agents",
      };
    }
  }

  if (StartsWith(url, "javascript:")) {
    return {
        SecurityVerdict::kDenyDomain,
        "blocked_javascript_navigation",
        "Direct javascript: navigation URLs are blocked for AI Agents",
    };
  }

  return {};
}

bool IsSensitivePaymentOrCredentialUrl(std::string_view raw_url) {
  std::string url = ToLowerTrimmed(raw_url);
  if (url.empty() || url == "about:blank" || StartsWith(url, "data:")) {
    return false;
  }

  // Strip query & fragment for host/path inspection while keeping host+path.
  size_t qpos = url.find_first_of("?#");
  std::string_view base = (qpos == std::string_view::npos)
                              ? std::string_view(url)
                              : std::string_view(url).substr(0, qpos);

  // Known dedicated payment/wallet hosts.
  if (ContainsAny(base, {
                            "://checkout.stripe.com",
                            "://billing.stripe.com",
                            "://pay.google.com",
                            "://payments.google.com",
                            "://checkout.paypal.com",
                            "://cashier.alipay.com",
                            "://pay.weixin.qq.com",
                            "://wx.tenpay.com",
                            "://checkout.shopify.com",
                        })) {
    return true;
  }

  // Extract path portion after scheme://host.
  size_t scheme_end = base.find("://");
  if (scheme_end == std::string_view::npos) {
    return false;
  }
  size_t path_start = base.find('/', scheme_end + 3);
  if (path_start == std::string_view::npos) {
    return false;
  }
  std::string_view path = base.substr(path_start);

  return ContainsAny(path, {
                               "/checkout",
                               "/payment",
                               "/payments",
                               "/billing",
                               "/pay/",
                               "/wallet",
                               "/credit-card",
                               "/add-card",
                               "/password",
                               "/passwords",
                               "/change-password",
                               "/reset-password",
                           });
}

SecurityDecision CheckCdpPolicy(std::string_view cdp_method,
                                std::string_view cdp_params_json,
                                std::string_view current_page_url,
                                bool password_field_focused) {
  // 1. Hard-deny CDP domains and methods that touch Autofill cards/addresses,
  //    WebAuthn/Passkeys, FedCM, local files, or browser-level targets.
  static constexpr std::array<std::string_view, 8> kBlockedDomains = {
      "Autofill.",
      "WebAuthn.",
      "FedCm.",
      "Browser.",
      "FileSystem.",
      "IO.",
      "SystemInfo.",
      "Tethering.",
  };
  for (std::string_view dom : kBlockedDomains) {
    if (StartsWith(cdp_method, dom)) {
      return {
          SecurityVerdict::kDenyDomain,
          "blocked_sensitive_cdp_domain",
          "CDP domain is blocked to protect saved passwords, payment methods, "
          "passkeys, and local files",
      };
    }
  }

  if (cdp_method == "DOM.setFileInputFiles" ||
      cdp_method == "Target.createTarget" ||
      cdp_method == "Target.attachToBrowserTarget" ||
      cdp_method == "Target.exposeDevToolsProtocol" ||
      cdp_method == "Storage.getSharedStorageEntries") {
    return {
        SecurityVerdict::kDenyDomain,
        "blocked_sensitive_cdp_method",
        "CDP method is blocked to protect local files and browser internals",
    };
  }

  // 2. Enforce URL policy on Page.navigate targets.
  if (cdp_method == "Page.navigate") {
    std::string target_url = ExtractJsonStringField(cdp_params_json, "url");
    if (!target_url.empty()) {
      auto url_decision = CheckAgentUrlPolicy(target_url);
      if (!url_decision.Allowed()) {
        return url_decision;
      }
    }
  }

  // 3. Real Blink password-input focus guard: if a password field is currently
  //    focused, force immediate human takeover before any input/DOM/JS/capture.
  if (password_field_focused && IsMutatingOrInspectingCdpMethod(cdp_method)) {
    return {
        SecurityVerdict::kRequireHumanTakeover,
        "password_input_requires_human",
        "Password input detected; space locked into USER_ACTIVE for mandatory "
        "human operation",
    };
  }

  // 4. Sensitive payment/checkout/password page guard for mutating commands.
  if (IsMutatingCdpMethod(cdp_method) &&
      IsSensitivePaymentOrCredentialUrl(current_page_url)) {
    return {
        SecurityVerdict::kRequireHumanTakeover,
        "payment_or_credential_page_requires_human",
        "Payment or password page detected; space locked into USER_ACTIVE for "
        "mandatory human operation",
    };
  }

  // 5. Payload inspection on JS evaluation & DOM mutation to block scripted
  //    password/credit-card/PaymentRequest/WebAuthn interaction.
  if (cdp_method == "Runtime.evaluate" ||
      cdp_method == "Runtime.callFunctionOn" ||
      cdp_method == "DOM.setAttributeValue" ||
      cdp_method == "DOM.setAttributesAsText" ||
      cdp_method == "DOM.setNodeValue") {
    std::string lower_params = ToLowerTrimmed(cdp_params_json);
    if (ContainsAny(lower_params, {
                                      "type=\\\"password\\\"",
                                      "type=\\'password\\'",
                                      "type=\"password\"",
                                      "type='password'",
                                      "type=password",
                                      "current-password",
                                      "new-password",
                                      "cc-number",
                                      "cc-csc",
                                      "cc-exp",
                                      "cc-name",
                                      "navigator.credentials",
                                      "paymentrequest",
                                      "creditcard",
                                      "card_number",
                                      "cardnumber",
                                  })) {
      return {
          SecurityVerdict::kRequireHumanTakeover,
          "credential_or_payment_field_requires_human",
          "Password, credential, or payment field interaction is forbidden for "
          "AI Agents; space locked into USER_ACTIVE for human operation",
      };
    }
  }

  return {};
}

}  // namespace agent_kernel::core
