# dot-telegram-bridge

在你与 Telegram bot 的私聊里使用原来的 ChatGPT dot。这个仓库负责 Telegram 收发；安装、MCP Tunnel 和多渠道管理由 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge) 提供。

## 使用前准备

需要 Node.js 24.15 以上、25 以下，以及一个你有权使用的 Telegram bot。

1. 准备 bot token。已有 bot 可在 [BotFather](https://t.me/BotFather) 管理，凭据只放在运行主机的私有文件里。
2. 从你本人的账号进入 bot 私聊，点 Start 并发一条文字。
3. 从已有绑定记录，或 Bot API 返回的本人私聊 update 中，取得数字用户 ID 和 private chat ID。普通本人私聊中，两者通常相同；请以实际记录为准。
4. 按下面的格式准备凭据文件，再到总仓库配置渠道、官方 MCP Tunnel 和原 dot 的消息订阅。

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

- 接收文字，回复纯文字，单条回复最多 4096 字符。不会将一条长回复自动拆成多条。
- 图片、文件和语音目前只传递类型、文件名等信息，不下载或识别媒体；语音不会自动转写。
- 仅接收绑定用户在指定私聊里的新消息。群聊、频道、其他 bot、消息编辑、Business 和 Guest 消息不进入 dot。
- 只有消息被本地持久接收后，才会保存并推进轮询位置。Telegram 对未收取更新的保存有时间限制，长时间离线的消息可能无法补收。
- Bot API 发消息没有本项目可用的幂等键。发送结果不明确时不会自动重发。

同一个 bot 同时只运行一个消费实例，也不能同时配置 webhook 与长轮询。迁移时保留原存储密钥和数据库，并先停止旧实例；总仓库提供统一启停和回滚说明。

如果没有收到消息，先确认已从本人账号点击 Start、凭据里的用户与私聊 ID 正确，再检查是否有旧实例或 webhook 占用同一个 bot。遇到鉴权拒绝或轮询冲突时，渠道会停止重连；处理原因后再重启。`connected` 只表示 Telegram 请求成功；dot 接到消息还需要原插件的有效订阅。

## 平台资料

- [Telegram Bot API：更新、长轮询与发送消息](https://core.telegram.org/bots/api)
- [Telegram Bot 入门](https://core.telegram.org/bots)
- [DotBridge 统一安装与运行](https://github.com/Arcueid77/dot-bridge)
