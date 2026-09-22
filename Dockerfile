FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    REPLAY_DB_PATH=/data/replay.db

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY templates ./templates
COPY static ./static

# 数据库存放在挂载卷中,启动时由 init_db() 自动建表
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

# 容器内用 waitress 这种生产级 WSGI 服务器更稳妥;
# 为保持零额外依赖,这里直接用 Flask 内建服务器(本地工具足够)。
CMD ["python", "-m", "app.main"]
