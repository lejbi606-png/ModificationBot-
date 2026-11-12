import asyncio
import os
import asyncpg
import hashlib
import hmac
import json
from urllib.parse import parse_qsl
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
                
                # ---- ЖЕСТКИЙ СБРОС (пока тестируем и меняем структуру) ----
                print("🔄 Сносим старые таблицы...")
                await conn.execute('DROP TABLE IF EXISTS reactions, messages, users CASCADE')
                # ----------------------------------------------------------

                # ---- Создание таблиц с новыми колонками ----
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS users (
                        user_id BIGINT PRIMARY KEY,
                        balance INTEGER DEFAULT 0,
                        first_name TEXT,
                        username TEXT
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
    if message.chat.type == "private":
        text = (
            "👋 Привет! Я бот для начисления баллов.\n\n"
            "<b>Как это работает:</b>\n"
            "1. В чате: другие ставят реакции на твое сообщение — баллы тебе.\n"
            "2. В канале: ты ставишь реакции на посты — баллы тебе.\n\n"
            "<b>Правила:</b>\n"
            "Запрещено накручивать баллы (ставить, убирать и снова ставить реакцию).\n"
            "Штраф за махинации: -5 баллов нарушителю.\n\n"
            "👇 Используй кнопки ниже."
        )
        await message.answer(text, reply_markup=main_kb, parse_mode="HTML")
    else:
        text = "👋 Привет! Я работаю в чате. Пиши сообщения и собирай реакции!"
        await message.answer(text)


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
        # Сохраняем сообщение
        await conn.execute('''
            INSERT INTO messages (chat_id, message_id, author_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (chat_id, message_id) DO NOTHING;
        ''', message.chat.id, message.message_id, message.from_user.id)
        
        # Создаем/обновляем юзера
        await conn.execute('''
            INSERT INTO users (user_id, first_name, username) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE 
            SET first_name = EXCLUDED.first_name, username = EXCLUDED.username;
        ''', message.from_user.id, message.from_user.first_name, message.from_user.username)


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
                print(f"❌ [ЛОГ] Сообщение {msg_id} не найдено в базе.")
                return
            target_user_id = msg['author_id']
            
            # Проверка на свою реакцию (ТОЛЬКО для чатов)
            if target_user_id == user.id:
                return

        async with db_pool.acquire() as conn:
            async with conn.transaction():
                # Создаем/обновляем автора (или того, кому начисляем)
                await conn.execute('''
                    INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                    ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
                ''', target_user_id, user.first_name, user.username)
                
                # Создаем/обновляем нарушителя (чтобы было куда списывать штраф)
                await conn.execute('''
                    INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                    ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
                ''', user.id, user.first_name, user.username)

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
                    print(f"✅ [ЛОГ] {user.first_name} поставил {sorted(new)}. +{reward} балл(ов).")
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
                    print(f"✅ [ЛОГ] {user.first_name} добавил {sorted(added)}. +{total_reward} балл(ов).")

                if new_manipulations > 0:
                    if new_toggles == 1:
                        print(f"⚠️ [ЛОГ] {user.first_name} переставил. Баллы не начислены.")
                    else:
                        fine = 5
                        # Штраф летит самому нарушителю (user.id)
                        await conn.execute(
                            'UPDATE users SET balance = balance - $1 WHERE user_id = $2',
                            fine, user.id
                        )
                        print(f"❌ [ЛОГ] {user.first_name} нарушает правила. Штраф -{fine} баллов ему.")

    except Exception as e:
        print(f"❌ [ЛОГ] Ошибка обработки реакции: {e}")


# ================== ВАЛИДАЦИЯ TELEGRAM INIT DATA ==================
def validate_init_data(init_data: str) -> dict | None:
    """Проверяет подпись initData от Telegram Mini App и возвращает данные юзера."""
    try:
        parsed_data = dict(parse_qsl(init_data))
        if "hash" not in parsed_data:
            return None
        
        received_hash = parsed_data.pop("hash")
        
        # Сортируем и склеиваем данные
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed_data.items()))
        
        # Секретный ключ = HMAC_SHA256(BOT_TOKEN, "WebAppData")
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        
        # Безопасное сравнение (защита от timing-атак)
        if hmac.compare_digest(calculated_hash, received_hash):
            return json.loads(parsed_data.get("user", "{}"))
        return None
    except Exception as e:
        print(f"❌ Ошибка валидации initData: {e}")
        return None


# ================== API ЭНДПОИНТЫ ДЛЯ MINI APP ==================
async def api_balance(request):
    init_data = request.query.get("initData")
    if not init_data:
        return web.json_response({"error": "No initData"}, status=401)
    
    user_data = validate_init_data(init_data)
    if not user_data:
        return web.json_response({"error": "Invalid initData"}, status=403)
    
    user_id = user_data.get("id")
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow('SELECT balance FROM users WHERE user_id = $1', user_id)
    
    balance = row['balance'] if row else 0
    return web.json_response({"balance": balance, "user_id": user_id})


async def api_top(request):
    init_data = request.query.get("initData")
    if not init_data:
        return web.json_response({"error": "No initData"}, status=401)
    
    if not validate_init_data(init_data):
        return web.json_response({"error": "Invalid initData"}, status=403)
    
    async with db_pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT user_id, balance, first_name, username 
            FROM users 
            ORDER BY balance DESC 
            LIMIT 5
        ''')
    
    top_list = [
        {
            "user_id": r["user_id"],
            "balance": r["balance"],
            "first_name": r["first_name"] or "Аноним",
            "username": r["username"]
        } for r in rows
    ]
    return web.json_response({"top": top_list})


# ================== ВЕБ-СЕРВЕР ==================
async def handle_ping(request):
    return web.Response(text="Bot is alive")


async def start_web_server():
    app = web.Application()
    app.router.add_get('/', handle_ping)
    # API ручки
    app.router.add_get('/api/balance', api_balance)
    app.router.add_get('/api/top', api_top)
    
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
