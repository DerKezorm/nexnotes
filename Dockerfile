# nexnotes as a single container.
#
# Two stages: the interface is built first, then only the finished files go into the image. Node and
# node_modules stay out; at runtime FastAPI serves the built files itself.

# --- Stage 1: build the interface ------------------------------------------------------------------
#
# --platform=$BUILDPLATFORM: the image is built for amd64 and arm64. Without it this stage would run under
# emulation too, and "npm ci" under emulated ARM is very slow. Only /build/dist moves on from here.
FROM --platform=$BUILDPLATFORM node:22-alpine AS interface

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# --- Stage 2: runtime ------------------------------------------------------------------------------
FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NEXNOTES_DATA_DIR=/data \
    NEXNOTES_FRONTEND_DIST=/app/static

WORKDIR /app

# curl for the healthcheck, gosu to drop root at start, ffmpeg (with ffprobe) for the length and the picture of an
# attached video. Tesseract reads the text of pictures, scans and PDFs, with the nine languages the settings offer
# (German and English from the start): all of them are in the image, nothing is loaded at run time. The language data
# are Debian's fast models, about 39 MB together with the one for the orientation of a page; Tesseract and its
# libraries add about 8 MB on top of what ffmpeg brings already.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gosu ffmpeg \
        tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-spa tesseract-ocr-ita \
        tesseract-ocr-nld tesseract-ocr-por tesseract-ocr-pol tesseract-ocr-tur \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=interface /build/dist ./static

# The user nexnotes runs as. The container starts as root and drops the rights in the entrypoint. The code and the
# interface stay root's: whoever got to run something as nexnotes could otherwise change what every browser loads.
RUN useradd --system --create-home --uid 1000 nexnotes \
    && mkdir -p /data \
    && chown -R nexnotes:nexnotes /data

COPY docker/entrypoint.sh /entrypoint.sh
# Strips Windows line endings: checked out on Windows the script would not start otherwise.
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${NEXNOTES_PORT:-8000}/api/health" || exit 1

# One worker: SQLite, and the live rooms of the open notes live in this process.
ENTRYPOINT ["/entrypoint.sh"]
# No --forwarded-allow-ips "*": which proxies may speak for a sender is decided inside the app
# (NEXNOTES_TRUSTED_PROXIES), so that nobody can dodge the sign-in brake with a made-up X-Forwarded-For.
# No access log: nexnotes logs each request itself, with tokens in paths masked; uvicorn's lines would carry them.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--workers", "1", "--no-proxy-headers", "--no-access-log"]
