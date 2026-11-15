# Notify 生产镜像：与 Mindwtr Cloud 官方镜像同生态，直接用 Bun 跑 TypeScript
FROM oven/bun:1.3-alpine

WORKDIR /app

# 项目零第三方依赖，直接拷贝运行必需的源码即可，无需 bun install。
# 只放 package.json 与 src/：scripts/ 里的探针、造数、远端运维脚本都属开发期工具，
# 其中 seed-test-data.mjs 能写测试实例，绝不能出现在生产镜像里（目标 E）。
# 构建上下文的排除规则统一放在项目根目录 .dockerignore，两处一起看。
COPY package.json ./
COPY src ./src

# 状态库放在挂载卷里，容器重建不会丢去重记录
ENV NOTIFY_STATE_PATH=/app/data/notify.sqlite
ENV HEALTHZ_PORT=8788
VOLUME ["/app/data"]

EXPOSE 8788

CMD ["bun", "run", "src/cli.ts"]
