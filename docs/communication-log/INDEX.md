# 沟通与开发纪要索引

| 时间（Asia/Shanghai） | 主题 | 对应提交 | 结果 |
| --- | --- | --- | --- |
| 2026-10-03 03:30 | IeltsBuddy 首次公开发布 | `feat: publish self-hosted IELTS tutor` | 脱敏源码、中文安装教程、MIT 许可及多架构镜像发布工作流；31/31 本地测试与 NAS 隔离运行通过，镜像以 Actions 实际结果为准 |
| 2026-10-03 03:52 | Docker 发布凭据名称兼容 | `fix: support configured Docker Hub secret name` | 兼容维护者已保存的 Token Secret 名称，云端镜像发布以实际结果为准 |

| 2026-10-12 | [留迹独立镜像发布](entries/2026-10-12-liuji-image.md) | 本纪要所在提交 | 仅新增独立发布工作流 |
| 2026-10-12 | [留迹首发镜像固定源码](entries/2026-10-12-liuji-final-image.md) | 本纪要所在提交 | 使用通过清洁安装验证的最终源码 |
| 2026-10-12 | [留迹官方基础镜像重建](entries/2026-10-12-liuji-official-base.md) | 本纪要所在提交 | 修复ECR限流，包含最新删除确认规则 |
