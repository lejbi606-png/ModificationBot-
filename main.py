import asyncio
import os
import asyncpg
from aiohttp import web
from aiogram import Bot, Dispatcher

# Берем токены из настроек сервера (Render)
BOT_TOKEN = os.environ.get("BOT_TOKEN")
DATABASE_URL = os.environ.get("DATABASE_URL")

# Защита от ошибки с форматом ссылки Aiven
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Глобальные переменные
db_pool = None
bot = None
dp = Dispatcher() # Выносим сюда, чтобы добавлять логику дальше

async def init_db():
    global db_pool
    print("⏳ Подключаемся к базе данных...")
    retries = 5
    while retries > 0:
        try:
            # Пытаемся подключиться с таймаутом
            db_pool = await asyncpg.create_pool(DATABASE_URL, timeout=10)
            
            async with db_pool.acquire() as connection:
                # Создаем таблицу юзеров
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS users (
                        user_id BIGINT PRIMARY KEY,
                        balance INTEGER DEFAULT 0,
                        is_premium BOOLEAN DEFAULT FALSE
                    );
                ''')
                # Создаем таблицу истории реакций (для античита)
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS reactions (
                        id SERIAL PRIMARY KEY,
                        user_id BIGINT,
                        message_id BIGINT,
                        emoji TEXT,
                        toggles INTEGER DEFAULT 0
                    );
                ''')
            print("✅ База данных успешно инициализирована.")
            return
        except Exception as e:
            print(f"❌ Ошибка подключения к БД: {e}. Осталось попыток: {retries-1}")
            retries -= 1
            await asyncio.sleep(5)
            
    print("‼️ Не удалось подключиться к базе. Проверь DATABASE_URL на Render.")

# Мини-сервер для Render (отвечает на пинги UptimeRobot)
async def handle_ping(request):
    return web.Response(text="Bot is alive")

async def start_web_server():
    app = web.Application()
    app.router.add_get('/', handle_ping)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 10000))
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    print(f"✅ Веб-сервер запущен на порту {port}")

async def main():
    global bot
    # 1. Сначала поднимаем веб-сервер (чтобы Render сразу видел порт)
    await start_web_server()
    
    # 2. Подключаемся к базе
    await init_db()
    
    # 3. Инициализируем бота
    bot = Bot(token=BOT_TOKEN)
    print("✅ Бот готов к работе!")
    
    # Пока просто держим процесс живым (логику реакций добавим в следующем шаге)
    while True:
        await asyncio.sleep(3600)

if __name__ == "__main__":
    asyncio.run(main())
