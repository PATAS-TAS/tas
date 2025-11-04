FROM python:3.10-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install --upgrade pip && \
    pip install poetry

COPY pyproject.toml poetry.lock* ./
COPY README.md ./

RUN poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction --no-root --no-dev

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

