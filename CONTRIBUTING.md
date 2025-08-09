# Contributing to Suna

Thank you for your interest in contributing to Suna! This document outlines the contribution process and guidelines.

## Contribution Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -am 'feat(your_file): add some feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

## Development Setup

### Quick Setup

The easiest way to get started is using our setup wizard:

```bash
python setup.py
```

This will guide you through configuring all required services and dependencies.

### Detailed Setup Instructions

For detailed setup instructions, please refer to:

- [Self-Hosting Guide](docs/SELF-HOSTING.md) - Complete setup instructions
- [Backend Development Setup](backend/README.md) - Backend-specific development
- [Frontend Development Setup](frontend/README.md) - Frontend-specific development

### Required Services

Before contributing, ensure you have access to:

**Required:**

- Supabase project (database and auth)
- LLM provider API key (OpenAI, Anthropic, or OpenRouter)
- Daytona account (for agent execution)
- Tavily API key (for search)
- Firecrawl API key (for web scraping)

**Optional:**

- RapidAPI key (for additional tools)
- Custom MCP server configurations

## Code Style Guidelines

- Follow existing code style and patterns
- Use descriptive commit messages
- Keep PRs focused on a single feature or fix
- Add tests for new functionality
- Update documentation as needed

## Reporting Issues

When reporting issues, please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node/Docker versions, etc.)
- Relevant logs or screenshots
- Configuration details (redacted API keys)

## Development Tips

- Use the setup wizard to ensure consistent configuration
- Check the troubleshooting section in the Self-Hosting Guide
- Test both Docker and manual setup when making changes
- Ensure your changes work with the latest setup.py configuration
