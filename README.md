# dot-telegram-bridge

[English](README.en.md)

在你与 Telegram bot 的私聊里使用原来的 ChatGPT dot。这个仓库负责 Telegram 收发；安装、MCP Tunnel 和多渠道管理由 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge) 提供。


可以让 dot 把收到的图片、语音或文件直接发回原私聊，例如“把这张图发回来”。桥会按附件编号读取，不需要来回传递很长的编码文本。仍需符合本渠道的格式和大小限制；无法作为语音发送的已识别音频，可以明确选择作为文件回复。

TXT、Markdown、JSON、CSV 等文本附件会提供可读的文字摘录，支持 UTF-8 和带标记的 UTF-16；过长时明确标记为截断，原文件仍可读取。PDF／Office 文本摘录复用受保护的 Linux 处理环境；格式未被提取时保留原件。

运行主机可使用持续开机的 Linux 或 Windows 电脑，Linux 支持 systemd。macOS 尚未验证，欢迎试用并反馈。

## 使用前准备

需要 Node.js 24.15 以上、25 以下，以及一个你有权使用的 Telegram bot。

1. 准备 bot token。已有 bot 可在 [BotFather](https://t.me/BotFather) 管理，凭据只放在运行主机的私有文件里。
2. 停止这个 bot 的旧收发程序。新的专用 bot 可以直接进入下面的配对流程；已有 webhook 的 bot 需要先安排迁移。
3. 使用[本人配对流程](docs/setup.md)：终端生成一条两分钟有效的命令，你从本人账号发给 bot，程序核对后保存绑定。无需手抄用户和私聊 ID。
4. 到总仓库配置渠道、官方 MCP Tunnel 和原 dot 的消息订阅。已有可信绑定文件也可以继续使用。

凭据文件内容如下，所有值都需要替换，ID 保留为字符串：

```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "ownerId": "YOUR_TELEGRAM_USER_ID",
  "conversationId": "YOUR_PRIVATE_CHAT_ID"
}
```

Linux 上将私有目录设为 `0700`、文件设为 `0600`，属主为最终运行用户。Windows 按总仓库的私有文件说明配置 ACL。不要把凭据提交到 Git 或粘贴到聊天里。

接收消息采用 Bot API 长轮询，主机能出站访问 Telegram HTTPS 即可，无需为这个渠道暴露公网 webhook。启动会核对 bot token，并检查这个 bot 是否已经设置 webhook；已有 webhook 时会停止启动，交由你协调迁移，不会自动删除它或丢弃待处理消息。

运行配置可以从 [telegram.env.example](docs/telegram.env.example) 开始，调整路径并保存为私有的 `telegram.env`。其中 `TELEGRAM_CREDENTIALS_FILE` 指向上面的 JSON 文件；`CALLBACK_HOSTS` 要等原 dot 的真实订阅流程给出域名后再填写。准备完成后，单独运行渠道的命令是：

```sh
node --env-file=/etc/dot-bridge/telegram/telegram.env scripts/run-live.js --confirm-live
```

长期运行、与其他渠道共用一个 Tunnel 时，请使用总仓库的服务管理入口。

## 当前用法与限制

- 接收文字，回复最多 20,000 字符的完整回答。超过 Telegram 一条文字的 4,096 字符时，默认以完整 `answer.txt` 文件完成回复；受保护策略也可选择持久分段。
- 可读取私聊中的图片、语音和文件，也可回复图片、语音或文件；每个附件最多 5 MiB。媒体说明最多 1024 字符。
- 图片回复支持 JPEG、PNG；语音回复支持 OGG/Opus、MP3、M4A。其他格式可作为文件发送。附件只从 Telegram 下载，不接收任意下载网址。
- 语音内容的转写由共享 core 中已配置的本地转写程序处理。没有配置时仍可取得音频文件，但不会自动获得文字；不会把“收到音频文件”说成“听懂了”。
- 默认只接收绑定用户的指定私聊；群与论坛话题需显式配置受保护规则。频道、其他 bot、消息编辑、Business 和 Guest 消息仍不进入 dot。
- 只有消息被本地持久接收后，才会保存并推进轮询位置。Telegram 对未收取更新的保存有时间限制，长时间离线的消息可能无法补收。
- Bot API 发消息没有本项目可用的幂等键。发送结果不明确时不会自动重发。
- 升级前已保存的附件只有名称和类型，无法追溯补出文件引用。需要读取这类旧附件时，请在原私聊重新发送。

同一个 bot 同时只运行一个消费实例，也不能同时配置 webhook 与长轮询。迁移时保留原存储密钥和数据库，并先停止旧实例；总仓库提供统一启停和回滚说明。

如果 bot 没有回复，先查看连接状态：未连接时检查 Token、本人绑定、旧实例或 webhook；已经连接且待处理消息增加时，查看原 dot 的 Telegram 消息订阅。本人私聊订阅使用 `telegram.message.created`、`conversation=owner`；启用群规则后按下文协调原订阅范围。创建失败时保留脱敏错误和时间，修正原因后再尝试，避免反复创建同一订阅。

## 平台资料

- [Telegram Bot API：更新、长轮询与发送消息](https://core.telegram.org/bots/api)
- [Telegram Bot 入门](https://core.telegram.org/bots)
- [DotBridge 统一安装与运行](https://github.com/Arcueid77/dot-bridge)

## 定时消息

新增主动文字和固定提醒：目标只允许已绑定的本人私聊，主动发送默认关闭。管理员批准后可设置 `DOT_BRIDGE_OUTBOUND=owner-text`；原 dot 通过发送、保存提醒、查询、修改和取消工具管理，不需要重建事件订阅。每条最多 2,000 字符，重复提醒需有结束日期。

详见[定时消息使用指南](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.md)。


## 处理提示、上下文与聊天内管理

在私有环境文件里设置 `DOT_BRIDGE_INTERACTION_POLICY_FILE`，指向运行用户持有的 JSON 文件。Linux 目录 `0700`、文件 `0600`；Windows 使用私有 ACL。先以本人私聊配置开始：

```json
{
  "version": 1,
  "feedback": {"enabled": true, "reaction": true, "typing": true, "streaming": true, "lease_seconds": 60},
  "context": {"max_messages": 20, "max_chars": 12000},
  "replies": {"long_text": "file"},
  "management": {"enabled": true},
  "groups": []
}
```

收到消息后可显示接收提示；原 dot 读取消息或明确开始处理后显示有时限的 typing。完成、取消、失败或到期后清理提示。`get_telegram_context` 提供同一会话、话题和成员范围内的保留历史及引用。

本人私聊可使用 `/help`、`/status`、`/queue`、`/subscription`、`/cancel [编号]`。取消作用于尚未发送的桥接回复；发送中和结果不明的记录保留核对。订阅由原 dot／平台按真实有效期续订。

`get_telegram_reply_status` 查询最终投递：`none` 表示尚未排队，`pending` 表示已排队，`processing` 表示最终消息正在写出，`sent` 表示平台确认。处理提示有独立的租约；开始处理后仍需提交本次最终回答。`uncertain` 保持人工核对，不自动补发。

原 dot 使用 `begin_telegram_reply` 开始真实处理，用 `append_telegram_reply` 提交从序号 1 起连续增长的完整累计文本，最后以 `reply_to_telegram` 完成同一条消息。短回答直接完成即可。长文默认完整文件；将 `replies.long_text` 设为 `chunks` 可启用有持久确认的原生分段。

## 可配置群与话题

新群默认关闭。在同一策略的 `groups` 中加入经本人确认的群或频道规则：

```json
{
  "conversation_id": "REPLACE_WITH_VERIFIED_GROUP_OR_CHANNEL_ID",
  "enabled": true,
  "members": "all",
  "mention": true,
  "auto_reply": "off",
  "reply_in_thread": true,
  "context_scope": "sender"
}
```

`members` 可选 `owner`、`allowlist`、`all`；白名单模式填写 `allow_from`。`auto_reply` 可选 `off`、`keywords`、`all`，关键词模式填写 `keywords`。只有对应模式才填写白名单或关键词。真实 @ 与自动触发按 OR 组合。`context_scope` 默认 `sender`，也可显式设为 `group`；会话与话题始终分开。

启用前先处理在途回复，再协调原任务的唯一订阅改为 `conversation=configured`。按真实订阅流程完成切换，保留原数据库和去重状态。原 dot 的群任务按源会话处理，私聊记忆保持私密。平台权限和新增接收范围由操作者确认。

Telegram 使用官方 mention 实体或对本 bot 的回复识别触发，并保留论坛话题。关键词／全消息模式需要管理员核对 BotFather 的群隐私配置及实际可见消息；调整前确认接收范围。Markdown 会转为安全 HTML。

配置字段的范围与私有文件要求见[统一交互说明](https://github.com/Arcueid77/dot-bridge/blob/main/docs/new-channels.md#统一交互与群聊规则)。

## 选项、文件和提醒管理

支持原生选项回复，点击后作为一条新输入交给原 dot。选项绑定发起人、原会话及实际发出的消息，最长十分钟有效。生成的图片、音频或文件可由具备程序文件读取能力的原 dot 分块上传，经大小与 SHA-256 校验后作为原消息的最终回复。单文件上限 5 MiB，仍需满足本渠道支持的媒体类型与格式。

固定文字提醒支持工作日、固定间隔、暂停、恢复和发送历史。先核对 `check_telegram_outbound` 的开关，再按提醒编号与当前版本操作。暂停期间的旧时间点在恢复时跳过。
