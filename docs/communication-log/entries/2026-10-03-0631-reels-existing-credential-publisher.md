# 临时分支复用现有 Docker 发布凭据

时间：2026-10-03 06:31（Asia/Shanghai）。

## 用户目标

用户要求发布独立 Reels 镜像，随后明确不要重新设置凭据，直接使用此前的 Docker Hub Token。

## 沟通结论

既有 Secret 值不能由 GitHub 读出或复制。本次在单独 codex/reels-publish 分支复用原仓库 Secret，工作流只手动触发、只检出公开 Reels 固定提交；不合并主分支、不改 IeltsBuddy 产品代码、不重新设置 Secret。

## 实施记录

临时分支的现有 docker.yml 手动发布流程指向 YorenZZZ/reels 提交 8bda1a2。先运行 Reels 语法、隐私、19项测试，再用原 Secret 登录并构建 linux/amd64 和 linux/arm64；目标镜像 yorenzzz/reels，标签 latest 与 1.1.2，OCI 说明、源码链接、版本与MIT统一登记。新增六节纪要和真实提交索引。

## 验证结果

固定 Reels 源码已经本地 19/19 与 GitHub 云端 Test 成功。既有发布 Secret 名称确认存在，仅核对名称而未读取值。本分支文件隐私扫描与提交差异检查通过；真实镜像发布以本次 Actions 运行和 Docker Hub 标签为准。

## 教程提炼

需要复用只可写不可读的 CI Secret 时，在原 Secret 所在仓库运行固定目标源码的手动工作流，可避免提取、复制或重新录入凭据。固定源码提交、镜像目标和仅手动入口，防止误发其他项目。

## 隐私检查

仅引用 Secret 名称，不含值、生产地址、运行数据或个人笔记。公开Reels源码经过独立白名单脱敏；工作流只构建源码，账户和视频不入镜像。
