# WebRTC 资源清单

本课所有断言尽量从下面这些来源推出，而不是凭印象写。链接都在 2026-10 实测可达。

## Knowledge

### 规范与标准（一手）

- [W3C: WebRTC — Real-Time Communication in Browsers](https://www.w3.org/TR/webrtc/)
  现行 W3C Recommendation（最初 2021-01-26 发布，现行修订版 2025-03-13）。用于：`RTCPeerConnection` 的状态机、offer/answer 规则、`getStats()` 指标定义的**权威来源**。遇到「浏览器行为该不该这样」的问题，先查它而不是查博客。
- [W3C: Identifiers for WebRTC's Statistics API（webrtc-stats）](https://www.w3.org/TR/webrtc-stats/)
  用于：`getStats()` 返回的每个统计对象的**字段名与枚举值**——`qualityLimitationReason`、`availableOutgoingBitrate`、`freezeCount` 这些都定义在这里，而不在主规范里。查字段写错名字时来这份。
- [RFC 8825 — Overview: Real-Time Protocols for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc8825.html)
  WebRTC 协议族的总体说明。用于：搞清楚「哪些东西被标准化了、哪些被**故意**留给应用」（信令就是后者）。
- [RFC 9429 — JSEP（JavaScript Session Establishment Protocol）](https://www.rfc-editor.org/rfc/rfc9429.html)
  2024-04 发布，**废止 RFC 8829**。用于：offer/answer 在 WebRTC 里的具体机制——`setLocalDescription` 到底改了什么、状态机怎么迁移、为什么必须在 JS 里管协商。网上大量教程仍引 8829，注意版本。
- [RFC 8445 — ICE](https://www.rfc-editor.org/rfc/rfc8445.html)
  ICE 框架本体：候选类型与优先级、连通性检查、提名。用于：一切「为什么选了这个候选对」的问题。
- [RFC 8489 — STUN](https://www.rfc-editor.org/rfc/rfc8489.html) ／ [RFC 8656 — TURN](https://www.rfc-editor.org/rfc/rfc8656.html)
  用于：`srflx` 候选怎么来的、TURN 的分配与权限模型、中继到底转发什么。
- [RFC 8838 — Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html)
  用于：候选为什么可以边收集边发、`end-of-candidates` 的语义、连接时间为什么能压到亚秒级。
- [RFC 4787 / BCP 127 — NAT Behavioral Requirements for Unicast UDP](https://www.rfc-editor.org/rfc/rfc4787.html)
  **本课 NAT 一讲的地基**。它把 NAT 拆成「映射行为 × 过滤行为」两组正交属性，并明确**弃用**了 Full Cone / Restricted Cone / Symmetric 这套旧术语。用于：判断某个 NAT 组合能不能打洞、为什么「对称型」这个词其实不够精确。
- [RFC 8827 — WebRTC Security Architecture](https://www.rfc-editor.org/rfc/rfc8827.html)
  用于：媒体加密为什么是强制的、SDES 为什么被禁、每通电话为什么必须换密钥对。
- [RFC 5764 — DTLS-SRTP](https://www.rfc-editor.org/rfc/rfc5764.html) ／ [RFC 3711 — SRTP](https://www.rfc-editor.org/rfc/rfc3711.html)
  用于：密钥怎么从 DTLS 导出、SRTP 的包结构与重放保护。
- [RFC 7983 — Multiplexing RTP/RTCP, DTLS, STUN on One Port](https://www.rfc-editor.org/rfc/rfc7983.html)
  用于：为什么「ICE 和媒体用同一个端口」不是巧合，而是靠**首字节区间**区分。
- [RFC 3550 — RTP](https://www.rfc-editor.org/rfc/rfc3550.html) ／ [RFC 6184 — H.264 载荷](https://www.rfc-editor.org/rfc/rfc6184.html) ／ [RFC 7741 — VP8 载荷](https://www.rfc-editor.org/rfc/rfc7741.html)
  用于：序列号、时间戳、分片打包（FU-A）、丢包与乱序在上层长什么样。
- [RFC 8888 — RTCP Feedback for Congestion Control（CCFB）](https://www.rfc-editor.org/rfc/rfc8888.html)
  2021-01。定义了逐包反馈的格式（PT=205、FMT=11、13 bit 到达时间偏移，单位 1/1024 秒）。用于：transport-cc 这条反馈链路到底带了什么信息。
- [RFC 8853 — Simulcast in SDP and RTP](https://www.rfc-editor.org/rfc/rfc8853.html)
  用于：`a=simulcast` 的语法与 offer/answer 反转规则，以及 SFU 为什么能「只转发不解码」。
- [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html) ／ [RFC 8832](https://www.rfc-editor.org/rfc/rfc8832.html) ／ [RFC 4960](https://www.rfc-editor.org/rfc/rfc4960.html)
  数据通道 = SCTP over DTLS。用于：为什么 `RTCDataChannel` 能提供「部分可靠」这种 WebSocket 给不了的语义。
- [RFC 3264 — An Offer/Answer Model with SDP](https://www.rfc-editor.org/rfc/rfc3264.html)
  用于：协商为什么是两次状态交换而不是填表。
- [RFC 9725 — WHIP（WebRTC-HTTP Ingestion Protocol）](https://www.rfc-editor.org/rfc/rfc9725.html)
  2025-03 发布，Standards Track。用于：广播 / 直播场景的标准化推流信令长什么样（一次 HTTP POST 换 SDP）。
- [RFC 8216 — HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216.html) ／ [Apple HLS 文档](https://developer.apple.com/documentation/http-live-streaming)
  用于：为什么广播级延迟卡在 2–5 秒下不来——答案在分段与播放列表这套机制里，不在播放器参数里。想理解「WebRTC 与 LL-HLS 的边界在哪」，读这两份比读任何博客都直接。
- [A Study on Delay and Traffic Reduction for Cloud Gaming Systems（大阪大学博士论文）](https://ir.library.osaka-u.ac.jp/repo/ouka/all/96225/34144_Dissertation.pdf)
  用于：云游戏的延迟预算分解。我引的「总 100 ms 临界 / 其中约 20 ms 是播放与处理 / 网络侧不超过 80 ms」出自它对 Choy 等人研究的复述与实验框架。也提到 Parsec 自研 UDP 协议（BUD）这条旁证。

### 真实测量与工程经验

- [webrtcHacks: "The Big Churn — learning from real usage stats"（Lasse Lumiaho & Varun Singh）](https://webrtchacks.com/usage-stats/)
  **本课最主要的一组真实数据**，来自 callstats.io 对上百个 WebRTC 服务的观测（2015-01 至 2016-02，数十亿分钟）。关键数字：12% 的会话从未建立成功；这些失败里 85% 源于 NAT / 防火墙穿透失败；22% 的会议需要某种 TURN 中继；9% 需要 TCP；建立后约 20% 的会话会掉线，其中 44% 归因于网络中断。注意年份——用它做量级判断，不要当今天的精确值。

### 实现与工具

- [Pion WebRTC（Go）](https://github.com/pion/webrtc)
  最适合**读**的实现：模块化、代码量可控，ICE / DTLS / SRTP 各自独立成库。用于：想确认「规范里那句话在代码里长什么样」。
- [mediasoup（C++ / Node）](https://github.com/versatica/mediasoup) ／ [文档](https://mediasoup.org/documentation/v3/)
  用于：SFU 的路由、传输与消费者模型，以及 simulcast 分层的实际处理方式。
- [LiveKit（Go）](https://github.com/livekit/livekit)
  用于：想快速拥有一套能上线的 SFU + TURN + 鉴权，而不是从零拼装。
- [Janus（C）](https://github.com/meetecho/janus-gateway)
  用于：老牌网关，看「插件化」怎么把 WebRTC 桥到 SIP / RTSP 等协议。
- [Mozilla WebRTC 博客](https://blog.mozilla.org/webrtc/)
  用于：Firefox 侧的实现细节与历史设计取舍，尤其是早期把 WebRTC 塞进浏览器的那些争论。

## Wisdom (Communities)

- [Pion Discussions](https://github.com/pion/webrtc/discussions)
  信噪比高，作者会直接回。用于：实现层面的疑难（「为什么我的 DTLS 握不上手」）。
- [mediasoup 论坛](https://mediasoup.discourse.group/)
  用于：SFU 容量、转发策略、生产环境踩坑。
- [IETF RTCWEB 工作组](https://datatracker.ietf.org/group/rtcweb/about/) ／ [W3C WebRTC WG](https://www.w3.org/groups/wg/webrtc/)
  用于：想知道某个行为「将来会不会变」时，看草案与会议纪要，而不是看论坛。
- [webrtcHacks](https://webrtchacks.com/)
  长期维护的高质量博客，作者多为 Chrome / 浏览器厂商与基础设施团队的人。用于：把规范翻译成工程直觉。

## Gaps

- **缺一份近年的公开中继占比测量。** 现有流传的 8%–22% 区间几乎都能追溯到 2015–2016 年的 callstats 数据。本课因此只给「量级」判断，并要求自己上线后自测中继率。
- **第 9、10 讲的延迟与缓冲区间，没有对应的一手测量。** 它们是工程实践共识（云游戏 100 ms 临界有学术支撑，但「缓冲压到 1–2 帧」「FEC 优于 NACK」这类结论缺少公开对照实验）。这两讲里凡属实践共识的地方都已显式标注，请当方向而非数值。
- 缺中文的高质量一手资料。中文圈的 WebRTC 文章大量互相转抄，且常把「四种 NAT 类型」当成事实——这与 RFC 4787 的建模方式冲突。
- 缺可离线运行的完整 demo 工程。本课的动手部分依赖本机能跑 Docker；纯手机阅读时只能读，不能做。
