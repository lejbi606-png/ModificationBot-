import asyncio
import os
import asyncpg
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import Message, MessageReactionUpdated, ReplyKeyboardMarkup, KeyboardButton

BOT_TOKEN = os.environ.get("BOT_TOKEN")
DATABASE_URL = os.environ.get("DATABASE_URL")
ADMIN_IDS = {int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x.strip().isdigit()}

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

db_pool = None
bot = None
dp = Dispatcher()

main_kb = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="💰 Баланс"), KeyboardButton(text="🗑 Сбросить прогресс")]
    ],
    resize_keyboard=True
)


async def init_db():
    global db_pool
    print("⏳ Подключаемся к базе данных...")
    for attempt in range(1, 6):
        try:
            db_pool = await asyncpg.create_pool(DATABASE_URL, timeout=20, min_size=1, max_size=10)
            async with db_pool.acquire() as conn:
                # ---- Миграция старой схемы (сносим кривые таблицы) ----
                has_old_emoji = await conn.fetchval('''
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'reactions' AND column_name = 'emoji'
                    )
                ''')
                if has_old_emoji:
                    print("🔄 Миграция: пересоздаю reactions под новую схему античита...")
                    await conn.execute('DROP TABLE reactions')

                has_premium_col = await conn.fetchval('''
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'is_premium'
                    )
                ''')
                if has_premium_col:
                    await conn.execute('ALTER TABLE users DROP COLUMN is_premium')

                # ---- Создание таблиц ----
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS users (
                        user_id BIGINT PRIMARY KEY,
                        balance INTEGER DEFAULT 0
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS messages (
                        chat_id BIGINT,
                        message_id BIGINT,
                        author_id BIGINT,
                        PRIMARY KEY (chat_id, message_id)
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS reactions (
                        id SERIAL PRIMARY KEY,
                        chat_id BIGINT NOT NULL,
                        user_id BIGINT NOT NULL,
                        message_id BIGINT NOT NULL,
                        max_rewarded INTEGER DEFAULT 0,
                        rewarded_emojis TEXT[] DEFAULT '{}',
                        toggles INTEGER DEFAULT 0,
                        UNIQUE (chat_id, user_id, message_id)
                    );
                ''')
            print("✅ База данных готова.")
            return
        except Exception as e:
            print(f"❌ Ошибка БД (попытка {attempt}/5): {e}")
            if attempt == 5:
                raise
            await asyncio.sleep(5)


# ================== /start ==================
@dp.message(CommandStart())
async def cmd_start(message: Message):
    if message.chat.type != "private":
        return
    text = (
        "👋 Привет! Я бот для начисления баллов в чате.\n\n"
        "<b>Как это работает:</b>\n"
        "1. Ты пишешь сообщение в наш чат.\n"
        "2. Другие участники ставят на него реакции.\n"
        "3. За каждую новую реакцию ты получаешь 1 балл.\n\n"
        "<b>Правила и штрафы:</b>\n"
        "Запрещено накручивать баллы (ставить, убирать и снова ставить реакцию).\n"
        "Если бот заметит это:\n"
        "• 1-й раз: баллы не начислятся.\n"
        "• 2-й раз: штраф -5 баллов.\n\n"
        "👇 Используй кнопки ниже."
    )
    await message.answer(text, reply_markup=main_kb, parse_mode="HTML")


# ================== Баланс ==================
@dp.message(F.text.in_({"/balance", "/баллы", "💰 Баланс"}), F.chat.type == "private")
async def cmd_balance(message: Message):
    user_id = message.from_user.id
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow('SELECT balance FROM users WHERE user_id = $1', user_id)

    if row:
        await message.answer(f"💰 Твой баланс: {row['balance']} баллов.")
    else:
        await message.answer("💰 У тебя пока 0 баллов. Пиши в чат и собирай реакции!")


# ================== Сброс ==================
@dp.message(F.text == "🗑 Сбросить прогресс", F.chat.type == "private")
async def cmd_reset(message: Message):
    if ADMIN_IDS and message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Нет доступа.")
        return
    async with db_pool.acquire() as conn:
        await conn.execute('TRUNCATE TABLE users, messages, reactions RESTART IDENTITY CASCADE;')
    await message.answer("🗑 <b>Весь прогресс удалён.</b>", parse_mode="HTML")


# ================== Сохранение сообщений ==================
@dp.message(F.chat.type.in_({"group", "supergroup"}))
async def save_msg(message: Message):
    if not message.from_user or message.from_user.is_bot:
        return
    async with db_pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO messages (chat_id, message_id, author_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (chat_id, message_id) DO NOTHING;
        ''', message.chat.id, message.message_id, message.from_user.id)


# ================== Реакции ==================
@dp.message_reaction()
async def handle_reaction(reaction: MessageReactionUpdated):
    user = reaction.user
    if not user:
        return

    old = {r.emoji for r in reaction.old_reaction if r.type == 'emoji'}
    new = {r.emoji for r in reaction.new_reaction if r.type == 'emoji'}
    added = new - old
    if not added:
        return

    chat_id = reaction.chat.id
    msg_id = reaction.message_id

    try:
        if reaction.chat.type == "channel":
            target_user_id = user.id
        else:
            async with db_pool.acquire() as conn:
                msg = await conn.fetchrow(
                    'SELECT author_id FROM messages WHERE chat_id = $1 AND message_id = $2',
                    chat_id, msg_id
                )
            if not msg:
                return
            target_user_id = msg['author_id']

        if target_user_id == user.id:
            return

        async with db_pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
                    target_user_id
                )

                row = await conn.fetchrow('''
                    SELECT id, max_rewarded, rewarded_emojis, toggles
                    FROM reactions
                    WHERE chat_id = $1 AND user_id = $2 AND message_id = $3
                ''', chat_id, user.id, msg_id)

                current_unique = len(new)

                if row is None:
                    reward = current_unique
                    await conn.execute('''
                        INSERT INTO reactions
                            (chat_id, user_id, message_id, max_rewarded, rewarded_emojis, toggles)
                        VALUES ($1, $2, $3, $4, $5, 0)
                    ''', chat_id, user.id, msg_id, reward, list(new))
                    await conn.execute(
                        'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
                        reward, target_user_id
                    )
                    print(f"✅ {user.first_name} поставил {sorted(new)}. Юзеру {target_user_id} +{reward} балл(ов).")
                    return

                max_rewarded = row['max_rewarded'] or 0
                rewarded_emojis = set(row['rewarded_emojis'] or [])
                toggles = row['toggles'] or 0

                total_reward = 0
                new_manipulations = 0

                for emoji in added:
                    if emoji in rewarded_emojis:
                        new_manipulations += 1
                    elif current_unique > max_rewarded:
                        rewarded_emojis.add(emoji)
                        max_rewarded += 1
                        total_reward += 1

                new_toggles = toggles + new_manipulations

                await conn.execute('''
                    UPDATE reactions
                    SET max_rewarded = $1, rewarded_emojis = $2, toggles = $3
                    WHERE id = $4
                ''', max_rewarded, list(rewarded_emojis), new_toggles, row['id'])

                if total_reward > 0:
                    await conn.execute(
                        'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
                        total_reward, target_user_id
                    )
                    print(f"✅ {user.first_name} добавил {sorted(added)}. Юзеру {target_user_id} +{total_reward} балл(ов).")

                if new_manipulations > 0:
                    if new_toggles == 1:
                        print(f"⚠️ {user.first_name} переставил реакцию на сообщении {msg_id}. Баллы не начислены.")
                    else:
                        fine = 5
                        await conn.execute(
                            'UPDATE users SET balance = balance - $1 WHERE user_id = $2',
                            fine, target_user_id
                        )
                        print(f"❌ {user.first_name} нарушает правила (повторное переставление). Штраф -{fine} баллов юзеру {target_user_id}.")

    except Exception as e:
        print(f"❌ Ошибка обработки реакции: {e}")


# ================== Веб-сервер ==================
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
    
    if not BOT_TOKEN:
        raise RuntimeError("❌ BOT_TOKEN не задан!")
    if not DATABASE_URL:
        raise RuntimeError("❌ DATABASE_URL не задан!")

    await init_db()
    await start_web_server()

    bot = Bot(token=BOT_TOKEN)
    await bot.delete_webhook(drop_pending_updates=True)
    print("✅ Бот запущен.")
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    asyncio.run(main())
