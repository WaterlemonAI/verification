FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY scripts/install_ocr_models.py ./scripts/install_ocr_models.py
COPY scripts/install_paddle_models.py ./scripts/install_paddle_models.py
RUN pip install --no-cache-dir .
RUN python scripts/install_ocr_models.py --target /app/models
RUN python scripts/install_paddle_models.py --target /app/paddle-models
RUN useradd --uid 1000 --create-home bsa && mkdir /data && chown bsa:bsa /data
USER bsa
ENV PYTHONPATH=/app/src
ENV BSA_OCR_MODEL_ROOT=/app/models
ENV BSA_PADDLE_MODEL_ROOT=/app/paddle-models
CMD ["python", "-m", "bsa.worker", "--watch", "--data-dir", "/data"]
