# Фронтенд Kortix

## Быстрая настройка

Самый простой способ настроить фронтенд — воспользоваться мастером установки из корня проекта:

```bash
cd .. # Перейдите в корень проекта, если вы находитесь в каталоге frontend
python3 setup.py
```

Это автоматически настроит все необходимые переменные окружения.

## Настройка окружения

Мастер установки автоматически создаёт файл `.env.local` со следующими параметрами:

```sh
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000/api
NEXT_PUBLIC_URL=http://localhost:3000
NEXT_PUBLIC_ENV_MODE=LOCAL
```

## Начало работы

Установите зависимости:

```bash
npm install
```

Запустите сервер разработки:

```bash
npm run dev
```

Соберите приложение для продакшена:

```bash
npm run build
```

Запустите продакшен‑сервер:

```bash
npm run start
```

## Заметки по разработке

- Фронтенд подключается к backend‑API по адресу `http://localhost:8000/api`
- Supabase используется для аутентификации и операций с базой данных
- Приложение по умолчанию доступно на `http://localhost:3000`
- Переменные окружения автоматически настраиваются мастером установки
