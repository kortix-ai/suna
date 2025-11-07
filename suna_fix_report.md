# Отчет по исправлению проблемы подключения Suna AI

## Диагностика проблемы

### Обнаруженные проблемы

1. **Отсутствие файла `.env` в frontend**
   - В директории `frontend/` присутствует только `.env.example`
   - Фронтенд не может получить значение `NEXT_PUBLIC_BACKEND_URL`
   - По умолчанию в коде используется пустая строка: `const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';`

2. **Неправильный URL бэкенда**
   - В `.env.example` указано: `NEXT_PUBLIC_BACKEND_URL="http://localhost:8000/api"`
   - Обратите внимание на `/api` в конце - это может быть проблемой, если ваш бэкенд работает на `http://localhost:8000` без префикса `/api`

3. **Отсутствие конфигурации Supabase**
   - Переменные `NEXT_PUBLIC_SUPABASE_URL` и `NEXT_PUBLIC_SUPABASE_ANON_KEY` не заполнены
   - Это приведет к ошибкам аутентификации

### Как фронтенд подключается к бэкенду

Фронтенд использует следующие файлы для API-запросов:
- `src/lib/api-client.ts` - основной клиент API
- `src/lib/api.ts` - дополнительные API методы
- Все запросы используют `process.env.NEXT_PUBLIC_BACKEND_URL` как базовый URL

## Решение проблемы

### 1. Создание файла `.env` для фронтенда

Необходимо создать файл `frontend/.env` со следующим содержимым:

```env
# Режим окружения
NEXT_PUBLIC_ENV_MODE="local"

# URL фронтенда
NEXT_PUBLIC_URL="http://localhost:3000"

# URL бэкенда (ВАЖНО: проверьте правильность URL!)
# Если ваш бэкенд работает на http://localhost:8000, используйте:
NEXT_PUBLIC_BACKEND_URL="http://localhost:8000"
# Если бэкенд использует префикс /api, то:
# NEXT_PUBLIC_BACKEND_URL="http://localhost:8000/api"

# Supabase (обязательно заполнить!)
NEXT_PUBLIC_SUPABASE_URL="https://your-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"

# Опционально
NEXT_PUBLIC_GOOGLE_CLIENT_ID=""
NEXT_PUBLIC_POSTHOG_KEY=""
KORTIX_ADMIN_API_KEY=""
```

### 2. Создание файла `.env` для бэкенда

Также необходимо создать файл `backend/.env` с минимальными настройками:

```env
# Режим окружения
ENV_MODE=local

# Supabase (обязательно!)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Redis (для локального запуска)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_SSL=false

# LLM провайдер (хотя бы один!)
OPENAI_API_KEY=your-openai-key
# или
ANTHROPIC_API_KEY=your-anthropic-key

# Поиск и скрапинг (обязательно!)
TAVILY_API_KEY=your-tavily-key
RAPID_API_KEY=your-rapid-api-key
FIRECRAWL_API_KEY=your-firecrawl-key

# Админ ключ
KORTIX_ADMIN_API_KEY=your-admin-key
```

### 3. Проверка URL бэкенда

Проверьте, на каком URL работает ваш бэкенд:

1. Откройте `backend/api.py` и найдите, на каком порту запускается сервер
2. Проверьте, использует ли бэкенд префикс `/api` для всех роутов
3. Убедитесь, что в `NEXT_PUBLIC_BACKEND_URL` указан правильный URL

### 4. CORS настройки

Убедитесь, что в бэкенде настроены CORS для разрешения запросов с фронтенда:
- Бэкенд должен разрешать запросы с `http://localhost:3000`
- Проверьте настройки CORS в `backend/api.py`

## Оптимизация сборки фронтенда

### Проблемы медленной сборки

1. **Большое количество зависимостей** - проект использует множество тяжелых библиотек
2. **Отсутствие кэширования** - Next.js может не использовать кэш при первой сборке
3. **TypeScript проверки** - занимают много времени

### Рекомендации по ускорению

#### 1. Использование Turbopack (уже включено)
В `package.json` уже используется `--turbopack` для dev-режима:
```json
"dev": "next dev --turbopack"
```

#### 2. Настройка Next.js для production сборки

Создайте файл `frontend/.env.production` для production сборки:
```env
NEXT_OUTPUT=standalone
```

Это уменьшит размер финального билда.

#### 3. Использование SWC вместо Babel

Next.js уже использует SWC по умолчанию, но убедитесь, что нет файла `.babelrc`, который может переопределить это.

#### 4. Кэширование node_modules

При повторных сборках используйте:
```bash
# Не удаляйте node_modules при каждой сборке
# Используйте npm ci вместо npm install для CI/CD
npm ci
```

#### 5. Параллельная сборка

Если используете Docker, добавьте в `frontend/Dockerfile`:
```dockerfile
ENV NEXT_TELEMETRY_DISABLED 1
ENV NODE_OPTIONS="--max-old-space-size=4096"
```

#### 6. Использование pnpm вместо npm

pnpm быстрее и экономит место:
```bash
cd frontend
pnpm install
pnpm build
```

#### 7. Отключение Source Maps для production

В `frontend/next.config.ts` добавьте:
```typescript
const nextConfig = (): NextConfig => ({
  productionBrowserSourceMaps: false, // Отключить source maps
  // ... остальные настройки
});
```

#### 8. Incremental Static Regeneration

Для страниц, которые не меняются часто, используйте ISR:
```typescript
export const revalidate = 3600; // Перегенерация раз в час
```

### Измерение времени сборки

Используйте флаг `--profile` для анализа:
```bash
cd frontend
npm run build -- --profile
```

## Пошаговая инструкция по запуску

### Шаг 1: Настройка Supabase

1. Создайте проект на [supabase.com](https://supabase.com)
2. Получите URL и ключи из Settings → API
3. Запустите миграции из `backend/supabase/`

### Шаг 2: Настройка бэкенда

```bash
cd backend

# Создайте .env файл (скопируйте из .env.example и заполните)
cp .env.example .env
nano .env

# Установите зависимости
pip install -r requirements.txt

# Запустите бэкенд
python api.py
```

### Шаг 3: Настройка фронтенда

```bash
cd frontend

# Создайте .env файл
cp .env.example .env
nano .env

# Установите зависимости
npm install
# или используйте pnpm для ускорения
pnpm install

# Запустите в dev режиме
npm run dev
```

### Шаг 4: Проверка подключения

1. Откройте браузер: `http://localhost:3000`
2. Откройте DevTools (F12) → Console
3. Проверьте, нет ли ошибок подключения к `localhost:8000`
4. Проверьте Network tab - все запросы к API должны быть успешными

## Типичные ошибки и решения

### Ошибка: "Failed to fetch" или "Network Error"

**Причина:** Неправильный URL бэкенда или бэкенд не запущен

**Решение:**
1. Проверьте, что бэкенд запущен: `curl http://localhost:8000`
2. Проверьте `NEXT_PUBLIC_BACKEND_URL` в `frontend/.env`
3. Проверьте CORS настройки в бэкенде

### Ошибка: "CORS policy blocked"

**Причина:** Бэкенд не разрешает запросы с фронтенда

**Решение:**
В `backend/api.py` добавьте/проверьте:
```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### Ошибка: "Supabase client error"

**Причина:** Неправильные ключи Supabase

**Решение:**
1. Проверьте `NEXT_PUBLIC_SUPABASE_URL` и `NEXT_PUBLIC_SUPABASE_ANON_KEY`
2. Убедитесь, что проект Supabase активен
3. Проверьте, что RLS (Row Level Security) настроен правильно

### Медленная сборка фронтенда

**Решение:**
1. Используйте `pnpm` вместо `npm`
2. Увеличьте память для Node.js: `export NODE_OPTIONS="--max-old-space-size=4096"`
3. Используйте `npm run dev` вместо `npm run build` для разработки
4. Отключите source maps для production

## Дополнительные рекомендации

### Использование Docker Compose

Проект включает `docker-compose.yaml`. Для упрощения запуска:

```bash
# В корне проекта
docker-compose up -d
```

Это запустит все сервисы одновременно.

### Мониторинг производительности

Используйте Next.js Analytics:
```bash
npm install @vercel/analytics
```

### Логирование

Для отладки добавьте логирование в `frontend/src/lib/api-client.ts`:
```typescript
console.log('API Request:', url);
console.log('Backend URL:', process.env.NEXT_PUBLIC_BACKEND_URL);
```

## Итоговый чеклист

- [ ] Создан файл `frontend/.env` с правильными настройками
- [ ] Создан файл `backend/.env` с правильными настройками
- [ ] Настроен проект Supabase
- [ ] Бэкенд запущен и доступен на `http://localhost:8000`
- [ ] Фронтенд запущен и доступен на `http://localhost:3000`
- [ ] CORS настроен правильно
- [ ] Нет ошибок в консоли браузера
- [ ] API запросы проходят успешно
- [ ] Использован `pnpm` для ускорения установки зависимостей
- [ ] Настроены переменные окружения для оптимизации сборки
