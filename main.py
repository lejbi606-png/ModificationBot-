import asyncio
import os
import asyncpg
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.types import Message, MessageReactionUpdated

BOT_TOKEN = os.environ.get("BOT_TOKEN")
DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

db_pool = None
bot = None
dp = Dispatcher()

async def init_db():
    global db_pool
    print("⏳ Подключаемся к базе данных...")
    retries = 5
    while retries > 0:
        try:
            db_pool = await asyncpg.create_pool(DATABASE_URL, timeout=10)
            async with db_pool.acquire() as connection:
                # Юзеры (баланс)
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS users (
                        user_id BIGINT PRIMARY KEY,
                        balance INTEGER DEFAULT 0,
                        is_premium BOOLEAN DEFAULT FALSE
                    );
                ''')
                # Сообщения (кто автор)
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS messages (
                        message_id BIGINT PRIMARY KEY,
                        author_id BIGINT
                    );
                ''')
                # История реакций (для античита)
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

# ================== ЛОГИКА РЕАКЦИЙ ==================
@dp.message(F.chat.type.in_({"group", "supergroup"}))
async def save_msg(message: Message):
    if not message.from_user: return
    # Сохраняем ID сообщения и кто его написал
    async with db_pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO messages (message_id, author_id) VALUES ($1, $2)
            ON CONFLICT (message_id) DO NOTHING;
        ''', message.message_id, message.from_user.id)

@dp.message_reaction()
async def handle_reaction(reaction: MessageReactionUpdated):
    user = reaction.user
    if not user:
        return # Если реакция анонимная, скипаем
        
    # Сравниваем, что добавилось, а что убрали
    old = set(r.emoji for r in reaction.old_reaction if r.type == 'emoji')
    new = set(r.emoji for r in reaction.new_reaction if r.type == 'emoji')
    
    added = new - old
    
    if not added:
        return # Если просто убрали реакцию, мы ничего не делаем (не отнимаем баллы)

    author_id = None
    async with db_pool.acquire() as conn:
        # Ищем автора сообщения, на которое поставили реакцию
        msg = await conn.fetchrow('SELECT author_id FROM messages WHERE message_id = $1', reaction.message_id)
        if msg:
            author_id = msg['author_id']
            
    if not author_id or author_id == user.id:
        return # Если автор не найден или человек лайкнул сам себя - ничего не даем

    for emoji in added:
        async with db_pool.acquire() as conn:
            # Проверяем историю этого юзера по этому сообщению
            row = await conn.fetchrow('''
                SELECT id, toggles FROM reactions 
                WHERE user_id = $1 AND message_id = $2 AND emoji = $3
            ''', user.id, reaction.message_id, emoji)
            
            # Убедимся, что автор сообщения есть в таблице users
            await conn.execute('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', author_id)

            if not row:
                # Первый раз ставит
                await conn.execute('''
                    INSERT INTO reactions (user_id, message_id, emoji, toggles) 
                    VALUES ($1, $2, $3, 0)
                ''', user.id, reaction.message_id, emoji)
                
                # Начисляем баллы (если премиум - х3)
                reward = 3 if user.is_premium else 1
                await conn.execute('UPDATE users SET balance = balance + $1 WHERE user_id = $2', reward, author_id)
                print(f"✅ {user.first_name} поставил {emoji}. Автору {author_id} начислено {reward} баллов.")
                
            else:
                toggles = row['toggles']
                if toggles == 0:
                    # Первая махинация (убрал и поставил)
                    await conn.execute('UPDATE reactions SET toggles = 1 WHERE id = $1', row['id'])
                    print(f"⚠️ {user.first_name} переставил {emoji}. Баллы не начислены.")
                else:
                    # Вторая махинация и далее (ШТРАФ)
                    await conn.execute('UPDATE reactions SET toggles = toggles + 1 WHERE id = $1', row['id'])
                    await conn.execute('UPDATE users SET balance = balance - 5 WHERE user_id = $1', author_id)
                    print(f"❌ {user.first_name} накручивает {emoji}. Автору {author_id} штраф -5 баллов.")


# ================== ВЕБ-СЕРВЕР ==================
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
    await start_web_server()
    await init_db()
    
    bot = Bot(token=BOT_TOKEN)
    
    # ВАЖНО: Включаем получение событий реакций в Telegram
    await bot.delete_webhook(drop_pending_updates=True)
    
    print("✅ Бот готов к работе и слушает реакции!")
    
    # Запускаем постоянный опрос Телеграма
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())

if __name__ == "__main__":
    asyncio.run(main())
