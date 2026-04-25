# Dockerfile for Presidio baseline service (benchmark use)
FROM python:3.11-slim

WORKDIR /app

# Install Presidio + Flask + spaCy model (single-line to avoid line-continuation issues)
RUN pip install --no-cache-dir --quiet presidio-analyzer flask "en-core-web-lg @ https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl" && true

# Copy the Presidio service wrapper
COPY src-tauri/presidio_service.py /app/presidio_service.py

# Expose default Presidio service port
EXPOSE 5000

# Health check endpoint
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -f http://localhost:5000/health || exit 1

# Run the Flask service
CMD ["python", "presidio_service.py"]
