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
from aiogram.types import (
    Message, MessageReactionUpdated, ReplyKeyboardMarkup, KeyboardButton,
    InlineKeyboardMarkup, InlineKeyboardButton, CallbackQuery, ChatMemberUpdated
)

BOT_TOKEN = os.environ.get("BOT_TOKEN")
DATABASE_URL = os.environ.get("DATABASE_URL")
ADMIN_IDS = {int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x.strip().isdigit()}

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

db_pool = None
bot = None
dp = Dispatcher()

# Кэш владельцев (глобальные админы из ENV + авто-владельцы)
OWNERS = set()

def get_main_kb(user_id: int) -> ReplyKeyboardMarkup:
    is_admin = (user_id in ADMIN_IDS) or (user_id in OWNERS)
    buttons = [[KeyboardButton(text="💰 Баланс")]]
    if is_admin:
        buttons[0].append(KeyboardButton(text="🗑 Сбросить прогресс"))
    return ReplyKeyboardMarkup(keyboard=buttons, resize_keyboard=True)


async def init_db():
    global db_pool
    print("⏳ Подключаемся к базе данных...")
    for attempt in range(1, 6):
        try:
            db_pool = await asyncpg.create_pool(DATABASE_URL, timeout=20, min_size=1, max_size=10)
            async with db_pool.acquire() as conn:
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
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS channel_rewards (
                        chat_id BIGINT,
                        message_id BIGINT,
                        user_id BIGINT,
                        click_count INTEGER DEFAULT 0,
                        max_rewarded INTEGER DEFAULT 0,
                        PRIMARY KEY (chat_id, message_id, user_id)
                    );
                ''')
                # Таблица для авто-админов
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS bot_admins (
                        user_id BIGINT PRIMARY KEY
                    );
                ''')
                # Новая таблица для управления чатами
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS managed_chats (
                        chat_id BIGINT PRIMARY KEY,
                        owner_id BIGINT NOT NULL,
                        title TEXT,
                        chat_type TEXT,
                        linked_chat_id BIGINT
                    );
                ''')
                
                await conn.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;')
                await conn.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;')
                
                rows = await conn.fetch('SELECT user_id FROM bot_admins')
                for r in rows:
                    OWNERS.add(r['user_id'])
                
            print(f"✅ База данных готова. Авто-админов: {len(OWNERS)}")
            return
        except Exception as e:
            print(f"❌ Ошибка БД (попытка {attempt}/5): {e}")
            if attempt == 5:
                raise
            await asyncio.sleep(5)


# ================== ОТСЛЕЖИВАНИЕ ЧАТОВ ==================
@dp.my_chat_member()
async def track_chat_owner(update: ChatMemberUpdated):
    if update.new_chat_member.status in ("administrator", "member"):
        chat = update.chat
        try:
            admins = await bot.get_chat_administrators(chat.id)
            owner_id = None
            for admin in admins:
                if admin.status == "creator":
                    owner_id = admin.user.id
                    break
            
            if not owner_id:
                return

            OWNERS.add(owner_id)
            
            # linked_chat_id может быть None, если чат не связан
            linked_id = getattr(chat, 'linked_chat_id', None)

            async with db_pool.acquire() as conn:
                await conn.execute('''
                    INSERT INTO bot_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING
                ''', owner_id)
                
                await conn.execute('''
                    INSERT INTO managed_chats (chat_id, owner_id, title, chat_type, linked_chat_id)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (chat_id) DO UPDATE SET 
                        owner_id = EXCLUDED.owner_id, 
                        title = EXCLUDED.title,
                        chat_type = EXCLUDED.chat_type,
                        linked_chat_id = EXCLUDED.linked_chat_id
                ''', chat.id, owner_id, chat.title, chat.type, linked_id)
            
            print(f"👑 [ВЛАДЕЛЕЦ] Чат {chat.id} ({chat.title}). Владелец {owner_id}. Linked: {linked_id}")
        except Exception as e:
            print(f"❌ Не удалось получить владельца чата {chat.id}: {e}")


# ================== /start ==================
@dp.message(CommandStart())
async def cmd_start(message: Message):
    if message.chat.type == "private":
        text = (
            "👋 Привет! Я бот для начисления баллов в чате и на канале.\n\n"
            "<b>💬 Как заработать баллы в ЧАТЕ:</b>\n"
            "1. Ты пишешь сообщение в наш чат.\n"
            "2. Другие участники ставят на него реакции.\n"
            "3. За каждую новую реакцию автор сообщения получает 1 балл.\n"
            "💎 <b>Premium:</b> может поставить до 3 разных реакций на одно сообщение (автор получит 3 балла).\n\n"
            "<b>📢 Как заработать баллы в КАНАЛЕ:</b>\n"
            "1. Под каждым постом есть кнопка «🔥 Заработать балл».\n"
            "2. Жмешь на неё и получаешь балл себе на баланс.\n"
            "💎 <b>Premium:</b> может нажать кнопку 3 раза и получить 3 балла с одного поста.\n\n"
            "<b>⚠️ ПРАВИЛА И ШТРАФЫ (Античит):</b>\n"
            "Накручивать баллы запрещено. Бот строго следит за этим.\n\n"
            "<b>Пример для обычного юзера:</b>\n"
            "• <b>1-е действие:</b> +1 балл.\n"
            "• <b>2-е действие:</b> Предупреждение, баллы НЕ начисляются.\n"
            "• <b>3-е действие:</b> Штраф -5 баллов.\n\n"
            "<b>Пример для Premium (лимит 3 действия):</b>\n"
            "• 1, 2, 3-е действия: +1 балл за каждое.\n"
            "• <b>4-е действие:</b> Предупреждение.\n"
            "• <b>5-е действие:</b> Штраф -5 баллов.\n\n"
            "👇 Свой баланс можно проверить в личке по кнопке ниже, либо командой /balance в чате."
        )
        await message.answer(text, reply_markup=get_main_kb(message.from_user.id), parse_mode="HTML")
    else:
        await message.answer("👋 Привет! Я работаю в чате. Пиши сообщения и собирай реакции!")


# ================== Баланс ==================
@dp.message(F.text.in_({"/balance", "/баллы", "💰 Баланс"}), F.chat.type != "channel")
async def cmd_balance(message: Message):
    if not message.from_user:
        return
    user_id = message.from_user.id
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow('SELECT balance FROM users WHERE user_id = $1', user_id)
    if row:
        await message.answer(f"💰 {message.from_user.first_name}, твой баланс: {row['balance']} баллов.")
    else:
        await message.answer("💰 У тебя пока 0 баллов. Пиши в чат и собирай реакции!")


# ================== Сброс (МЕНЮ) ==================
@dp.message(F.text == "🗑 Сбросить прогресс", F.chat.type == "private")
async def cmd_reset_menu(message: Message):
    if (message.from_user.id not in ADMIN_IDS) and (message.from_user.id not in OWNERS):
        await message.answer("⛔ Нет доступа.")
        return

    user_id = message.from_user.id
    async with db_pool.acquire() as conn:
        # Для админов из ENV показываем все чаты, для остальных - только их
        if user_id in ADMIN_IDS:
            rows = await conn.fetch('SELECT chat_id, title, chat_type, linked_chat_id FROM managed_chats')
        else:
            rows = await conn.fetch('SELECT chat_id, title, chat_type, linked_chat_id FROM managed_chats WHERE owner_id = $1', user_id)

    if not rows:
        await message.answer("У тебя пока нет привязанных чатов или каналов.")
        return

    # Группируем связанные чаты (чтобы не дублировать кнопки)
    shown = set()
    buttons = []
    
    for r in rows:
        chat_id = r['chat_id']
        linked_id = r['linked_chat_id']
        
        # Если этот чат уже показан как связанный с другим, пропускаем
        if chat_id in shown:
            continue
        
        title = r['title'] or str(chat_id)
        chat_type = "Канал" if r['chat_type'] == "channel" else "Чат"
        
        # Формируем callback_data. Если есть linked_id, сбрасываем оба.
        # В callback_data передаем основной chat_id и linked_id (если есть)
        callback_data = f"resetchat_{chat_id}_{linked_id if linked_id else 0}"
        
        buttons.append([InlineKeyboardButton(
            text=f"🗑 {chat_type}: {title}",
            callback_data=callback_data
        )])
        
        shown.add(chat_id)
        if linked_id:
            shown.add(linked_id)

    kb = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer("Выбери чат или канал, данные которого нужно сбросить:", reply_markup=kb)


# ================== ОБРАБОТКА СБРОСА КОНКРЕТНОГО ЧАТА ==================
@dp.callback_query(F.data.startswith("resetchat_"))
async def handle_reset_chat(callback: CallbackQuery):
    try:
        parts = callback.data.split("_")
        chat_id = int(parts[1])
        linked_id = int(parts[2]) if parts[2] != "0" else None
    except (ValueError, IndexError):
        await callback.answer("Ошибка данных", show_alert=True)
        return

    # Проверка прав (чтобы нельзя было сбросить чужой чат)
    async with db_pool.acquire() as conn:
        owner_row = await conn.fetchrow('SELECT owner_id FROM managed_chats WHERE chat_id = $1', chat_id)
        if not owner_row:
            await callback.answer("Чат не найден", show_alert=True)
            return
        
        if callback.from_user.id not in ADMIN_IDS and owner_row['owner_id'] != callback.from_user.id:
            await callback.answer("⛔ У тебя нет прав на сброс этого чата.", show_alert=True)
            return

        # Сбрасываем данные для основного чата
        await conn.execute('DELETE FROM messages WHERE chat_id = $1', chat_id)
        await conn.execute('DELETE FROM reactions WHERE chat_id = $1', chat_id)
        await conn.execute('DELETE FROM channel_rewards WHERE chat_id = $1', chat_id)
        
        # Если есть связанный чат - чистим и его
        if linked_id:
            await conn.execute('DELETE FROM messages WHERE chat_id = $1', linked_id)
            await conn.execute('DELETE FROM reactions WHERE chat_id = $1', linked_id)
            await conn.execute('DELETE FROM channel_rewards WHERE chat_id = $1', linked_id)

    chat_name = owner_row['owner_id'] # fallback
    await callback.answer("✅ Данные успешно сброшены!", show_alert=True)
    await callback.message.edit_text(f"🗑 Данные для чата {chat_id} (и связанного {linked_id if linked_id else 'нет'}) удалены.")


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
        
        await conn.execute('''
            INSERT INTO users (user_id, first_name, username) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE 
            SET first_name = EXCLUDED.first_name, username = EXCLUDED.username;
        ''', message.from_user.id, message.from_user.first_name, message.from_user.username)


# ================== НОВЫЙ ПОСТ В КАНАЛЕ ==================
@dp.channel_post()
async def handle_channel_post(message: Message):
    if message.chat.type != "channel":
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🔥 Заработать балл", callback_data=f"earn_{message.message_id}")]
    ])
    try:
        await message.edit_reply_markup(reply_markup=kb)
        print(f"✅ [КАНАЛ] Добавлена кнопка в пост {message.message_id}")
    except Exception as e:
        print(f"❌ [КАНАЛ] Не удалось добавить кнопку: {e}")


# ================== НАЖАТИЕ КНОПКИ В КАНАЛЕ ==================
@dp.callback_query(F.data.startswith("earn_"))
async def handle_earn_button(callback: CallbackQuery):
    if not callback.message:
        await callback.answer("Сообщение удалено.", show_alert=True)
        return

    user = callback.from_user
    channel_id = callback.message.chat.id
    limit = 3 if user.is_premium else 1
    
    try:
        msg_id = int(callback.data.split("_", 1)[1])
    except (ValueError, IndexError):
        await callback.answer("Ошибка кнопки", show_alert=True)
        return
    
    try:
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow('''
                    SELECT click_count, max_rewarded FROM channel_rewards 
                    WHERE chat_id = $1 AND message_id = $2 AND user_id = $3
                ''', channel_id, msg_id, user.id)
                
                if not row:
                    await conn.execute('''
                        INSERT INTO channel_rewards (chat_id, message_id, user_id, click_count, max_rewarded)
                        VALUES ($1, $2, $3, 1, 1)
                    ''', channel_id, msg_id, user.id)
                    await conn.execute('''
                        INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                        ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
                    ''', user.id, user.first_name, user.username)
                    await conn.execute('UPDATE users SET balance = balance + 1 WHERE user_id = $1', user.id)
                    await callback.answer(f"✅ +1 балл! (1/{limit})")
                    return

                click_count = row['click_count'] + 1
                if click_count <= limit:
                    await conn.execute('''
                        UPDATE channel_rewards SET click_count = $1, max_rewarded = max_rewarded + 1
                        WHERE chat_id = $2 AND message_id = $3 AND user_id = $4
                    ''', click_count, channel_id, msg_id, user.id)
                    await conn.execute('UPDATE users SET balance = balance + 1 WHERE user_id = $1', user.id)
                    await callback.answer(f"✅ +1 балл! ({click_count}/{limit})")
                    return
                
                await conn.execute('''
                    UPDATE channel_rewards SET click_count = $1
                    WHERE chat_id = $2 AND message_id = $3 AND user_id = $4
                ''', click_count, channel_id, msg_id, user.id)
                
                if click_count == limit + 1:
                    await callback.answer("⚠️ Лимит исчерпан. Баллы не начислены.", show_alert=True)
                else:
                    await conn.execute('UPDATE users SET balance = balance - 5 WHERE user_id = $1', user.id)
                    await callback.answer("❌ Штраф -5 баллов за накрутку!", show_alert=True)
    except Exception as e:
        print(f"❌ [КАНАЛ] Ошибка: {e}")
        await callback.answer("Ошибка сервера", show_alert=True)


# ================== РЕАКЦИИ ==================
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
            return
        
        async with db_pool.acquire() as conn:
            msg = await conn.fetchrow(
                'SELECT author_id FROM messages WHERE chat_id = $1 AND message_id = $2',
                chat_id, msg_id
            )
        if not msg:
            print(f"❌ [ЛОГ] Сообщение {msg_id} не найдено.")
            return
        target_user_id = msg['author_id']
        if target_user_id == user.id:
            return

        async with db_pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute('''
                    INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                    ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
                ''', target_user_id, user.first_name, user.username)
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
                    print(f"✅ [ЛОГ] {user.first_name} поставил {sorted(new)}. +{reward}.")
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
                    print(f"✅ [ЛОГ] {user.first_name} добавил {sorted(added)}. +{total_reward}.")

                if new_manipulations > 0:
                    if new_toggles == 1:
                        print(f"⚠️ [ЛОГ] {user.first_name} переставил. Баллы не начислены.")
                    else:
                        await conn.execute(
                            'UPDATE users SET balance = balance - 5 WHERE user_id = $1',
                            user.id
                        )
                        print(f"❌ [ЛОГ] {user.first_name} нарушает. Штраф -5.")
    except Exception as e:
        print(f"❌ [ЛОГ] Ошибка реакции: {e}")


# ================== ВАЛИДАЦИЯ INIT DATA ==================
def validate_init_data(init_data: str) -> dict | None:
    try:
        parsed_data = dict(parse_qsl(init_data))
        if "hash" not in parsed_data:
            return None
        received_hash = parsed_data.pop("hash")
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed_data.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(calculated_hash, received_hash):
            return json.loads(parsed_data.get("user", "{}"))
        return None
    except Exception as e:
        print(f"❌ Ошибка валидации initData: {e}")
        return None


# ================== API ==================
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
    return web.json_response({"balance": row['balance'] if row else 0, "user_id": user_id})


async def api_top(request):
    init_data = request.query.get("initData")
    if not init_data:
        return web.json_response({"error": "No initData"}, status=401)
    if not validate_init_data(init_data):
        return web.json_response({"error": "Invalid initData"}, status=403)
    async with db_pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT user_id, balance, first_name, username 
            FROM users ORDER BY balance DESC LIMIT 5
        ''')
    top_list = [{"user_id": r["user_id"], "balance": r["balance"], "first_name": r["first_name"] or "Аноним", "username": r["username"]} for r in rows]
    return web.json_response({"top": top_list})


# ================== ВЕБ-СЕРВЕР ==================
async def handle_ping(request):
    return web.Response(text="Bot is alive")


async def start_web_server():
    app = web.Application()
    app.router.add_get('/', handle_ping)
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
