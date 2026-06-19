FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    libffi-dev \
    libgomp1 \
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

ENV HF_HOME=/opt/whisper-cache
ENV WHISPER_MODEL=base
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE_TYPE=int8
ENV WHISPER_PYTHON_PATH=/opt/whisper-venv/bin/python

RUN python3 -m venv /opt/whisper-venv \
  && /opt/whisper-venv/bin/pip install -U pip setuptools wheel \
  && /opt/whisper-venv/bin/pip install --no-cache-dir faster-whisper \
  && /opt/whisper-venv/bin/python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ.get('WHISPER_MODEL', 'base'), device=os.environ.get('WHISPER_DEVICE', 'cpu'), compute_type=os.environ.get('WHISPER_COMPUTE_TYPE', 'int8'))"

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
