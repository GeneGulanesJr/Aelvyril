# Dockerfile for Aelvyril mock /analyze endpoint (benchmark use)
FROM python:3.11-slim

WORKDIR /app
COPY benchmarks/mock_service.py /app/mock_service.py

EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=2s --start-period=2s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["python", "mock_service.py"]
