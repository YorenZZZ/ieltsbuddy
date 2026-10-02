ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
# 可在本地构建时指定镜像源；发布构建默认使用官方 Alpine 源。
ARG ALPINE_MIRROR=
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s#https://dl-cdn.alpinelinux.org#$ALPINE_MIRROR#" /etc/apk/repositories; fi \
  && apk add --no-cache poppler-utils ffmpeg
WORKDIR /app
COPY package.json server.mjs LICENSE ./
COPY src ./src
COPY public ./public
ENV PORT=18895 HOST=0.0.0.0 DATA_DIR=/data IELTS_LIBRARY_DIR=/library
EXPOSE 18895
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--" , "server.mjs"]
