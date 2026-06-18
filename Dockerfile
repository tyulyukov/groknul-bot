FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    libffi-dev \
    libssl-dev \
    libxslt1-dev \
    python-is-python3 \
    python3-babel \
    python3-dev \
    python3-venv \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 https://github.com/searxng/searxng.git /opt/searxng \
  && python3 -m venv /opt/searxng-venv \
  && /opt/searxng-venv/bin/pip install -U pip setuptools wheel \
  && /opt/searxng-venv/bin/pip install -U pyyaml msgspec typing-extensions pybind11 \
  && cd /opt/searxng \
  && /opt/searxng-venv/bin/pip install --use-pep517 --no-build-isolation -e .

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV SEARXNG_BASE_URL=http://127.0.0.1:8080
ENV SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
ENV SEARXNG_BIND_ADDRESS=127.0.0.1
ENV SEARXNG_PORT=8080

RUN mkdir -p /etc/searxng \
  && cp deploy/searxng/settings.yml /etc/searxng/settings.yml \
  && chmod +x deploy/start.sh

EXPOSE 3000

CMD ["./deploy/start.sh"]
