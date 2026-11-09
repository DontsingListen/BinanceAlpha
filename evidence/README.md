# 研究证据目录

这些文件把“研究过哪个版本”和“本包实际检查了什么”固定下来，方便第三方重新核对。

| 文件 | 内容 |
| --- | --- |
| [upstream-snapshot.json](upstream-snapshot.json) | 四个主要候选的完整提交、默认分支、许可标识和检查日元数据；主候选的代表性源码/测试路径 |
| [source-checks.json](source-checks.json) | 实际读取的固定版本源文件 URL、行数及原始字节 SHA256 |
| [official-sources.json](official-sources.json) | Binance 官方资料链接、支持的事实和验证边界 |
| [aleks-ent-LICENSE.txt](aleks-ent-LICENSE.txt) | 主底本固定提交的 MIT 许可证原文 |
| [tradermonty-LICENSE.txt](tradermonty-LICENSE.txt) | VCP 参考项目固定提交的 MIT 许可证原文 |
| [package-manifest.json](package-manifest.json) | 当前交接文件的字节数和 SHA256，不包含它自身 |
| [package-verification.md](package-verification.md) | 本包检查内容及剩余验证工作 |

GitHub 的 pushed_at 与所选默认分支 commit_date 含义不同，可能不相等；本包不将前者写成该文件的修改日期。无 LICENSE 的项目未作为代码复制来源。

校验来源时，从 source-checks 中的完整 commit URL 获取原始字节，再与 sha256 比较。没有保存上游应用源码副本，也没有执行该源码。许可证文件保留上游原文；今后真的移植时仍需把来源说明放在对应代码和第三方声明中。

本地完整性检查：

```bash
python3 tools/verify_handoff.py
```

命令从交接包根目录运行。manifest 的用途是检测意外改动，并非数字签名或第三方信任认证。修改交接文档后应重新审核并生成新的 manifest，不能通过修改哈希掩盖未经说明的内容变化。

外部 URL 的在线可用性会变化；完整 commit 和源码哈希使版本识别不依赖 `main` 的未来内容。仅有 URL 或哈希不构成测试通过或策略有效的证据。
