FROM python:3.10-slim

WORKDIR /app

RUN pip install poetry
COPY pyproject.toml poetry.lock* ./
COPY README.md ./
RUN poetry config virtualenvs.create false && poetry install --only main --no-interaction --no-root

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

