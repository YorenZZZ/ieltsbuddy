# 2026-10-03 03:52 · Docker 发布凭据名称兼容

- 时间：Asia/Shanghai
- 对应分支：`main`
- 相关提交：`fix: support configured Docker Hub secret name`
- 记录性质：发布工作流修复

## 用户目标

完成已授权的 Docker Hub 公开镜像发布，并提供 amd64 与 arm64 镜像。

## 沟通结论

用户已自行生成 Token 并保存在 GitHub Secret `YORENZZZ`，确认该项是 Token。首次云端测试成功，但发布因标准凭据名称尚未配置而在登录步骤失败。采用兼容已有 Secret 名称的方式继续发布，不需要维护者再次复制凭据。

## 实施记录

Docker 登录步骤优先读取标准 `DOCKERHUB_TOKEN`，缺省回退 `YORENZZZ`；用户名优先读取 `DOCKERHUB_USERNAME`，缺省为本仓库公开镜像命名空间 `yorenzzz`。README 同步说明。镜像仍由 GitHub Actions 在测试后构建两种架构，NAS 正式版本未替换。

## 验证结果

此前首次 Actions 云端 test 成功，publish 的失败日志明确为登录缺少 username/password。仅核对 GitHub Secret 名称并取得用户对内容类型的确认；未读取 Secret 值。本次执行工作流字段静态校验、公开文件扫描、差异空白检查与推送钩子。云端发布与公开 manifest 待本次推送触发后验收。

## 教程提炼

工作流引用的 Secret 名称必须与仓库设置一致。用户名不是 Token；Token 值只由维护者在 GitHub 设置保存，工作流在受控登录步骤使用。公开工作流可以兼容名称而无须复制或暴露值。

## 隐私检查

改动只包含公开用户名与 Secret 名称，无任何 Token 值或运行密钥。真实 AI 配置和持久数据仍位于私有 NAS，发布不修改正式部署、凭据位置或调度。
