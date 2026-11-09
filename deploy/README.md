# 部署（alpha-host，/opt/binance-alpha）

`alpha-host` 是示例 SSH 别名，请替换为自己的部署目标。按 `config/social.example.json` 在服务器配置私有的 `config/social.json`；该文件不随 Git 发布。

三个 systemd 单元，两个 Unix 用户：

| 单元 | 用户 | 作用 | 写入 |
| --- | --- | --- | --- |
| `binance-alpha.service` | binance-alpha | K 线采集 + 二段状态机 + 本地告警（`watch`） | `data/`（K 线、journal、事件、告警） |
| `binance-alpha-social.service` | binance-alpha | X 轮询（xAI `x_search`）+ Telegram 交接目录消费 + MENTION 告警（`social`） | `data/`（social_* 表、告警）、`telegram-inbox/ack.json` |
| `binance-alpha-telegram.service` | binance-alpha-telegram | Telethon 只读会话，把白名单频道的新消息写入交接目录 | `/var/lib/binance-alpha-telegram/private`、`/var/lib/binance-alpha/telegram-inbox` |

## 更新代码（已有部署）

```bash
rsync -a --delete --exclude data --exclude node_modules --exclude reports --exclude .git --exclude .wolf --exclude .claude --exclude .codex --exclude .private --exclude config/social.json \
  ./ alpha-host:/tmp/binance-alpha-src/
ssh alpha-host 'sudo rsync -a --delete --exclude data --exclude config/social.json /tmp/binance-alpha-src/ /opt/binance-alpha/ && sudo chown -R root:binance-alpha /opt/binance-alpha && sudo chown -R binance-alpha:binance-alpha /opt/binance-alpha/data && cd /opt/binance-alpha && sudo -u binance-alpha env HOME=/var/lib/binance-alpha PATH=/opt/node-v26.13.0-linux-x64/bin:$PATH npm test'
ssh alpha-host 'sudo install -m 0644 /opt/binance-alpha/tools/telegram-reader/reader.py /opt/binance-alpha-telegram/reader.py'
ssh alpha-host 'sudo systemctl restart binance-alpha.service binance-alpha-social.service && (systemctl is-enabled --quiet binance-alpha-telegram.service && sudo systemctl restart binance-alpha-telegram.service || true)'
```

源码哈希变化会让 `watch` 新建一次 online run（全量重放历史，约 75 s）；之后的重启复用同一 run。社交进程重启不会追加 X 轮询：是否到点由数据库里的轮询记录决定（`config/social.json` 的 `x.schedule`）。

## 社交监控首次安装

```bash
ssh alpha-host 'sudo install -d -m 0750 -o root -g binance-alpha /etc/binance-alpha && sudo install -m 0640 -o root -g binance-alpha /opt/binance-alpha/deploy/social.env.example /etc/binance-alpha/social.env'
# 然后 sudo -e /etc/binance-alpha/social.env 填入 XAI_API_KEY（不要经聊天或命令行参数传递）
ssh alpha-host 'sudo install -m 0644 /opt/binance-alpha/deploy/binance-alpha-social.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now binance-alpha-social.service'
```

Telegram 读取器：

```bash
ssh alpha-host 'sudo useradd -r -s /usr/sbin/nologin -d /var/lib/binance-alpha-telegram -G binance-alpha binance-alpha-telegram 2>/dev/null; \
  sudo install -d -m 0700 -o binance-alpha-telegram -g binance-alpha /var/lib/binance-alpha-telegram && \
  sudo install -d -m 2770 -o binance-alpha-telegram -g binance-alpha /var/lib/binance-alpha/telegram-inbox && \
  sudo install -d -m 0755 -o root -g root /opt/binance-alpha-telegram && \
  sudo python3 -m venv /opt/binance-alpha-telegram/venv && sudo /opt/binance-alpha-telegram/venv/bin/pip install --quiet "telethon>=1.36,<2" && \
  sudo install -m 0644 /opt/binance-alpha/tools/telegram-reader/reader.py /opt/binance-alpha-telegram/reader.py && \
  sudo install -m 0644 /opt/binance-alpha/deploy/binance-alpha-telegram.service /etc/systemd/system/ && \
  sudo install -m 0755 /opt/binance-alpha/deploy/binance-alpha-telegram-login /usr/local/bin/binance-alpha-telegram-login && sudo systemctl daemon-reload'
```

登录只能由用户在终端交互完成（需要 my.telegram.org 的 API ID/Hash、手机号、验证码、两步验证密码；均不回显）：

```bash
ssh -t alpha-host sudo binance-alpha-telegram-login
```

之后增加频道：`ssh -t alpha-host sudo binance-alpha-telegram-login add-channel`（账号须已在频道/群内；最多 10 个）。

手机号可以预填（不是密钥；向导里按回车即用），API ID/Hash 和验证码仍只在向导里输入：

```bash
ssh alpha-host "printf '{\"phone\":\"+<国家区号><号码>\"}' | sudo -u binance-alpha-telegram -H /opt/binance-alpha-telegram/venv/bin/python /opt/binance-alpha-telegram/reader.py configure-phone"
```

向导输出 `CODE_REQUEST_FAILED_RETRY_LOGIN` 表示验证码请求在 Telethon 侧重试耗尽（历史原因：请求重试为 0 时，号码所在数据中心迁移后没有第二次尝试）；等 90 秒再执行 login 即可，不会重复发码。

## 验证

```bash
ssh alpha-host 'systemctl status binance-alpha binance-alpha-social binance-alpha-telegram --no-pager | grep -E "●|Active"'
ssh alpha-host 'sudo journalctl -u binance-alpha-social -n 20 --no-pager'
ssh alpha-host 'cd /opt/binance-alpha && sudo -u binance-alpha env HOME=/var/lib/binance-alpha PATH=/opt/node-v26.13.0-linux-x64/bin:$PATH npm run -s alpha:status'
```

关闭：`sudo systemctl disable --now binance-alpha-telegram.service`；撤销账号会话在 Telegram「设置 → 设备」。私有会话目录不会自动删除。
