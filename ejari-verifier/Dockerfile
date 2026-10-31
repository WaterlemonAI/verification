FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
RUN useradd --uid 1000 --create-home ejari
USER ejari
ENV PYTHONPATH=/app/src
CMD ["python", "-m", "ejari_verifier.azure_worker"]
