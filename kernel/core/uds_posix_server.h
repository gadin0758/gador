#ifndef CHROME_BROWSER_AGENT_KERNEL_CORE_UDS_POSIX_SERVER_H_
#define CHROME_BROWSER_AGENT_KERNEL_CORE_UDS_POSIX_SERVER_H_

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace agent_kernel::core {

// Linux POSIX Unix Domain Socket server with:
//  - 0700 parent directory + 0600 socket permissions
//  - SO_PEERCRED verification (rejects any peer whose UID != geteuid())
//  - uint32 BE length-prefixed framing (via FrameDecoder / EncodeFrame)
class UdsPosixServer {
 public:
  using RequestHandler = std::function<std::string(const std::string& request_json)>;
  using ConnectCallback = std::function<std::vector<std::string>()>;

  UdsPosixServer(std::string socket_path,
                 RequestHandler handler,
                 ConnectCallback on_connect_events = {});
  UdsPosixServer(const UdsPosixServer&) = delete;
  UdsPosixServer& operator=(const UdsPosixServer&) = delete;
  ~UdsPosixServer();

  bool Start(std::string* out_error = nullptr);
  void Stop();
  void Broadcast(const std::string& event_json);

  const std::string& socket_path() const { return socket_path_; }

 private:
  void AcceptLoop();
  void HandleClient(int client_fd);
  static bool VerifyPeerSameUid(int client_fd);
  static bool WriteAll(int fd, const uint8_t* data, size_t size);

  std::string socket_path_;
  RequestHandler handler_;
  ConnectCallback on_connect_events_;

  int listen_fd_ = -1;
  std::atomic<bool> running_{false};
  std::thread accept_thread_;

  std::mutex clients_mu_;
  std::vector<int> client_fds_;
  std::vector<std::thread> worker_threads_;
};

}  // namespace agent_kernel::core

#endif  // CHROME_BROWSER_AGENT_KERNEL_CORE_UDS_POSIX_SERVER_H_
