#include "rpc_router.h"

#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <sstream>
#include <utility>
#include <variant>

#include "security_guard.h"

namespace agent_kernel::core {

namespace {

// Self-contained minimal JSON DOM (RFC 8259) with zero third-party dependencies.
struct JsonValue;
using JsonObject = std::map<std::string, JsonValue>;
using JsonArray = std::vector<JsonValue>;

struct JsonValue {
  using Storage =
      std::variant<std::nullptr_t, bool, double, std::string, JsonArray, JsonObject>;
  Storage data = nullptr;

  bool IsNull() const { return std::holds_alternative<std::nullptr_t>(data); }
  bool IsBool() const { return std::holds_alternative<bool>(data); }
  bool IsNumber() const { return std::holds_alternative<double>(data); }
  bool IsString() const { return std::holds_alternative<std::string>(data); }
  bool IsArray() const { return std::holds_alternative<JsonArray>(data); }
  bool IsObject() const { return std::holds_alternative<JsonObject>(data); }

  bool AsBool(bool def = false) const {
    return IsBool() ? std::get<bool>(data) : def;
  }
  double AsNumber(double def = 0.0) const {
    return IsNumber() ? std::get<double>(data) : def;
  }
  int64_t AsInt(int64_t def = 0) const {
    return IsNumber() ? static_cast<int64_t>(std::get<double>(data)) : def;
  }
  std::string AsString(const std::string& def = "") const {
    return IsString() ? std::get<std::string>(data) : def;
  }
  const JsonObject* AsObject() const {
    return IsObject() ? &std::get<JsonObject>(data) : nullptr;
  }
  const JsonArray* AsArray() const {
    return IsArray() ? &std::get<JsonArray>(data) : nullptr;
  }

  const JsonValue* Get(const std::string& key) const {
    const auto* obj = AsObject();
    if (!obj) return nullptr;
    auto it = obj->find(key);
    return it == obj->end() ? nullptr : &it->second;
  }
};

class JsonParser {
 public:
  explicit JsonParser(std::string_view src) : src_(src) {}

  bool Parse(JsonValue* out) {
    SkipWs();
    if (!ParseValue(out)) return false;
    SkipWs();
    return pos_ == src_.size();
  }

 private:
  void SkipWs() {
    while (pos_ < src_.size() &&
           std::isspace(static_cast<unsigned char>(src_[pos_]))) {
      ++pos_;
    }
  }

  bool ParseValue(JsonValue* out) {
    SkipWs();
    if (pos_ >= src_.size()) return false;
    char c = src_[pos_];
    if (c == '{') return ParseObject(out);
    if (c == '[') return ParseArray(out);
    if (c == '"') {
      std::string s;
      if (!ParseString(&s)) return false;
      out->data = std::move(s);
      return true;
    }
    if (c == 't' && src_.substr(pos_, 4) == "true") {
      pos_ += 4;
      out->data = true;
      return true;
    }
    if (c == 'f' && src_.substr(pos_, 5) == "false") {
      pos_ += 5;
      out->data = false;
      return true;
    }
    if (c == 'n' && src_.substr(pos_, 4) == "null") {
      pos_ += 4;
      out->data = nullptr;
      return true;
    }
    if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) {
      return ParseNumber(out);
    }
    return false;
  }

  bool ParseObject(JsonValue* out) {
    ++pos_;  // '{'
    JsonObject obj;
    SkipWs();
    if (pos_ < src_.size() && src_[pos_] == '}') {
      ++pos_;
      out->data = std::move(obj);
      return true;
    }
    while (pos_ < src_.size()) {
      SkipWs();
      std::string key;
      if (!ParseString(&key)) return false;
      SkipWs();
      if (pos_ >= src_.size() || src_[pos_] != ':') return false;
      ++pos_;
      JsonValue val;
      if (!ParseValue(&val)) return false;
      obj.emplace(std::move(key), std::move(val));
      SkipWs();
      if (pos_ >= src_.size()) return false;
      if (src_[pos_] == '}') {
        ++pos_;
        out->data = std::move(obj);
        return true;
      }
      if (src_[pos_] != ',') return false;
      ++pos_;
    }
    return false;
  }

  bool ParseArray(JsonValue* out) {
    ++pos_;  // '['
    JsonArray arr;
    SkipWs();
    if (pos_ < src_.size() && src_[pos_] == ']') {
      ++pos_;
      out->data = std::move(arr);
      return true;
    }
    while (pos_ < src_.size()) {
      JsonValue val;
      if (!ParseValue(&val)) return false;
      arr.push_back(std::move(val));
      SkipWs();
      if (pos_ >= src_.size()) return false;
      if (src_[pos_] == ']') {
        ++pos_;
        out->data = std::move(arr);
        return true;
      }
      if (src_[pos_] != ',') return false;
      ++pos_;
    }
    return false;
  }

  bool ParseString(std::string* out) {
    if (pos_ >= src_.size() || src_[pos_] != '"') return false;
    ++pos_;
    std::string s;
    while (pos_ < src_.size()) {
      char c = src_[pos_++];
      if (c == '"') {
        *out = std::move(s);
        return true;
      }
      if (c == '\\') {
        if (pos_ >= src_.size()) return false;
        char esc = src_[pos_++];
        switch (esc) {
          case '"': s.push_back('"'); break;
          case '\\': s.push_back('\\'); break;
          case '/': s.push_back('/'); break;
          case 'b': s.push_back('\b'); break;
          case 'f': s.push_back('\f'); break;
          case 'n': s.push_back('\n'); break;
          case 'r': s.push_back('\r'); break;
          case 't': s.push_back('\t'); break;
          case 'u': {
            if (pos_ + 4 > src_.size()) return false;
            unsigned int cp = 0;
            for (int i = 0; i < 4; ++i) {
              char h = src_[pos_++];
              cp <<= 4;
              if (h >= '0' && h <= '9') cp |= static_cast<unsigned int>(h - '0');
              else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned int>(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned int>(h - 'A' + 10);
              else return false;
            }
            if (cp < 0x80) {
              s.push_back(static_cast<char>(cp));
            } else if (cp < 0x800) {
              s.push_back(static_cast<char>(0xC0 | (cp >> 6)));
              s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else {
              s.push_back(static_cast<char>(0xE0 | (cp >> 12)));
              s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
              s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            }
            break;
          }
          default: return false;
        }
      } else {
        s.push_back(c);
      }
    }
    return false;
  }

  bool ParseNumber(JsonValue* out) {
    size_t start = pos_;
    if (src_[pos_] == '-') ++pos_;
    while (pos_ < src_.size() &&
           std::isdigit(static_cast<unsigned char>(src_[pos_]))) {
      ++pos_;
    }
    if (pos_ < src_.size() && src_[pos_] == '.') {
      ++pos_;
      while (pos_ < src_.size() &&
             std::isdigit(static_cast<unsigned char>(src_[pos_]))) {
        ++pos_;
      }
    }
    if (pos_ < src_.size() && (src_[pos_] == 'e' || src_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < src_.size() && (src_[pos_] == '+' || src_[pos_] == '-')) ++pos_;
      while (pos_ < src_.size() &&
             std::isdigit(static_cast<unsigned char>(src_[pos_]))) {
        ++pos_;
      }
    }
    std::string token(src_.substr(start, pos_ - start));
    char* end_ptr = nullptr;
    errno = 0;
    double value = std::strtod(token.c_str(), &end_ptr);
    if (errno == ERANGE || end_ptr != token.c_str() + token.size()) {
      return false;
    }
    out->data = value;
    return true;
  }

  std::string_view src_;
  size_t pos_ = 0;
};

std::string EscapeJson(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
  return out;
}

std::string MakeErrorReply(int64_t id,
                           const std::string& code,
                           const std::string& message) {
  std::ostringstream oss;
  oss << "{\"id\":" << id << ",\"error\":{\"code\":" << EscapeJson(code)
      << ",\"message\":" << EscapeJson(message) << "}}";
  return oss.str();
}

std::string MakeOkReply(int64_t id, const std::string& result_json) {
  std::ostringstream oss;
  oss << "{\"id\":" << id << ",\"result\":" << result_json << "}";
  return oss.str();
}

std::string SerializeSpace(const SpaceInfo& s) {
  std::ostringstream oss;
  oss << "{\"spaceId\":" << EscapeJson(s.space_id)
      << ",\"name\":" << EscapeJson(s.name)
      << ",\"authMode\":" << EscapeJson(AuthModeToString(s.auth_mode))
      << ",\"controlState\":" << EscapeJson(ControlStateToString(s.control_state))
      << "}";
  return oss.str();
}

std::string SerializePage(const PageInfo& p) {
  std::ostringstream oss;
  oss << "{\"pageId\":" << EscapeJson(p.page_id)
      << ",\"spaceId\":" << EscapeJson(p.space_id)
      << ",\"url\":" << EscapeJson(p.url)
      << ",\"viewport\":{\"width\":" << p.viewport.width
      << ",\"height\":" << p.viewport.height << "}"
      << ",\"viewAttached\":" << (p.view_attached ? "true" : "false")
      << ",\"mountCount\":" << p.mount_count
      << ",\"hasOpenDialog\":" << (p.open_dialog.has_value() ? "true" : "false")
      << "}";
  return oss.str();
}

std::string SerializeTunnel(const TunnelPolicy& t) {
  std::ostringstream oss;
  oss << "{\"scope\":" << EscapeJson(t.scope)
      << ",\"mode\":" << EscapeJson(RouteModeToString(t.mode))
      << ",\"osProxyDisabled\":" << (t.os_proxy_disabled ? "true" : "false")
      << ",\"webrtcPolicy\":" << EscapeJson(t.webrtc_policy)
      << ",\"failClosed\":" << (t.fail_closed ? "true" : "false")
      << ",\"tunnelHealthy\":" << (t.tunnel_healthy ? "true" : "false")
      << "}";
  return oss.str();
}

}  // namespace

RpcRouter::RpcRouter(EventCallback on_event, RuntimeMode runtime_mode)
    : on_event_(std::move(on_event)), runtime_mode_(runtime_mode) {}

void RpcRouter::SetRuntimeMode(RuntimeMode mode) {
  std::lock_guard<std::mutex> lock(mu_);
  runtime_mode_ = mode;
}

RuntimeMode RpcRouter::runtime_mode() const {
  std::lock_guard<std::mutex> lock(mu_);
  return runtime_mode_;
}

void RpcRouter::SeedPersonalCookie(const std::string& name,
                                   const std::string& value) {
  std::lock_guard<std::mutex> lock(mu_);
  personal_cookies_[name] = value;
}

void RpcRouter::EmitEvent(const std::string& event_name,
                          const std::string& params_json) {
  if (!on_event_) return;
  std::ostringstream oss;
  oss << "{\"event\":" << EscapeJson(event_name)
      << ",\"params\":" << params_json << "}";
  on_event_(oss.str());
}

std::vector<std::string> RpcRouter::BuildReconnectReplayEvents() const {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<std::string> out;
  for (const auto& [page_id, dialog] : state_.ListOpenDialogs()) {
    std::ostringstream oss;
    oss << "{\"event\":\"dialog.opened\",\"params\":{"
        << "\"pageId\":" << EscapeJson(page_id)
        << ",\"type\":" << EscapeJson(dialog.type)
        << ",\"message\":" << EscapeJson(dialog.message)
        << ",\"defaultPrompt\":" << EscapeJson(dialog.default_prompt)
        << ",\"url\":" << EscapeJson(dialog.url)
        << ",\"replayed\":true}}";
    out.push_back(oss.str());
  }
  return out;
}

OpStatus RpcRouter::NotifyPopupCaptured(const std::string& source_page_id,
                                        const std::string& target_url,
                                        PageInfo* out_page) {
  PageInfo child;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto st = state_.CapturePopupPage(source_page_id, target_url, &child);
    if (!st.ok) return st;
  }
  if (out_page) *out_page = child;
  std::ostringstream oss;
  oss << "{\"pageId\":" << EscapeJson(child.page_id)
      << ",\"spaceId\":" << EscapeJson(child.space_id)
      << ",\"url\":" << EscapeJson(child.url)
      << ",\"openerPageId\":" << EscapeJson(source_page_id)
      << ",\"capturedFromPopup\":true}";
  EmitEvent("page.created", oss.str());
  return OpStatus::Ok();
}

OpStatus RpcRouter::NotifyDialogOpened(const std::string& page_id,
                                       OpenDialog dialog) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto st = state_.RecordDialogOpened(page_id, dialog);
    if (!st.ok) return st;
  }
  std::ostringstream oss;
  oss << "{\"pageId\":" << EscapeJson(page_id)
      << ",\"type\":" << EscapeJson(dialog.type)
      << ",\"message\":" << EscapeJson(dialog.message)
      << ",\"defaultPrompt\":" << EscapeJson(dialog.default_prompt)
      << ",\"url\":" << EscapeJson(dialog.url) << "}";
  EmitEvent("dialog.opened", oss.str());
  return OpStatus::Ok();
}

OpStatus RpcRouter::NotifyTunnelHealth(const std::string& scope, bool healthy) {
  bool blocked = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto st = state_.SetTunnelHealth(scope, healthy);
    if (!st.ok) return st;
    auto list = state_.GetTunnelStatuses(scope);
    if (!list.empty()) {
      blocked = list[0].mode == RouteMode::kStrictTunnel &&
                list[0].fail_closed && !healthy;
    }
  }
  std::ostringstream oss;
  oss << "{\"scope\":" << EscapeJson(scope)
      << ",\"tunnelHealthy\":" << (healthy ? "true" : "false")
      << ",\"blockedByFailClosed\":" << (blocked ? "true" : "false") << "}";
  EmitEvent("network.tunnelStateChanged", oss.str());
  return OpStatus::Ok();
}

std::string RpcRouter::HandleRequestJson(const std::string& request_json) {
  JsonValue root;
  if (!JsonParser(request_json).Parse(&root) || !root.IsObject()) {
    return MakeErrorReply(0, "ERR_INVALID_PARAMS", "Malformed JSON request");
  }

  const int64_t id = root.Get("id") ? root.Get("id")->AsInt(0) : 0;
  const JsonValue* method_val = root.Get("method");
  if (!method_val || !method_val->IsString()) {
    return MakeErrorReply(id, "ERR_INVALID_PARAMS", "Missing method");
  }
  const std::string method = method_val->AsString();
  const JsonValue empty_obj{JsonObject{}};
  const JsonValue& params =
      (root.Get("params") && root.Get("params")->IsObject())
          ? *root.Get("params")
          : empty_obj;

  std::string pending_event_name;
  std::string pending_event_params;
  std::string reply;

  {
    std::lock_guard<std::mutex> lock(mu_);

    if (method == "agent.capabilities") {
      const bool is_daemon = (runtime_mode_ == RuntimeMode::kDaemon);
      std::ostringstream oss;
      oss << "{\"protocolVersion\":\"0.1.0\","
          << "\"chromiumVersion\":\"158.0.8127.36-cpp-core\","
          << "\"runtimeMode\":" << (is_daemon ? "\"daemon\"" : "\"desktop\"")
          << ",\"windowShownByDefault\":" << (is_daemon ? "false" : "true")
          << ",\"features\":[\"dual-mode-auth\",\"detached-agent-space\","
          << "\"hot-view-mount\",\"non-blocking-dialogs\","
          << "\"independent-vpn-tunnel\",\"webmcp-ready\",\"windowless-daemon\",\"credential-payment-guard\"],"
          << "\"authModes\":[\"shared\",\"private\"],"
          << "\"networkPolicies\":[\"strict_tunnel\",\"direct_only\",\"custom\"]}";
      reply = MakeOkReply(id, oss.str());
    } else if (method == "space.create") {
      const auto* am = params.Get("authMode");
      if (!am || !am->IsString()) {
        reply = MakeErrorReply(id, "ERR_INVALID_PARAMS",
                               "authMode must be shared or private");
      } else {
        const std::string am_str = am->AsString();
        if (am_str != "shared" && am_str != "private") {
          reply = MakeErrorReply(id, "ERR_INVALID_PARAMS",
                                 "authMode must be shared or private");
        } else {
          AuthMode mode =
              (am_str == "private") ? AuthMode::kPrivate : AuthMode::kShared;
          std::string name =
              params.Get("name") ? params.Get("name")->AsString() : "";
          Viewport vp;
          if (const auto* v = params.Get("viewport"); v && v->IsObject()) {
            vp.width = static_cast<int>(v->Get("width") ? v->Get("width")->AsInt(1280) : 1280);
            vp.height = static_cast<int>(v->Get("height") ? v->Get("height")->AsInt(800) : 800);
          }
          std::string sid = state_.CreateSpace(name, mode, vp);
          auto info = state_.GetSpace(sid);
          reply = MakeOkReply(id, SerializeSpace(*info));
        }
      }
    } else if (method == "space.list") {
      std::ostringstream oss;
      oss << "{\"spaces\":[";
      auto spaces = state_.ListSpaces();
      for (size_t i = 0; i < spaces.size(); ++i) {
        if (i > 0) oss << ",";
        oss << SerializeSpace(spaces[i]);
      }
      oss << "]}";
      reply = MakeOkReply(id, oss.str());
    } else if (method == "space.close") {
      std::string sid =
          params.Get("spaceId") ? params.Get("spaceId")->AsString() : "";
      auto st = state_.CloseSpace(sid);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        private_cookies_.erase(sid);
        reply = MakeOkReply(id, "{\"closed\":true}");
      }
    } else if (method == "page.open") {
      std::string sid =
          params.Get("spaceId") ? params.Get("spaceId")->AsString() : "";
      std::string url =
          params.Get("url") ? params.Get("url")->AsString() : "about:blank";
      std::optional<Viewport> vp;
      if (const auto* v = params.Get("viewport"); v && v->IsObject()) {
        vp = Viewport{
            static_cast<int>(v->Get("width") ? v->Get("width")->AsInt(0) : 0),
            static_cast<int>(v->Get("height") ? v->Get("height")->AsInt(0) : 0)};
      }
      PageInfo page;
      auto st = state_.OpenPage(sid, url, vp, &page);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        reply = MakeOkReply(id, SerializePage(page));
        pending_event_name = "page.created";
        pending_event_params =
            "{\"pageId\":" + EscapeJson(page.page_id) +
            ",\"spaceId\":" + EscapeJson(page.space_id) +
            ",\"url\":" + EscapeJson(page.url) +
            ",\"capturedFromPopup\":false}";
      }
    } else if (method == "page.list") {
      std::optional<std::string> sid;
      if (const auto* s = params.Get("spaceId"); s && s->IsString()) {
        sid = s->AsString();
      }
      auto pages = state_.ListPages(sid);
      std::ostringstream oss;
      oss << "{\"pages\":[";
      for (size_t i = 0; i < pages.size(); ++i) {
        if (i > 0) oss << ",";
        oss << SerializePage(pages[i]);
      }
      oss << "]}";
      reply = MakeOkReply(id, oss.str());
    } else if (method == "page.close") {
      std::string pid =
          params.Get("pageId") ? params.Get("pageId")->AsString() : "";
      auto st = state_.ClosePage(pid);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        reply = MakeOkReply(id, "{\"closed\":true}");
      }
    } else if (method == "page.attachView") {
      std::string pid =
          params.Get("pageId") ? params.Get("pageId")->AsString() : "";
      bool interactive =
          params.Get("interactive") ? params.Get("interactive")->AsBool(false) : false;
      PageInfo page;
      ControlState cstate = ControlState::kAgentRunning;
      auto st = state_.AttachView(pid, interactive, &page, &cstate);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        std::ostringstream oss;
        oss << "{\"pageId\":" << EscapeJson(page.page_id)
            << ",\"viewAttached\":true"
            << ",\"controlState\":" << EscapeJson(ControlStateToString(cstate))
            << ",\"mountCount\":" << page.mount_count << "}";
        reply = MakeOkReply(id, oss.str());
      }
    } else if (method == "page.detachView") {
      std::string pid =
          params.Get("pageId") ? params.Get("pageId")->AsString() : "";
      PageInfo page;
      ControlState cstate = ControlState::kAgentRunning;
      auto st = state_.DetachView(pid, &page, &cstate);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        std::ostringstream oss;
        oss << "{\"pageId\":" << EscapeJson(page.page_id)
            << ",\"viewAttached\":false"
            << ",\"controlState\":" << EscapeJson(ControlStateToString(cstate))
            << "}";
        reply = MakeOkReply(id, oss.str());
      }
    } else if (method == "takeover.request") {
      std::string sid =
          params.Get("spaceId") ? params.Get("spaceId")->AsString() : "";
      auto st = state_.RequestTakeover(sid);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        reply = MakeOkReply(
            id, "{\"spaceId\":" + EscapeJson(sid) +
                    ",\"controlState\":\"USER_ACTIVE\"}");
      }
    } else if (method == "takeover.release") {
      std::string sid =
          params.Get("spaceId") ? params.Get("spaceId")->AsString() : "";
      auto st = state_.ReleaseTakeover(sid);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        reply = MakeOkReply(
            id, "{\"spaceId\":" + EscapeJson(sid) +
                    ",\"controlState\":\"AGENT_RUNNING\"}");
      }
    } else if (method == "dialog.handle") {
      std::string pid =
          params.Get("pageId") ? params.Get("pageId")->AsString() : "";
      bool accept =
          params.Get("accept") ? params.Get("accept")->AsBool(false) : false;
      std::optional<std::string> prompt_text;
      if (const auto* pt = params.Get("promptText"); pt && pt->IsString()) {
        prompt_text = pt->AsString();
      }
      std::string dtype;
      auto st = state_.HandleDialog(pid, accept, prompt_text, &dtype);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        reply = MakeOkReply(
            id, "{\"handled\":true,\"dialogType\":" + EscapeJson(dtype) + "}");
      }
    } else if (method == "cdp.send") {
      std::string pid =
          params.Get("pageId") ? params.Get("pageId")->AsString() : "";
      std::string cdp_method =
          params.Get("cdpMethod") ? params.Get("cdpMethod")->AsString() : "";
      auto st = state_.AuthorizeAgentMutation(pid);
      if (!st.ok) {
        reply = MakeErrorReply(id, st.error_code, st.message);
      } else {
        auto page = state_.GetPage(pid);
        auto space = state_.GetSpace(page->space_id);
        std::string cdp_params_raw = "{}";
        if (const auto* cp = params.Get("cdpParams"); cp && cp->IsObject()) {
          std::ostringstream coss;
          coss << "{";
          bool first = true;
          for (const auto& [k, v] : *cp->AsObject()) {
            if (!first) coss << ",";
            first = false;
            coss << EscapeJson(k) << ":";
            if (v.IsString()) {
              coss << EscapeJson(v.AsString());
            } else if (v.IsBool()) {
              coss << (v.AsBool() ? "true" : "false");
            } else {
              coss << "\"\"";
            }
          }
          coss << "}";
          cdp_params_raw = coss.str();
        }
        auto sec = CheckCdpPolicy(cdp_method, cdp_params_raw, page->url, false);
        if (sec.verdict == SecurityVerdict::kDenyDomain) {
          reply = MakeErrorReply(id, "ERR_DOMAIN_DENIED", sec.message);
        } else if (sec.verdict == SecurityVerdict::kRequireHumanTakeover) {
          state_.RequestTakeover(page->space_id);
          pending_event_name = "takeover.changed";
          pending_event_params =
              "{\"spaceId\":" + EscapeJson(page->space_id) +
              ",\"pageId\":" + EscapeJson(pid) +
              ",\"reason\":" + EscapeJson(sec.reason) +
              ",\"controlState\":\"USER_ACTIVE\"}";
          reply = MakeErrorReply(id, "ERR_SENSITIVE_ACTION_REQUIRES_HUMAN",
                                 sec.message);
        } else if (cdp_method == "Network.getCookies") {
          const auto& jar = (space->auth_mode == AuthMode::kShared)
                                ? personal_cookies_
                                : private_cookies_[space->space_id];
          std::ostringstream oss;
          oss << "{\"cookies\":[";
          bool first = true;
          for (const auto& [k, v] : jar) {
            if (!first) oss << ",";
            first = false;
            oss << "{\"name\":" << EscapeJson(k)
                << ",\"value\":" << EscapeJson(v) << "}";
          }
          oss << "]}";
          reply = MakeOkReply(id, oss.str());
        } else if (cdp_method == "Page.navigate") {
          reply = MakeOkReply(
              id, "{\"frameId\":" + EscapeJson("frame_" + pid) + "}");
        } else {
          reply = MakeOkReply(
              id, "{\"ok\":true,\"method\":" + EscapeJson(cdp_method) + "}");
        }
      }
    } else if (method == "network.setTunnel") {
      TunnelPolicy pol;
      pol.scope = params.Get("scope") ? params.Get("scope")->AsString("browser")
                                      : "browser";
      std::string mode_str =
          params.Get("mode") ? params.Get("mode")->AsString("strict_tunnel")
                             : "strict_tunnel";
      if (mode_str == "strict_tunnel") {
        pol.mode = RouteMode::kStrictTunnel;
      } else if (mode_str == "direct_only") {
        pol.mode = RouteMode::kDirectOnly;
      } else if (mode_str == "custom") {
        pol.mode = RouteMode::kCustom;
      } else {
        reply = MakeErrorReply(id, "ERR_INVALID_PARAMS", "Invalid route mode");
      }
      if (reply.empty()) {
        if (const auto* ep = params.Get("endpoint"); ep && ep->IsString()) {
          pol.endpoint = ep->AsString();
        }
        if (const auto* doh = params.Get("dohServer"); doh && doh->IsString()) {
          pol.doh_server = doh->AsString();
        }
        if (const auto* wp = params.Get("webrtcPolicy"); wp && wp->IsString()) {
          pol.webrtc_policy = wp->AsString();
        }
        pol.fail_closed = params.Get("failClosed")
                              ? params.Get("failClosed")->AsBool(true)
                              : (pol.mode == RouteMode::kStrictTunnel);
        TunnelPolicy effective;
        auto st = state_.SetTunnelPolicy(std::move(pol), &effective);
        if (!st.ok) {
          reply = MakeErrorReply(id, st.error_code, st.message);
        } else {
          reply = MakeOkReply(id, SerializeTunnel(effective));
        }
      }
    } else if (method == "network.getStatus") {
      std::optional<std::string> scope;
      if (const auto* sc = params.Get("scope"); sc && sc->IsString()) {
        scope = sc->AsString();
      }
      auto list = state_.GetTunnelStatuses(scope);
      std::ostringstream oss;
      oss << "{\"routes\":[";
      for (size_t i = 0; i < list.size(); ++i) {
        if (i > 0) oss << ",";
        oss << SerializeTunnel(list[i]);
      }
      oss << "]}";
      reply = MakeOkReply(id, oss.str());
    } else if (method == "page.listNativeTabs") {
      reply = MakeOkReply(id, "{\"tabs\":[]}");
    } else if (method == "page.attachActiveTab") {
      reply = MakeErrorReply(id, "ERR_PAGE_NOT_FOUND",
                             "No active desktop browser tab in daemon mode");
    } else if (method == "page.detachTab") {
      reply = MakeOkReply(id, "{\"detached\":true}");
    } else if (method == "page.focusTab") {
      reply = MakeOkReply(id, "{\"focused\":false}");
    } else if (method == "ui.getAppearance") {
      reply = MakeOkReply(
          id,
          "{\"theme\":\"system\",\"accentColor\":\"\",\"layout\":\"chrome\","
          "\"compact\":false,\"showBookmarkBar\":true,\"nativeUi\":{"
          "\"windowTitleSuffix\":\"Gador\",\"aiAuraEnabled\":true}}");
    } else if (method == "ui.setAppearance") {
      reply = MakeOkReply(id, "{\"applied\":true,\"nativeUi\":{\"windowTitleSuffix\":\"Gador\"}}");
    } else {
      reply = MakeErrorReply(id, "ERR_METHOD_NOT_FOUND",
                             "Unknown method: " + method);
    }
  }

  if (!pending_event_name.empty()) {
    EmitEvent(pending_event_name, pending_event_params);
  }
  return reply;
}

}  // namespace agent_kernel::core
