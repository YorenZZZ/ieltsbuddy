# IeltsBuddy

[公开源码](https://github.com/YorenZZZ/ieltsbuddy) · [Docker Hub](https://hub.docker.com/r/yorenzzz/ieltsbuddy) · [MIT 许可](LICENSE)

运行在 NAS Docker 上的 AI 雅思私教，支持中文界面、听说读写训练、老师对话、练习批改、学习计划、词汇复习、口语素材与资料库。AI 评分供练习参考。

Mac 或其它电脑上的源码只用于开发。正式服务由 NAS 容器独立运行：程序打包在镜像中，账号、设置、练习、对话、资料索引和录音保存在 NAS 的 `/data` 挂载目录，学习资料从 NAS 目录只读挂载。无需 Mac 在线、电脑目录共享或电脑后台任务。备份 `/data` 时应停容器，或使用 SQLite 在线备份，避免漏掉 WAL 中的更新。

## 飞牛 Docker 图形界面安装

镜像名称：`yorenzzz/ieltsbuddy:latest`，支持 x86_64（amd64）和 ARM64。首次发布需由维护者先完成文末的镜像发布流程；发布完成前搜索或拉取可能找不到镜像。

1. 在 NAS 创建项目目录及其中的 `data`、`library` 文件夹。`library` 也可直接使用你已有的 NAS 雅思资料目录。
2. 打开飞牛 Docker → 镜像仓库，搜索 `yorenzzz/ieltsbuddy` 并下载 `latest`。
3. 创建容器，容器端口 `18895` 映射到 NAS 端口 `18895`，重启策略选自动重启。
4. 将 NAS 的 `data` 目录映射到容器 `/data`（读写），NAS 的资料目录映射到 `/library`（只读）。创建容器时不需要填写 AI 密钥，也不需要 Python 或终端配置。
5. 在可信局域网打开 `http://你的NAS地址:18895`，创建管理员用户名和密码（至少 10 位）。请先完成初始化，再开放外网入口。未登录可浏览功能介绍和题型目录；实际功能、设置和个人资料均需要登录。
6. 打开「设置」，填写主AI并测试通过后保存，语音转写可选；保存学员档案后再到「云盘」扫描资料库。

## Compose 安装

在飞牛 Docker 的 Compose 项目里粘贴以下配置，将 `./library` 换为你的 NAS 资料目录。通过终端安装时，把它保存为 `compose.yaml`，在 NAS 上运行 `docker compose up -d`。

```yaml
services:
  ieltsbuddy:
    image: yorenzzz/ieltsbuddy:latest
    container_name: ieltsbuddy
    restart: unless-stopped
    ports:
      - "18895:18895"
    environment:
      HOST: 0.0.0.0
      PORT: "18895"
      DATA_DIR: /data
      IELTS_LIBRARY_DIR: /library
      NODE_USE_ENV_PROXY: "1"
      NO_PROXY: localhost,127.0.0.1,::1
    volumes:
      - ./data:/data
      - ./library:/library:ro
```

完整示例见 [compose.example.yaml](compose.example.yaml)。源码里的 `compose.yaml` 用于本地构建，运行 `docker compose up -d --build`；已发布镜像安装使用上面的 `image` 配置。

## 网页设置

- **主 AI**：填写 OpenAI 兼容的接口基础地址（通常以 `/v1` 结尾）、API 密钥和服务商实际支持的模型名。可使用 OpenAI、HolySheep 或其它兼容服务；不要填写 `/chat/completions` 完整端点。
- **语音转写**：默认接口 `https://api.groq.com/openai/v1`，默认模型 `whisper-large-v3`；填写 Groq 密钥，或更换为支持 OpenAI 音频转写接口的服务。
- **资料目录**：填写容器内路径，通常为 `/library`。网页不能替代 Docker 目录映射；更换 NAS 宿主机目录须先调整挂载并重建容器，再扫描资料库。
- **验证与保存**：每类 AI 先测试通过，再保存立即生效。测试绑定接口地址、密钥及模型的完整配置，验证时间戳存入项目 SQLite；修改任一项后原测试不能用于保存。保存按钮下方提示未验证或保存失败。最新测试失败会使对应已保存配置不可用，重新测试成功后恢复。测试中的配置被编辑或旧测试晚返回时，也不能冒充新版配置通过。
- **密钥与兼容**：保存立即生效，无需重启；密钥只显示掩码，输入框留空保持原密钥。地址、模型和资料路径留空使用环境变量默认值。新安装无需 `.env`；旧部署的 `.env` 登录与 AI 参数仍兼容，完整 Compose 示例会读取这些私有环境变量。原密钥留在 NAS，不需要重新输入；升级后原 AI 配置仍需测试通过并保存才能启用。不得把实际 `.env` 公开或打包。
- **模型费用**：保存设置与查看状态不会调用 AI；点击测试连接会发送真实的短对话或内置两秒测试音频，可能产生少量费用，语音测试不申请麦克风权限；主动发起对话、出题、批改、生成计划、语音转写等功能会请求你配置的服务，并可能产生费用。

未填写或未验证保存语音转写配置时，话筒禁用。验证通过后，点击话筒才向浏览器申请麦克风授权；浏览器已拒绝或系统禁用时会提示先打开权限。录音功能需要 HTTPS（本机 localhost 开发除外）。请在 NAS 反向代理中配置 HTTPS 并转发到容器端口；浏览器访问内网 HTTP 可以练习和打字，但通常无法录音。

资料支持 PDF、文本以及 ZIP 内的资料与音频；PDF 抽字使用镜像内的 Poppler，音频处理使用 ffmpeg，扫描版 PDF 没有文字层时不会自动 OCR。未挂载外部雅思计划也能独立使用所有核心功能；`WORKBENCH_PLAN_PATH` 仅为可选的容器内只读模块路径。

若服务商需要代理，可在容器环境变量填 `HTTPS_PROXY`、`HTTP_PROXY`，并保留 `NODE_USE_ENV_PROXY=1`。代理必须能从 NAS 容器访问；桥接网络中的 `127.0.0.1` 指容器自身。正式运行不要使用 Mac 上的代理。

## 访客、历史与多设备

未登录可浏览技能工具箱、题型、课程主题和其他模块介绍，触发具体功能时提示登录；设置内容、学员档案、资料文件和个人历史始终需要服务端鉴权。登录后 AI 尚未验证保存，触发 AI 功能会显示三秒顶部警告，可直接前往设置的主AI模块，出现与隐藏均有动效。

已保存的服务设置、学员档案、练习与作答草稿、模考、课程、词汇、口语素材及对话保存在 NAS 项目数据目录中的 SQLite，录音也位于该目录。对话可以单独删除或清除全部，操作前会二次确认；清除范围仅限历史对话与消息，保留设置和练习记录。练习输入会自动保存；保存失败会在作答区域显示提示。

电脑宽屏显示侧栏、内容和老师对话；iPad 与较窄电脑将老师对话改为抽屉；手机同时将侧栏改为抽屉，表单改为单列。页面适配横竖屏与安全区域，触摸设备始终显示对话删除入口，支持键盘 Escape 关闭浮层并尊重减少动态效果设置。

## 更新与备份

更新镜像后使用原来的 NAS `/data` 和 `/library` 挂载重建容器，管理员、设置和学习记录会保留。通过 Compose 安装可运行 `docker compose pull && docker compose up -d`。备份的 `/data` 包含 API 密钥和账号信息，应作为私密资料保存；不要上传到 GitHub、镜像或公开网盘。健康检查使用 `/api/health`；未登录时只返回服务存活状态，不泄露配置。

## 开发与镜像发布

需要 Node.js 24+，测试还需要带 scrypt 的 Python 3、`zip` 和 `unzip`；完整资料处理需要 `pdftotext` 与 `ffmpeg`。运行 `npm test`；本地开发用临时数据目录，例如 `DATA_DIR=/tmp/ieltsbuddy-dev PORT=18895 npm start`，请勿复制 NAS 的真实数据库或密钥到开发机。

[GitHub Actions 多架构构建](https://docs.docker.com/build/ci/github-actions/multi-platform/)配置在 `.github/workflows/docker.yml`：PR 只测试，`main` 推送、版本标签 `v*` 或手动触发在测试通过后构建 `linux/amd64` 和 `linux/arm64`。主分支发布 `latest` 与提交标签；版本标签发布对应版本号。

维护者自行在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN`。本仓库也兼容将 Token 保存为 `YORENZZZ`，未设置用户名时默认使用 `yorenzzz`。请确保 Docker Hub 的 `yorenzzz/ieltsbuddy` 仓库为公开。不要把 Docker Hub Token 写进源码、README 或 Compose。首次公开推送前必须完成脱敏确认；镜像是否已发布以 Actions 成功结果及 Docker Hub 实际标签为准。

旧的 `configure.py` 仅保留给已有 NAS 终端部署使用，需宿主机 Python 3；镜像不含 Python。新安装请直接在网页初始化，网页保存的 AI 参数优先于环境变量。
