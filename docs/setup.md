# 连接 Telegram

先在官方 [BotFather](https://t.me/BotFather) 创建一个专用 bot。Token 只放进运行主机的私有文件，不放在聊天、命令参数或 Git 中。

## 配对你本人的私聊

这一步在将来运行桥接服务的主机上完成。用最终运行服务的账号操作，先停止这个 bot 的旧收发程序。已经绑定并在工作的实例继续使用原凭据文件即可，不需要重新配对。

把 Token 保存到一个受保护的纯文本文件，例如 `/etc/dot-bridge/telegram/bot-token.txt`，文件只含 Token，可带末尾换行。父目录应为 `0700`、文件为 `0600`，属主为运行账号；Windows 使用总仓库说明中的私有 ACL。目标凭据目录也需要提前准备好。

在渠道仓库中运行：

```sh
node scripts/pair-owner.js \
  --token-file /etc/dot-bridge/telegram/bot-token.txt \
  --credentials-file /etc/dot-bridge/telegram/credentials.json \
  --confirm-stopped --confirm-private-storage
```

两个确认参数表示：你已停止旧消费者，并同意把这次核对过的本人绑定存入指定私有文件。命令不会覆盖已有凭据。

终端会显示一条 `/start db_…` 命令。两分钟内，从你本人的 Telegram 账号把整条命令发给这个 bot；只点 Start 或发普通问候不会完成配对。命令验证通过后，终端会显示保存成功和文件位置，不显示 Token 或身份值。

配对不会发送消息、删除 webhook 或提前确认队列里的消息。如果它报告已有 webhook、另一个消费者或积压消息过多，先处理迁移或队列问题，再开始配对。不要用清空队列来绕过检查。

## 让原 dot 收到消息

1. 在总仓库配置 Telegram，`TELEGRAM_CREDENTIALS_FILE` 指向刚才保存的文件，再启动渠道。
2. 在原 dot 的现有 Tunnel 插件中刷新工具目录，建立 `telegram.message.created` 订阅，限定 `conversation=owner`。
3. 如果订阅要求允许回调域名，使用这次真实订阅给出的精确域名配置 `CALLBACK_HOSTS`；不要猜回调地址或使用通配符。
4. 从本人私聊发送一句文字。收到正常回复后，再分别试一张图片、一条短语音和一个小文件。

文字回答最多 20,000 字符，超过 Telegram 一条文字的 4,096 字符时，会以一份完整的 `answer.txt` 文件回复。媒体回复每次发送一个附件，最多 5 MiB，可附带 1024 字符以内的说明。语音回复必须是 OGG/Opus、MP3 或 M4A；其他音频格式可作为文件发送。音频自动转写需要先在共享 core 配置本地转写程序。

连接正常但没有回答时，先查看有效订阅和待处理消息。只有平台网关连接正常，仍不足以让原 dot 收到新消息。订阅有有效期，需由原 dot 按返回期限续订。

平台资料：[获取更新](https://core.telegram.org/bots/api#getupdates)、[文件下载](https://core.telegram.org/bots/api#getfile)、[语音发送](https://core.telegram.org/bots/api#sendvoice)。
