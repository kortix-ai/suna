#!/bin/bash

# ========================================
# Скрипт оптимизации сборки Suna AI Frontend
# ========================================

echo "🚀 Оптимизация сборки Suna AI Frontend..."
echo ""

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

cd frontend || exit 1

# ========================================
# 1. Проверка установки pnpm
# ========================================
echo -e "${BLUE}📦 Проверка менеджера пакетов...${NC}"

if command -v pnpm &> /dev/null; then
    echo -e "${GREEN}✓${NC} pnpm установлен"
    PACKAGE_MANAGER="pnpm"
else
    echo -e "${YELLOW}⚠${NC} pnpm не установлен, используется npm"
    echo -e "${YELLOW}💡${NC} Для ускорения установите pnpm: npm install -g pnpm"
    PACKAGE_MANAGER="npm"
fi

echo ""

# ========================================
# 2. Применение оптимизаций
# ========================================
echo -e "${BLUE}⚙️  Применение оптимизаций...${NC}"

# Резервная копия оригинального next.config.ts
if [ -f "next.config.ts" ] && [ ! -f "next.config.ts.backup" ]; then
    cp next.config.ts next.config.ts.backup
    echo -e "${GREEN}✓${NC} Создана резервная копия next.config.ts"
fi

# Применение оптимизированного конфига
if [ -f "next.config.optimized.ts" ]; then
    cp next.config.optimized.ts next.config.ts
    echo -e "${GREEN}✓${NC} Применен оптимизированный next.config.ts"
else
    echo -e "${YELLOW}⚠${NC} Файл next.config.optimized.ts не найден"
fi

# Применение .npmrc
if [ -f ".npmrc.optimized" ]; then
    if [ ! -f ".npmrc.backup" ] && [ -f ".npmrc" ]; then
        cp .npmrc .npmrc.backup
    fi
    cp .npmrc.optimized .npmrc
    echo -e "${GREEN}✓${NC} Применен оптимизированный .npmrc"
fi

echo ""

# ========================================
# 3. Настройка переменных окружения
# ========================================
echo -e "${BLUE}🔧 Настройка переменных окружения для сборки...${NC}"

# Увеличение памяти для Node.js
export NODE_OPTIONS="--max-old-space-size=4096"
echo -e "${GREEN}✓${NC} Увеличен лимит памяти Node.js до 4GB"

# Отключение телеметрии Next.js
export NEXT_TELEMETRY_DISABLED=1
echo -e "${GREEN}✓${NC} Отключена телеметрия Next.js"

# Standalone output для меньшего размера
export NEXT_OUTPUT="standalone"
echo -e "${GREEN}✓${NC} Включен standalone output"

echo ""

# ========================================
# 4. Очистка кэша
# ========================================
echo -e "${BLUE}🧹 Очистка старых файлов...${NC}"

# Очистка .next
if [ -d ".next" ]; then
    rm -rf .next
    echo -e "${GREEN}✓${NC} Очищена директория .next"
fi

# Очистка кэша Next.js
if [ -d ".next/cache" ]; then
    rm -rf .next/cache
    echo -e "${GREEN}✓${NC} Очищен кэш Next.js"
fi

echo ""

# ========================================
# 5. Установка зависимостей (опционально)
# ========================================
read -p "Переустановить зависимости? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}📦 Установка зависимостей...${NC}"
    
    if [ "$PACKAGE_MANAGER" = "pnpm" ]; then
        pnpm install --frozen-lockfile
    else
        npm ci
    fi
    
    echo -e "${GREEN}✓${NC} Зависимости установлены"
    echo ""
fi

# ========================================
# 6. Запуск сборки
# ========================================
echo -e "${BLUE}🔨 Запуск оптимизированной сборки...${NC}"
echo ""

# Засекаем время
START_TIME=$(date +%s)

# Запуск сборки
if [ "$PACKAGE_MANAGER" = "pnpm" ]; then
    pnpm build
else
    npm run build
fi

BUILD_EXIT_CODE=$?

# Вычисляем время сборки
END_TIME=$(date +%s)
BUILD_TIME=$((END_TIME - START_TIME))
BUILD_TIME_MIN=$((BUILD_TIME / 60))
BUILD_TIME_SEC=$((BUILD_TIME % 60))

echo ""
echo "========================================="

if [ $BUILD_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✓ Сборка завершена успешно!${NC}"
    echo -e "⏱️  Время сборки: ${BUILD_TIME_MIN}м ${BUILD_TIME_SEC}с"
    echo ""
    echo "Размер билда:"
    if [ -d ".next" ]; then
        du -sh .next
    fi
    echo ""
    echo "Для запуска в production режиме:"
    echo "  $PACKAGE_MANAGER start"
else
    echo -e "${RED}✗ Сборка завершилась с ошибкой${NC}"
    echo "Проверьте логи выше для деталей"
    exit 1
fi

echo "========================================="

# ========================================
# 7. Советы по дальнейшей оптимизации
# ========================================
echo ""
echo -e "${BLUE}💡 Советы по дальнейшей оптимизации:${NC}"
echo ""
echo "1. Используйте pnpm вместо npm (в 2-3 раза быстрее)"
echo "   npm install -g pnpm"
echo ""
echo "2. Для dev режима используйте Turbopack:"
echo "   $PACKAGE_MANAGER dev"
echo ""
echo "3. Включите кэширование в CI/CD:"
echo "   - Кэшируйте node_modules"
echo "   - Кэшируйте .next/cache"
echo ""
echo "4. Для Docker используйте multi-stage build"
echo "   См. frontend/Dockerfile"
echo ""
echo "5. Анализ bundle size:"
echo "   npm install -g @next/bundle-analyzer"
echo "   ANALYZE=true $PACKAGE_MANAGER build"
echo ""
