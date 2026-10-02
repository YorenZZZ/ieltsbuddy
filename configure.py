#!/usr/bin/env python3
"""IeltsBuddy 密钥与登录设置。

在 NAS 上运行：
    cd /path/to/ieltsbuddy && python3 configure.py

依次询问 HolySheep 密钥、Groq 密钥、登录用户名和密码；直接回车表示保持不变。
输入不回显，只写入本目录 .env（权限 600）；密码只保存 scrypt 加盐哈希。最后重启容器使配置生效。
"""
import getpass
import hashlib
import os
import secrets
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_PATH = HERE / ".env"
MIN_PASSWORD = 10


def read_lines():
    return ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []


def current(lines, key):
    for line in lines:
        if line.startswith(f"{key}="):
            return line[len(key) + 1:].strip().strip("'")
    return ""


def put(lines, key, value):
    # Compose 读取 .env 时会替换 $ 并解析引号，含这些字符的值一律拒绝，避免写进去的和容器读到的不一样。
    if any(ch in value for ch in "$'\"#\\") or any(ch.isspace() for ch in value):
        raise SystemExit(f"{key} 含有空白或 $ ' \" # \\ 等字符，请检查是否复制完整")
    for index, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[index] = f"{key}={value}"
            return
    lines.append(f"{key}={value}")


def write_lines(lines):
    temp = ENV_PATH.with_name(".env.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.chmod(temp, 0o600)
    os.replace(temp, ENV_PATH)


def ask_key(lines, step, label, key, prefix_hint):
    state = "已填写" if current(lines, key) else "未填写"
    value = getpass.getpass(f"{step} {label}（当前{state}，直接回车保持不变；输入不显示）：").strip()
    if not value:
        return False
    if prefix_hint and not value.startswith(prefix_hint):
        print(f"   提示：{label}通常以 {prefix_hint} 开头，请确认没有复制错。")
    put(lines, key, value)
    return True


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=64)
    return f"scrypt:{salt}:{digest.hex()}"


def main():
    if not sys.stdin.isatty():
        raise SystemExit("请在交互终端里运行（ssh 时加 -t）")
    lines = read_lines()
    changed = False
    print(f"IeltsBuddy 配置：只写入 {ENV_PATH}\n")

    changed |= ask_key(lines, "1/4", "HolySheep 密钥", "HOLYSHEEP_API_KEY", "")
    changed |= ask_key(lines, "2/4", "Groq 密钥", "GROQ_API_KEY", "gsk_")

    old_user = current(lines, "IELTSBUDDY_USERNAME")
    username = input(f"3/4 登录用户名（当前 {old_user or '未设置'}，直接回车保持不变）：").strip()
    if username:
        put(lines, "IELTSBUDDY_USERNAME", username)
        changed = True

    has_hash = bool(current(lines, "IELTSBUDDY_PASSWORD_HASH"))
    while True:
        password = getpass.getpass(f"4/4 登录密码（{'已设置' if has_hash else '未设置'}，直接回车保持不变；至少 {MIN_PASSWORD} 位）：")
        if not password:
            break
        if len(password) < MIN_PASSWORD:
            print(f"   密码太短，至少 {MIN_PASSWORD} 位。")
            continue
        if getpass.getpass("   再输入一次：") != password:
            print("   两次输入不一致，请重来。")
            continue
        put(lines, "IELTSBUDDY_PASSWORD_HASH", hash_password(password))
        changed = True
        break

    if len(current(lines, "IELTSBUDDY_SESSION_SECRET")) < 32:
        put(lines, "IELTSBUDDY_SESSION_SECRET", secrets.token_hex(32))
        changed = True

    if not current(lines, "IELTSBUDDY_USERNAME") or not current(lines, "IELTSBUDDY_PASSWORD_HASH"):
        print("\n注意：用户名和密码没有都设置，登录保护不会开启；此时只能局域网直连，经 Lucky 访问会被拒绝。")

    if not changed:
        print("\n没有改动。")
        return
    write_lines(lines)
    print("\n已写入 .env（权限 600）。")
    answer = input("现在重启容器使配置生效？[Y/n] ").strip().lower()
    if answer in ("", "y", "yes"):
        subprocess.run(["docker", "compose", "up", "-d"], cwd=HERE, check=True)
        print("已重启。打开页面「设置」可以看到各项状态。")
    else:
        print("稍后在本目录执行 docker compose up -d 即可生效。")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消，未写入。")
