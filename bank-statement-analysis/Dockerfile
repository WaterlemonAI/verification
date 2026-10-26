FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends clamav clamav-daemon libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY scripts/install_ocr_models.py ./scripts/install_ocr_models.py
COPY scripts/install_paddle_models.py ./scripts/install_paddle_models.py
COPY scripts/start_clamav.sh ./scripts/start_clamav.sh
COPY clamd.conf freshclam.conf ./
RUN pip install --no-cache-dir .
RUN python scripts/install_ocr_models.py --target /app/models
RUN python scripts/install_paddle_models.py --target /app/paddle-models
RUN useradd --uid 1000 --create-home bsa \
    && mkdir /data \
    && chown -R bsa:bsa /data /var/lib/clamav /var/log/clamav \
    && chmod 0555 /app/scripts/start_clamav.sh \
    && freshclam --config-file=/app/freshclam.conf --stdout \
    && clamscan --version \
    && clamscan --no-summary /etc/hostname
USER bsa
ENV PYTHONPATH=/app/src
ENV BSA_OCR_MODEL_ROOT=/app/models
ENV BSA_PADDLE_MODEL_ROOT=/app/paddle-models
CMD ["sh", "-c", "if [ \"${BSA_AZURE_WORKER:-0}\" = \"1\" ]; then exec python -m bsa.azure_worker; else exec python -m bsa.worker --watch --data-dir /data; fi"]
