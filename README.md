# dot-telegram-bridge

在你与 Telegram bot 的私聊里使用原来的 ChatGPT dot。这个仓库负责 Telegram 收发；安装、MCP Tunnel 和多渠道管理由 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge) 提供。


可以让 dot 把收到的图片、语音或文件直接发回原私聊，例如“把这张图发回来”。桥会按附件编号读取，不需要来回传递很长的编码文本。仍需符合本渠道的格式和大小限制；无法作为语音发送的已识别音频，可以明确选择作为文件回复。

TXT、Markdown、JSON、CSV 等文本附件会提供可读的文字摘录，支持 UTF-8 和带标记的 UTF-16；过长时明确标记为截断，原文件仍可读取。其他格式继续保留原件。

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

- 接收文字，回复最多 20,000 字符的完整回答。超过 Telegram 一条文字的 4,096 字符时，改为一次最终回复发送一份 `answer.txt` 文件，不截断或分成多条发送。
- 可读取私聊中的图片、语音和文件，也可回复图片、语音或文件；每个附件最多 5 MiB。媒体说明最多 1024 字符。
- 图片回复支持 JPEG、PNG；语音回复支持 OGG/Opus、MP3、M4A。其他格式可作为文件发送。附件只从 Telegram 下载，不接收任意下载网址。
- 语音内容的转写由共享 core 中已配置的本地转写程序处理。没有配置时仍可取得音频文件，但不会自动获得文字；不会把“收到音频文件”说成“听懂了”。
- 仅接收绑定用户在指定私聊里的新消息。群聊、频道、其他 bot、消息编辑、Business 和 Guest 消息不进入 dot。
- 只有消息被本地持久接收后，才会保存并推进轮询位置。Telegram 对未收取更新的保存有时间限制，长时间离线的消息可能无法补收。
- Bot API 发消息没有本项目可用的幂等键。发送结果不明确时不会自动重发。
- 升级前已保存的附件只有名称和类型，无法追溯补出文件引用。需要读取这类旧附件时，请在原私聊重新发送。

同一个 bot 同时只运行一个消费实例，也不能同时配置 webhook 与长轮询。迁移时保留原存储密钥和数据库，并先停止旧实例；总仓库提供统一启停和回滚说明。

如果 bot 没有回复，先查看连接状态：未连接时检查 Token、本人绑定、旧实例或 webhook；已经连接且待处理消息增加时，查看原 dot 的 Telegram 消息订阅。原 dot 需要订阅 `telegram.message.created` 并限定 `conversation=owner`。创建失败时保留脱敏错误和时间，修正原因后再尝试，避免反复创建同一订阅。

## 平台资料

- [Telegram Bot API：更新、长轮询与发送消息](https://core.telegram.org/bots/api)
- [Telegram Bot 入门](https://core.telegram.org/bots)
- [DotBridge 统一安装与运行](https://github.com/Arcueid77/dot-bridge)
