# SDK Kortix

[![Python](https://img.shields.io/badge/python-3.11+-blue.svg)](https://python.org)

> [!WARNING]
> **Этот SDK находится на ранней стадии разработки и НЕ готов для продакшена.**
> 
> API может меняться с обратной несовместимостью, функциональность может быть неполной, а документация — устаревшей. Используйте на свой страх и риск.

Python‑SDK, который позволяет создавать, управлять и взаимодействовать с AI‑работниками на платформе [Suna](https://suna.so).

## 📦 Установка

Установка напрямую из репозитория GitHub:

```bash
pip3 install "kortix @ git+https://github.com/kortix-ai/suna.git@main#subdirectory=sdk"
```

Или с помощью uv:

```bash
uv add "kortix @ git+https://github.com/kortix-ai/suna.git@main#subdirectory=sdk"
```

## 🔧 Quick Start
## 🔧 Быстрый старт

```python
import asyncio
from kortix import kortix

async def main():
    mcp_tools = kortix.MCPTools(
        "http://localhost:4000/mcp/",  # Укажите любой HTTP‑сервер MCP
        "Kortix",
    )
    await mcp_tools.initialize()

    # Инициализация клиента
    client = kortix.Kortix(api_key="your-api-key")

    # Создание агента
    agent = await client.Agent.create(
        name="My Assistant",
        system_prompt="Вы полезный AI‑ассистент.",
        mcp_tools=[mcp_tools],
        allowed_tools=["get_wind_direction"],
    )

    # Создание потока (thread) разговора
    thread = await client.Thread.create()

    # Запуск агента
    run = await agent.run("Hello, how are you?", thread)

    # Потоковая передача ответа
    stream = await run.get_stream()
    async for chunk in stream:
        print(chunk, end="")

if __name__ == "__main__":
    asyncio.run(main())
```

## 🔑 Настройка окружения

Получите API‑ключ по адресу [https://suna.so/settings/api-keys](https://suna.so/settings/api-keys)

## 🧪 Запуск примеров

```bash
# Установить зависимости
uv sync

# Запустить основной пример
PYTHONPATH=$(pwd) uv run example/example.py
```
