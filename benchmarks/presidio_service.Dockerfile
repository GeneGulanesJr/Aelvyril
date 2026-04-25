# Dockerfile for Presidio baseline service (benchmark use)
FROM python:3.11-slim

WORKDIR /app

# Install Presidio + Flask (service deps)
RUN pip install --no-cache-dir --quiet \
    presidio-analyzer \
    flask \
    && true

# Copy the Presidio service wrapper
COPY src-tauri/presidio_service.py /app/presidio_service.py

# Expose default Presidio service port
EXPOSE 5000

# Health check endpoint
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -f http://localhost:5000/health || exit 1

# Run the Flask service
CMD ["python", "presidio_service.py"]
