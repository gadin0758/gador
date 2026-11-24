#include "uds_posix_server.h"

#include <cerrno>
#include <cstring>
#include <filesystem>

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "protocol_framing.h"

namespace agent_kernel::core {

UdsPosixServer::UdsPosixServer(std::string socket_path,
                               RequestHandler handler,
                               ConnectCallback on_connect_events)
    : socket_path_(std::move(socket_path)),
      handler_(std::move(handler)),
      on_connect_events_(std::move(on_connect_events)) {}

UdsPosixServer::~UdsPosixServer() {
  Stop();
}

bool UdsPosixServer::Start(std::string* out_error) {
  if (running_.load()) {
    return true;
  }

  std::filesystem::path sock_path(socket_path_);
  std::error_code ec;
  if (sock_path.has_parent_path()) {
    std::filesystem::create_directories(sock_path.parent_path(), ec);
    ::chmod(sock_path.parent_path().c_str(), 0700);
  }
  ::unlink(socket_path_.c_str());

  listen_fd_ = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listen_fd_ < 0) {
    if (out_error) *out_error = std::strerror(errno);
    return false;
  }

  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (socket_path_.size() >= sizeof(addr.sun_path)) {
    ::close(listen_fd_);
    listen_fd_ = -1;
    if (out_error) *out_error = "Unix domain socket path exceeds sun_path limit";
    return false;
  }
  std::strncpy(addr.sun_path, socket_path_.c_str(), sizeof(addr.sun_path) - 1);

  if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
    if (out_error) *out_error = std::strerror(errno);
    ::close(listen_fd_);
    listen_fd_ = -1;
    return false;
  }

  // Enforce strict 0600 permissions before accepting any connection.
  if (::chmod(socket_path_.c_str(), 0600) < 0) {
    if (out_error) *out_error = std::strerror(errno);
    ::close(listen_fd_);
    listen_fd_ = -1;
    ::unlink(socket_path_.c_str());
    return false;
  }

  if (::listen(listen_fd_, 32) < 0) {
    if (out_error) *out_error = std::strerror(errno);
    ::close(listen_fd_);
    listen_fd_ = -1;
    ::unlink(socket_path_.c_str());
    return false;
  }

  running_.store(true);
  accept_thread_ = std::thread(&UdsPosixServer::AcceptLoop, this);
  return true;
}

void UdsPosixServer::Stop() {
  if (!running_.exchange(false)) {
    return;
  }
  if (listen_fd_ >= 0) {
    ::shutdown(listen_fd_, SHUT_RDWR);
    ::close(listen_fd_);
    listen_fd_ = -1;
  }
  if (accept_thread_.joinable()) {
    accept_thread_.join();
  }

  {
    std::lock_guard<std::mutex> lock(clients_mu_);
    for (int fd : client_fds_) {
      ::shutdown(fd, SHUT_RDWR);
    }
  }
  for (auto& t : worker_threads_) {
    if (t.joinable()) {
      t.join();
    }
  }
  worker_threads_.clear();
  client_fds_.clear();
  ::unlink(socket_path_.c_str());
}

void UdsPosixServer::Broadcast(const std::string& event_json) {
  auto frame = EncodeFrame(event_json);
  if (frame.empty()) {
    return;
  }
  std::lock_guard<std::mutex> lock(clients_mu_);
  for (int fd : client_fds_) {
    WriteAll(fd, frame.data(), frame.size());
  }
}

void UdsPosixServer::AcceptLoop() {
  while (running_.load()) {
    int client_fd = ::accept4(listen_fd_, nullptr, nullptr, SOCK_CLOEXEC);
    if (client_fd < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (!VerifyPeerSameUid(client_fd)) {
      ::close(client_fd);
      continue;
    }
    {
      std::lock_guard<std::mutex> lock(clients_mu_);
      client_fds_.push_back(client_fd);
      worker_threads_.emplace_back(&UdsPosixServer::HandleClient, this,
                                   client_fd);
    }
  }
}

void UdsPosixServer::HandleClient(int client_fd) {
  if (on_connect_events_) {
    for (const auto& evt : on_connect_events_()) {
      auto frame = EncodeFrame(evt);
      if (!frame.empty()) {
        WriteAll(client_fd, frame.data(), frame.size());
      }
    }
  }

  FrameDecoder decoder;
  uint8_t buf[8192];
  while (running_.load()) {
    ssize_t n = ::read(client_fd, buf, sizeof(buf));
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      break;
    }
    auto res = decoder.Push(buf, static_cast<size_t>(n));
    if (!res.ok) {
      break;
    }
    for (const auto& req : res.frames) {
      std::string reply = handler_(req);
      if (!reply.empty()) {
        auto frame = EncodeFrame(reply);
        if (!frame.empty() && !WriteAll(client_fd, frame.data(), frame.size())) {
          goto disconnect;
        }
      }
    }
  }

disconnect:
  {
    std::lock_guard<std::mutex> lock(clients_mu_);
    for (auto it = client_fds_.begin(); it != client_fds_.end(); ++it) {
      if (*it == client_fd) {
        client_fds_.erase(it);
        break;
      }
    }
  }
  ::close(client_fd);
}

// static
bool UdsPosixServer::VerifyPeerSameUid(int client_fd) {
#if defined(__linux__)
  ucred cred{};
  socklen_t len = sizeof(cred);
  if (::getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    return false;
  }
  return cred.uid == ::geteuid();
#else
  (void)client_fd;
  return true;
#endif
}

// static
bool UdsPosixServer::WriteAll(int fd, const uint8_t* data, size_t size) {
  size_t written = 0;
  while (written < size) {
    ssize_t n = ::send(fd, data + written, size - written, MSG_NOSIGNAL);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      return false;
    }
    written += static_cast<size_t>(n);
  }
  return true;
}

}  // namespace agent_kernel::core
