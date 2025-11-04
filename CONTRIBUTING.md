# Contributing to TAS

Thank you for your interest in contributing to TAS!

## Development Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/tas.git
   cd tas
   ```
3. Install dependencies:
   ```bash
   poetry install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Making Changes

- Follow existing code style
- Add tests for new features
- Update documentation as needed
- Run tests before committing:
  ```bash
  poetry run pytest tests/
  ```

## Submitting Changes

1. Commit your changes:
   ```bash
   git commit -m "Description of changes"
   ```
2. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
3. Create a Pull Request on GitHub

## Code Style

- Use type hints
- Follow PEP 8
- Keep functions focused and small
- Add docstrings for public functions

## Testing

Run the test suite:
```bash
poetry run pytest tests/
```

Test on report.csv:
```bash
poetry run python tests/test_report_csv.py
```

## Questions?

Feel free to open an issue for any questions or discussions.

