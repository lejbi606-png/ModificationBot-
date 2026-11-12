import asyncio
import os
import asyncpg
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import Message, MessageReactionUpdated, ReplyKeyboardMarkup, KeyboardButton

BOT_TOKEN = os.environ.get("BOT_TOKEN")
DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

db_pool = None
bot = None
dp = Dispatcher()

# Клавиатура с кнопками
main_kb = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="💰 Баланс"), KeyboardButton(text="🗑 Сбросить прогресс")]
    ],
    resize_keyboard=True
)

async def init_db():
    global db_pool
    print("⏳ Подключаемся к базе данных...")
    retries = 5
    while retries > 0:
        try:
            db_pool = await asyncpg.create_pool(DATABASE_URL, timeout=10)
            async with db_pool.acquire() as connection:
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS users (
                        user_id BIGINT PRIMARY KEY,
                        balance INTEGER DEFAULT 0,
                        is_premium BOOLEAN DEFAULT FALSE
                    );
                ''')
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS messages (
                        chat_id BIGINT,
                        message_id BIGINT,
                        author_id BIGINT,
                        PRIMARY KEY (chat_id, message_id)
                    );
                ''')
                await connection.execute('''
                    CREATE TABLE IF NOT EXISTS reactions (
                        id SERIAL PRIMARY KEY,
                        chat_id BIGINT,
                        user_id BIGINT,
                        message_id BIGINT,
                        emoji TEXT,
                        toggles INTEGER DEFAULT 0
                    );
                ''')
            print("✅ База данных обновлена.")
            return
        except Exception as e:
            print(f"❌ Ошибка БД: {e}. Осталось попыток: {retries-1}")
            retries -= 1
            await asyncio.sleep(5)

# ================== КОМАНДА СТАРТ ==================
@dp.message(CommandStart())
async def cmd_start(message: Message):
    if message.chat.type == "private":
        text = (
            "👋 Привет! Я бот для начисления баллов в чате.\n\n"
            "📜 **Как это работает:**\n"
            "1. Ты пишешь сообщение в наш чат.\n"
            "2. Другие участники ставят на него реакции.\n"
            "3. За каждую новую реакцию ты получаешь баллы (1 балл, а если у тебя Telegram Premium — 3 балла).\n\n"
            "⚠️ **Правила и штрафы:**\n"
            "Запрещено накручивать баллы (ставить, убирать и снова ставить реакцию).\n"
            "Если бот заметит это:\n"
            "• 1-й раз: баллы не начислятся.\n"
            "• 2-й раз: штраф -5 баллов.\n\n"
            "👇 Используй кнопки ниже, чтобы проверить баланс или сбросить прогресс (для тестов)."
        )
    else:
        text = "👋 Привет! Я работаю в чате. Пиши сообщения и собирай реакции!"
        
    await message.answer(text, reply_markup=main_kb, parse_mode="Markdown")

# ================== КНОПКИ И БАЛАНС ==================
@dp.message(F.text.in_({"/balance", "/баллы", "💰 Баланс"}))
async def cmd_balance(message: Message):
    user_id = message.from_user.id
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow('SELECT balance FROM users WHERE user_id = $1', user_id)
        
    if row:
        await message.answer(f"💰 Твой баланс: {row['balance']} баллов.")
    else:
        await message.answer("💰 У тебя пока 0 баллов. Пиши в чат и собирай реакции!")

@dp.message(F.text == "🗑 Сбросить прогресс")
async def cmd_reset(message: Message):
    # Полная очистка таблиц (для тестов)
    async with db_pool.acquire() as conn:
        await conn.execute('TRUNCATE TABLE users, messages, reactions RESTART IDENTITY CASCADE;')
    await message.answer("🗑 **Весь прогресс удален!**\nВсе баллы и история реакций стерты. Можно тестировать заново.", parse_mode="Markdown")

# ================== СОХРАНЕНИЕ СООБЩЕНИЙ ==================
@dp.message(F.chat.type.in_({"group", "supergroup"}))
async def save_msg(message: Message):
    if not message.from_user: return
    # Игнорируем сообщения с кнопками, чтобы не засорять базу
    if message.text in {"💰 Баланс", "🗑 Сбросить прогресс"}: return
    
    async with db_pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO messages (chat_id, message_id, author_id) 
            VALUES ($1, $2, $3)
            ON CONFLICT (chat_id, message_id) DO NOTHING;
        ''', message.chat.id, message.message_id, message.from_user.id)

# ================== ЛОГИКА РЕАКЦИЙ ==================
@dp.message_reaction()
async def handle_reaction(reaction: MessageReactionUpdated):
    user = reaction.user
    if not user: return
        
    old = set(r.emoji for r in reaction.old_reaction if r.type == 'emoji')
    new = set(r.emoji for r in reaction.new_reaction if r.type == 'emoji')
    added = new - old
    
    if not added: return

    chat_id = reaction.chat.id
    msg_id = reaction.message_id

    if reaction.chat.type == "channel":
        target_user_id = user.id 
    else:
        async with db_pool.acquire() as conn:
            msg = await conn.fetchrow('SELECT author_id FROM messages WHERE chat_id = $1 AND message_id = $2', chat_id, msg_id)
            if not msg: return
            target_user_id = msg['author_id']

    if target_user_id == user.id: return

    for emoji in added:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT id, toggles FROM reactions 
                WHERE chat_id = $1 AND user_id = $2 AND message_id = $3 AND emoji = $4
            ''', chat_id, user.id, msg_id, emoji)
            
            await conn.execute('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', target_user_id)

            if not row:
                await conn.execute('''
                    INSERT INTO reactions (chat_id, user_id, message_id, emoji, toggles) 
                    VALUES ($1, $2, $3, $4, 0)
                ''', chat_id, user.id, msg_id, emoji)
                
                reward = 3 if user.is_premium else 1
                await conn.execute('UPDATE users SET balance = balance + $1 WHERE user_id = $2', reward, target_user_id)
                print(f"✅ {user.first_name} поставил {emoji}. Юзеру {target_user_id} начислено {reward} баллов.")
                
            else:
                toggles = row['toggles']
                if toggles == 0:
                    await conn.execute('UPDATE reactions SET toggles = 1 WHERE id = $1', row['id'])
                    print(f"⚠️ {user.first_name} переставил {emoji}. Баллы не начислены.")
                else:
                    await conn.execute('UPDATE reactions SET toggles = toggles + 1 WHERE id = $1', row['id'])
                    await conn.execute('UPDATE users SET balance = balance - 5 WHERE user_id = $1', target_user_id)
                    print(f"❌ {user.first_name} нарушает правила (накрутка). Штраф -5 баллов юзеру {target_user_id}.")


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
    await bot.delete_webhook(drop_pending_updates=True)
    print("✅ Бот готов к работе (с кнопками и правилами)!")
    
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())

if __name__ == "__main__":
    asyncio.run(main())
