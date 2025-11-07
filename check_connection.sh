#!/bin/bash

# ========================================
# Скрипт проверки подключения Suna AI
# ========================================

echo "🔍 Проверка конфигурации Suna AI..."
echo ""

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Счетчики
ERRORS=0
WARNINGS=0

# ========================================
# 1. Проверка файлов .env
# ========================================
echo "📁 Проверка файлов конфигурации..."

if [ -f "frontend/.env" ]; then
    echo -e "${GREEN}✓${NC} frontend/.env существует"
else
    echo -e "${RED}✗${NC} frontend/.env НЕ НАЙДЕН!"
    echo "  Создайте файл: cp frontend/.env.example frontend/.env"
    ERRORS=$((ERRORS + 1))
fi

if [ -f "backend/.env" ]; then
    echo -e "${GREEN}✓${NC} backend/.env существует"
else
    echo -e "${RED}✗${NC} backend/.env НЕ НАЙДЕН!"
    echo "  Создайте файл: cp backend/.env.example backend/.env"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# ========================================
# 2. Проверка переменных окружения фронтенда
# ========================================
echo "🔧 Проверка переменных окружения фронтенда..."

if [ -f "frontend/.env" ]; then
    # Проверка NEXT_PUBLIC_BACKEND_URL
    if grep -q "NEXT_PUBLIC_BACKEND_URL=" frontend/.env; then
        BACKEND_URL=$(grep "NEXT_PUBLIC_BACKEND_URL=" frontend/.env | cut -d '=' -f2 | tr -d '"' | tr -d "'")
        if [ -n "$BACKEND_URL" ] && [ "$BACKEND_URL" != "" ]; then
            echo -e "${GREEN}✓${NC} NEXT_PUBLIC_BACKEND_URL установлен: $BACKEND_URL"
        else
            echo -e "${RED}✗${NC} NEXT_PUBLIC_BACKEND_URL пустой!"
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo -e "${RED}✗${NC} NEXT_PUBLIC_BACKEND_URL не найден в frontend/.env"
        ERRORS=$((ERRORS + 1))
    fi

    # Проверка NEXT_PUBLIC_SUPABASE_URL
    if grep -q "NEXT_PUBLIC_SUPABASE_URL=" frontend/.env; then
        SUPABASE_URL=$(grep "NEXT_PUBLIC_SUPABASE_URL=" frontend/.env | cut -d '=' -f2 | tr -d '"' | tr -d "'")
        if [ -n "$SUPABASE_URL" ] && [ "$SUPABASE_URL" != "" ] && [ "$SUPABASE_URL" != "https://your-project-id.supabase.co" ]; then
            echo -e "${GREEN}✓${NC} NEXT_PUBLIC_SUPABASE_URL установлен"
        else
            echo -e "${YELLOW}⚠${NC} NEXT_PUBLIC_SUPABASE_URL не настроен"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi

    # Проверка NEXT_PUBLIC_SUPABASE_ANON_KEY
    if grep -q "NEXT_PUBLIC_SUPABASE_ANON_KEY=" frontend/.env; then
        SUPABASE_KEY=$(grep "NEXT_PUBLIC_SUPABASE_ANON_KEY=" frontend/.env | cut -d '=' -f2 | tr -d '"' | tr -d "'")
        if [ -n "$SUPABASE_KEY" ] && [ "$SUPABASE_KEY" != "" ] && [ "$SUPABASE_KEY" != "your-anon-key" ]; then
            echo -e "${GREEN}✓${NC} NEXT_PUBLIC_SUPABASE_ANON_KEY установлен"
        else
            echo -e "${YELLOW}⚠${NC} NEXT_PUBLIC_SUPABASE_ANON_KEY не настроен"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
fi

echo ""

# ========================================
# 3. Проверка доступности бэкенда
# ========================================
echo "🌐 Проверка доступности бэкенда..."

if [ -n "$BACKEND_URL" ]; then
    # Удаляем /api если есть для проверки базового URL
    BASE_URL=$(echo $BACKEND_URL | sed 's/\/api$//')
    
    # Проверяем доступность
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$BASE_URL" > /dev/null 2>&1; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$BASE_URL")
        if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 404 ] || [ "$HTTP_CODE" -eq 307 ]; then
            echo -e "${GREEN}✓${NC} Бэкенд доступен на $BASE_URL (HTTP $HTTP_CODE)"
        else
            echo -e "${YELLOW}⚠${NC} Бэкенд отвечает с кодом $HTTP_CODE"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        echo -e "${RED}✗${NC} Бэкенд НЕ ДОСТУПЕН на $BASE_URL"
        echo "  Убедитесь, что бэкенд запущен: cd backend && python api.py"
        ERRORS=$((ERRORS + 1))
    fi
    
    # Проверяем /docs endpoint
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$BASE_URL/docs" > /dev/null 2>&1; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$BASE_URL/docs")
        if [ "$HTTP_CODE" -eq 200 ]; then
            echo -e "${GREEN}✓${NC} FastAPI Swagger UI доступен: $BASE_URL/docs"
        fi
    fi
fi

echo ""

# ========================================
# 4. Проверка портов
# ========================================
echo "🔌 Проверка портов..."

# Проверка порта 8000 (бэкенд)
if lsof -Pi :8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Порт 8000 (бэкенд) занят - сервис запущен"
else
    echo -e "${YELLOW}⚠${NC} Порт 8000 (бэкенд) свободен - сервис НЕ запущен"
    WARNINGS=$((WARNINGS + 1))
fi

# Проверка порта 3000 (фронтенд)
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Порт 3000 (фронтенд) занят - сервис запущен"
else
    echo -e "${YELLOW}⚠${NC} Порт 3000 (фронтенд) свободен - сервис НЕ запущен"
    WARNINGS=$((WARNINGS + 1))
fi

# Проверка порта 6379 (Redis)
if lsof -Pi :6379 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Порт 6379 (Redis) занят - сервис запущен"
else
    echo -e "${YELLOW}⚠${NC} Порт 6379 (Redis) свободен - сервис НЕ запущен"
    echo "  Redis опционален, но рекомендуется для production"
fi

echo ""

# ========================================
# 5. Проверка зависимостей
# ========================================
echo "📦 Проверка зависимостей..."

# Проверка Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓${NC} Node.js установлен: $NODE_VERSION"
else
    echo -e "${RED}✗${NC} Node.js НЕ установлен!"
    ERRORS=$((ERRORS + 1))
fi

# Проверка npm/pnpm
if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm --version)
    echo -e "${GREEN}✓${NC} pnpm установлен: $PNPM_VERSION (рекомендуется)"
elif command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓${NC} npm установлен: $NPM_VERSION"
    echo -e "${YELLOW}💡${NC} Рекомендуется использовать pnpm для ускорения сборки"
else
    echo -e "${RED}✗${NC} npm/pnpm НЕ установлены!"
    ERRORS=$((ERRORS + 1))
fi

# Проверка Python
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    echo -e "${GREEN}✓${NC} Python установлен: $PYTHON_VERSION"
else
    echo -e "${RED}✗${NC} Python НЕ установлен!"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# ========================================
# 6. Итоговый отчет
# ========================================
echo "========================================="
echo "📊 ИТОГОВЫЙ ОТЧЕТ"
echo "========================================="

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✓ Все проверки пройдены успешно!${NC}"
    echo ""
    echo "Вы можете запустить приложение:"
    echo "  1. Бэкенд:  cd backend && python api.py"
    echo "  2. Фронтенд: cd frontend && npm run dev"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠ Найдено предупреждений: $WARNINGS${NC}"
    echo "Приложение может работать, но рекомендуется исправить предупреждения"
    exit 0
else
    echo -e "${RED}✗ Найдено критических ошибок: $ERRORS${NC}"
    echo -e "${YELLOW}⚠ Найдено предупреждений: $WARNINGS${NC}"
    echo ""
    echo "Пожалуйста, исправьте ошибки перед запуском приложения"
    echo "Подробная инструкция: см. suna_fix_report.md"
    exit 1
fi
