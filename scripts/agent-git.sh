#!/usr/bin/env bash
# 以「Notify Agent」身份执行任意 git 命令，与仓库所有者自己的提交区分开。
#
# 为什么需要它：
#   仓库的默认 git 身份属于所有者（zlay0701），而 AI 助手代做的改动应当一眼可辨认，
#   否则历史里全是同一个作者，无法区分「人改的」和「助手改的」。
#   本脚本只在**本次命令**里临时覆盖 user.name / user.email，不改动 .git/config，
#   所以所有者自己执行 git commit 时仍然是他本人。
#
# 为什么还要关掉 GPG 签名：
#   仓库配置了 commit.gpgsign=true，签名需要 pinentry 输入密码，助手在非交互环境里拿不到密码；
#   同时「是否签名」正好可以作为第二重区分标记：
#   所有者自己的提交是签名 / Verified，助手提交是未签名（unverified）。
#
# 用法：
#   scripts/agent-git.sh status
#   scripts/agent-git.sh add -A
#   scripts/agent-git.sh commit -m "message"
#   scripts/agent-git.sh push origin main

set -euo pipefail

exec git \
  -c user.name="Notify Agent" \
  -c user.email="notify-agent@users.noreply.github.com" \
  -c commit.gpgsign=false \
  "$@"
