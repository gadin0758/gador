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

int HexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

// Decode JSON string escapes (including \u00XX ASCII Unicode escapes) so
// bypasses like "\u0063hrome://..." or "\u0070assword" cannot evade checks.
std::string DecodeJsonEscapes(std::string_view input) {
  std::string out;
  out.reserve(input.size());
  for (size_t i = 0; i < input.size(); ++i) {
    if (input[i] == '\\' && i + 1 < input.size()) {
      char next = input[i + 1];
      if (next == 'u' && i + 5 < input.size()) {
        int h0 = HexValue(input[i + 2]);
        int h1 = HexValue(input[i + 3]);
        int h2 = HexValue(input[i + 4]);
        int h3 = HexValue(input[i + 5]);
        if (h0 >= 0 && h1 >= 0 && h2 >= 0 && h3 >= 0) {
          unsigned int codepoint = (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
          if (codepoint <= 0x7F) {
            out.push_back(static_cast<char>(codepoint));
          }
          i += 5;
          continue;
        }
      }
      switch (next) {
        case '"': out.push_back('"'); ++i; continue;
        case '\\': out.push_back('\\'); ++i; continue;
        case '/': out.push_back('/'); ++i; continue;
        case 't': out.push_back('\t'); ++i; continue;
        case 'r': out.push_back('\r'); ++i; continue;
        case 'n': out.push_back('\n'); ++i; continue;
        default: break;
      }
    }
    out.push_back(input[i]);
  }
  return out;
}

// Strip all ASCII control chars and whitespace before URL scheme comparison
// (blocks browsers' lenient parsing of "java\tscript:", "ch\nrome://", etc.).
std::string NormalizeUrlForPolicy(std::string_view raw_url) {
  std::string decoded = DecodeJsonEscapes(raw_url);
  std::string out;
  out.reserve(decoded.size());
  for (unsigned char c : decoded) {
    if (c <= 0x20 || c == 0x7F) {
      continue;
    }
    out.push_back(static_cast<char>(std::tolower(c)));
  }
  return out;
}

// Normalize JS/DOM payloads by decoding nested escapes, lowercasing, and
// stripping whitespace/quotes so `type = "\u0070assword"` normalizes to `type=password`.
std::string NormalizePayloadForSensitiveCheck(std::string_view raw_json) {
  // Decode twice to catch JSON-encoded JS strings like "\\u0070assword"
  std::string d1 = DecodeJsonEscapes(raw_json);
  std::string d2 = DecodeJsonEscapes(d1);
  std::string compact;
  compact.reserve(d2.size());
  for (unsigned char c : d2) {
    if (std::isspace(c) || c == '"' || c == '\'' || c == '`') {
      continue;
    }
    compact.push_back(static_cast<char>(std::tolower(c)));
  }
  return compact;
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
  std::string raw_value;
  while (pos < json.size()) {
    char c = json[pos++];
    if (c == '\\' && pos < json.size()) {
      raw_value.push_back(c);
      raw_value.push_back(json[pos++]);
      continue;
    }
    if (c == '"') {
      return DecodeJsonEscapes(raw_value);
    }
    raw_value.push_back(c);
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
  std::string url = NormalizeUrlForPolicy(raw_url);
  if (url.empty() || url == "about:blank") {
    return {};
  }

  // Strip nested view-source: wrappers to prevent bypasses like
  // view-source:chrome://password-manager or view-source:file:///...
  while (StartsWith(url, "view-source:")) {
    url.erase(0, 12);
  }

  static constexpr std::array<std::string_view, 12> kBlockedPrefixes = {
      "chrome://",
      "chrome-untrusted://",
      "chrome-extension://",
      "chrome-search://",
      "chrome-error://",
      "devtools://",
      "file://",
      "filesystem:",
      "blob:chrome://",
      "blob:file://",
      "data:text/html",
      "data:image/svg+xml",
  };

  for (std::string_view prefix : kBlockedPrefixes) {
    if (StartsWith(url, prefix)) {
      return {
          SecurityVerdict::kDenyDomain,
          "blocked_internal_or_local_scheme",
          "Access to browser internals, password/payment storage, executable "
          "data documents, and local files is strictly forbidden for AI Agents",
      };
    }
  }

  if (StartsWith(url, "javascript:") || StartsWith(url, "vbscript:") ||
      StartsWith(url, "data:application/xhtml")) {
    return {
        SecurityVerdict::kDenyDomain,
        "blocked_javascript_navigation",
        "Direct script/active-document navigation URLs are blocked for AI Agents",
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
  //    WebAuthn/Passkeys, FedCM, local files, script injection, interception,
  //    debugger inspection, or browser-level targets.
  static constexpr std::array<std::string_view, 10> kBlockedDomains = {
      "Autofill.",
      "WebAuthn.",
      "FedCm.",
      "Browser.",
      "FileSystem.",
      "IO.",
      "SystemInfo.",
      "Tethering.",
      "Debugger.",
      "Fetch.",
  };
  for (std::string_view dom : kBlockedDomains) {
    if (StartsWith(cdp_method, dom)) {
      return {
          SecurityVerdict::kDenyDomain,
          "blocked_sensitive_cdp_domain",
          "CDP domain is blocked to protect saved passwords, payment methods, "
          "passkeys, network interception, and local files",
      };
    }
  }

  if (cdp_method == "DOM.setFileInputFiles" ||
      cdp_method == "Target.createTarget" ||
      cdp_method == "Target.attachToTarget" ||
      cdp_method == "Target.attachToBrowserTarget" ||
      cdp_method == "Target.exposeDevToolsProtocol" ||
      cdp_method == "Storage.getSharedStorageEntries" ||
      cdp_method == "Page.addScriptToEvaluateOnNewDocument" ||
      cdp_method == "Page.setDocumentContent" ||
      cdp_method == "Page.createIsolatedWorld") {
    return {
        SecurityVerdict::kDenyDomain,
        "blocked_sensitive_cdp_method",
        "CDP method is blocked to protect local files, script injection, and "
        "browser internals",
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
  //    password/credit-card/PaymentRequest/WebAuthn interaction (escape- & whitespace-resistant).
  if (cdp_method == "Runtime.evaluate" ||
      cdp_method == "Runtime.callFunctionOn" ||
      cdp_method == "DOM.setAttributeValue" ||
      cdp_method == "DOM.setAttributesAsText" ||
      cdp_method == "DOM.setNodeValue") {
    std::string compact_params = NormalizePayloadForSensitiveCheck(cdp_params_json);
    if (ContainsAny(compact_params, {
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
