import asyncio
import os
import os.path
import asyncpg
import hashlib
import hmac
import json
import random
from urllib.parse import parse_qsl
from datetime import datetime, timedelta
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart, Command, CommandObject
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
BOT_USERNAME = ""
dp = Dispatcher()


def get_main_kb(is_private: bool) -> ReplyKeyboardMarkup:
    if is_private:
        buttons = [[KeyboardButton(text="💰 Баланс"), KeyboardButton(text="🔗 Мои ссылки")], [KeyboardButton(text="🗑 Сбросить прогресс")]]
    else:
        buttons = [[KeyboardButton(text="💰 Баланс")]]
    return ReplyKeyboardMarkup(keyboard=buttons, resize_keyboard=True)


async def init_db():
    global db_pool
    print("⏳ Подключаемся к базе данных...")
    for attempt in range(1, 6):
        try:
            db_pool = await asyncpg.create_pool(DATABASE_URL, timeout=20, min_size=1, max_size=10)
            async with db_pool.acquire() as conn:
                
                has_old_balance = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'balance')")
                if has_old_balance:
                    await conn.execute('ALTER TABLE users DROP COLUMN balance')

                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS users (
                        user_id BIGINT PRIMARY KEY,
                        first_name TEXT,
                        username TEXT
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS messages (
                        chat_id BIGINT,
                        message_id BIGINT,
                        author_id BIGINT,
                        text TEXT,
                        PRIMARY KEY (chat_id, message_id)
                    );
                ''')
                await conn.execute('ALTER TABLE messages ADD COLUMN IF NOT EXISTS text TEXT')
                
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
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS bot_admins (
                        user_id BIGINT PRIMARY KEY
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS managed_chats (
                        chat_id BIGINT PRIMARY KEY,
                        owner_id BIGINT NOT NULL,
                        title TEXT,
                        chat_type TEXT,
                        linked_chat_id BIGINT
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS balances (
                        chat_id BIGINT NOT NULL,
                        user_id BIGINT NOT NULL,
                        balance INTEGER DEFAULT 0,
                        PRIMARY KEY (chat_id, user_id)
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS chat_admins (
                        chat_id BIGINT NOT NULL,
                        user_id BIGINT NOT NULL,
                        PRIMARY KEY (chat_id, user_id)
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS transactions (
                        id SERIAL PRIMARY KEY,
                        chat_id BIGINT NOT NULL,
                        sender_id BIGINT,
                        receiver_id BIGINT NOT NULL,
                        amount INTEGER NOT NULL,
                        type TEXT NOT NULL,
                        message_text TEXT,
                        created_at TIMESTAMP DEFAULT NOW()
                    );
                ''')
                await conn.execute('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS message_text TEXT')
                await conn.execute('CREATE INDEX IF NOT EXISTS idx_trans_chat ON transactions(chat_id)')
                await conn.execute('CREATE INDEX IF NOT EXISTS idx_trans_recv ON transactions(receiver_id)')
                
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS referral_links (
                        invite_link TEXT PRIMARY KEY,
                        chat_id BIGINT NOT NULL,
                        referrer_id BIGINT NOT NULL,
                        created_at TIMESTAMP DEFAULT NOW()
                    );
                ''')
                await conn.execute("DELETE FROM referral_links WHERE invite_link LIKE '%start=%'")
                
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS referrals (
                        referrer_id BIGINT NOT NULL,
                        referred_id BIGINT NOT NULL,
                        chat_id BIGINT NOT NULL,
                        status TEXT DEFAULT 'pending',
                        check_at TIMESTAMP NOT NULL,
                        PRIMARY KEY (referred_id, chat_id)
                    );
                ''')

                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS predictions (
                        id SERIAL PRIMARY KEY,
                        chat_id BIGINT NOT NULL,
                        creator_id BIGINT NOT NULL,
                        question TEXT NOT NULL,
                        status TEXT DEFAULT 'active',
                        end_time TIMESTAMP NOT NULL,
                        pool_yes BIGINT DEFAULT 0,
                        pool_no BIGINT DEFAULT 0
                    );
                ''')
                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS prediction_bets (
                        id SERIAL PRIMARY KEY,
                        prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
                        user_id BIGINT NOT NULL,
                        amount BIGINT DEFAULT 0,
                        choice TEXT NOT NULL,
                        UNIQUE (prediction_id, user_id)
                    );
                ''')

                await conn.execute('''
                    CREATE TABLE IF NOT EXISTS pixel_battle (
                        x INTEGER NOT NULL,
                        y INTEGER NOT NULL,
                        color TEXT NOT NULL,
                        PRIMARY KEY (x, y)
                    );
                ''')
                
            print("✅ База данных готова.")
            return
        except Exception as e:
            print(f"❌ Ошибка БД (попытка {attempt}/5): {e}")
            if attempt == 5:
                raise
            await asyncio.sleep(5)


@dp.my_chat_member()
async def track_chat_owner(update: ChatMemberUpdated):
    if update.new_chat_member.status in ("administrator", "member"):
        chat = update.chat
        try:
            admins = await bot.get_chat_administrators(chat.id)
            owner_id = None
            admin_ids = []
            for admin in admins:
                admin_ids.append(admin.user.id)
                if admin.status == "creator":
                    owner_id = admin.user.id

            linked_id = getattr(chat, 'linked_chat_id', None)
            async with db_pool.acquire() as conn:
                if owner_id:
                    await conn.execute('INSERT INTO bot_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', owner_id)
                    await conn.execute('''
                        INSERT INTO managed_chats (chat_id, owner_id, title, chat_type, linked_chat_id)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (chat_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, title = EXCLUDED.title, chat_type = EXCLUDED.chat_type, linked_chat_id = EXCLUDED.linked_chat_id
                    ''', chat.id, owner_id, chat.title, chat.type, linked_id)
                
                await conn.execute('DELETE FROM chat_admins WHERE chat_id = $1', chat.id)
                for adm in admin_ids:
                    await conn.execute('INSERT INTO chat_admins (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', chat.id, adm)
                    
            print(f"👑 [ЧАТ] {chat.title}. Админов сохранено: {len(admin_ids)}.")
        except Exception as e:
            print(f"❌ Не удалось синхронизировать чат {chat.id}: {e}")


@dp.chat_member()
async def track_member_join(update: ChatMemberUpdated):
    old_status = update.old_chat_member.status
    new_status = update.new_chat_member.status
    
    if old_status in ('left', 'kicked') and new_status in ('member', 'administrator', 'creator'):
        if not update.invite_link:
            return
        
        invite_url = update.invite_link.invite_link
        new_user_id = update.new_chat_member.user.id
        chat_id = update.chat.id
        
        async with db_pool.acquire() as conn:
            link_row = await conn.fetchrow('SELECT referrer_id FROM referral_links WHERE invite_link = $1', invite_url)
            if not link_row: return
            referrer_id = link_row['referrer_id']
            if referrer_id == new_user_id: return
            
            exists = await conn.fetchval('SELECT 1 FROM referrals WHERE referred_id = $1 AND chat_id = $2', new_user_id, chat_id)
            if exists: return
            
            check_time = datetime.now() + timedelta(hours=1)
            await conn.execute('''
                INSERT INTO referrals (referrer_id, referred_id, chat_id, status, check_at)
                VALUES ($1, $2, $3, 'pending', $4)
            ''', referrer_id, new_user_id, chat_id, check_time)
            print(f"🤝 [РЕФ] Юзер {new_user_id} вступил в {chat_id} по ссылке от {referrer_id}.")


@dp.message(CommandStart())
async def cmd_start(message: Message):
    if message.chat.type == "private":
        text = (
            "👋 Привет! Я бот для начисления баллов в чате и на канале.\n\n"
            "💬 <b>В ЧАТЕ:</b> другие ставят реакции на твои сообщения — баллы тебе.\n"
            "📢 <b>В КАНАЛЕ:</b> жми кнопку «👀 Забрать баллы» под постом.\n"
            "💎 <b>Premium:</b> в чате можно поставить до 3 реакций на одно сообщение.\n"
            "👑 <b>Модераторы:</b> приносят x5 баллов (и штрафы у них тоже x5).\n\n"
            "⚠️ <b>Античит:</b> за накрутку сначала предупреждение, потом штраф.\n\n"
            "💰 Жми «Баланс» — увидишь сколько у тебя в каждом чате."
        )
        await message.answer(text, reply_markup=get_main_kb(is_private=True), parse_mode="HTML")
    else:
        await message.answer("👋 Я работаю в чате. Пиши сообщения и собирай реакции!", reply_markup=get_main_kb(is_private=False))


@dp.message(F.text == "🔗 Мои ссылки", F.chat.type == "private")
async def cmd_ref_menu(message: Message):
    user_id = message.from_user.id
    async with db_pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT DISTINCT m.chat_id, m.title, m.chat_type 
            FROM managed_chats m
            LEFT JOIN balances b ON b.chat_id = m.chat_id AND b.user_id = $1
            LEFT JOIN chat_admins ca ON ca.chat_id = m.chat_id AND ca.user_id = $1
            WHERE b.user_id IS NOT NULL OR ca.user_id IS NOT NULL OR m.owner_id = $1
        ''', user_id)
        
    if not rows:
        await message.answer("Ты пока не участвуешь ни в одном чате с ботом.")
        return

    buttons = []
    for r in rows:
        title = r['title'] or str(r['chat_id'])
        icon = "📢" if r['chat_type'] == "channel" else "💬"
        buttons.append([InlineKeyboardButton(text=f"{icon} {title}", callback_data=f"getref_{r['chat_id']}")])
        
    kb = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer("Выбери чат, для которого хочешь получить реферальную ссылку:", reply_markup=kb)


@dp.callback_query(F.data.startswith("getref_"))
async def handle_getref(callback: CallbackQuery):
    chat_id = int(callback.data.split("_")[1])
    user = callback.from_user
    
    async with db_pool.acquire() as conn:
        existing = await conn.fetchrow('''
            SELECT invite_link FROM referral_links 
            WHERE chat_id = $1 AND referrer_id = $2
            AND invite_link NOT LIKE '%start=%'
            ORDER BY created_at DESC LIMIT 1
        ''', chat_id, user.id)
        
        if existing and existing['invite_link']:
            link = existing['invite_link']
        else:
            try:
                inv = await asyncio.wait_for(
                    bot.create_chat_invite_link(chat_id=chat_id, name=f"От {user.first_name}", creates_join_request=False),
                    timeout=3.0
                )
                link = inv.invite_link
                await conn.execute('''
                    INSERT INTO referral_links (invite_link, chat_id, referrer_id)
                    VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
                ''', link, chat_id, user.id)
            except asyncio.TimeoutError:
                await callback.answer(f"❌ Telegram не ответил вовремя. Попробуй позже.", show_alert=True)
                return
            except Exception as e:
                await callback.answer(f"❌ Не могу создать ссылку. Дай боту права 'Приглашать по ссылке'. Ошибка: {e}", show_alert=True)
                return
    
    text = (
        f"🔗 <b>Твоя ссылка для приглашения:</b>\n\n"
        f"<code>{link}</code>\n\n"
        f"<i>Скопируй её и отправь другу. Он перейдёт по ней и сразу попадёт в чат. Через 1 час, если он останется в чате, ты получишь +10 баллов.</i>"
    )
    await callback.message.answer(text, parse_mode="HTML")
    await callback.answer()


@dp.message(F.text.in_({"/balance", "/баллы", "💰 Баланс"}), F.chat.type != "channel")
async def cmd_balance(message: Message):
    if not message.from_user: return
    user_id = message.from_user.id
    chat_id = message.chat.id
    
    if message.chat.type == "private":
        async with db_pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT b.chat_id, b.balance, m.title, m.chat_type
                FROM balances b LEFT JOIN managed_chats m ON m.chat_id = b.chat_id
                WHERE b.user_id = $1 AND b.balance != 0 ORDER BY b.balance DESC
            ''', user_id)
        
        if not rows:
            await message.answer("💰 У тебя пока нет баллов ни в одном чате.")
            return
        
        lines = ["💰 <b>Твои балансы:</b>\n"]
        for r in rows:
            title = r['title'] or f"Чат {r['chat_id']}"
            icon = "📢" if r['chat_type'] == "channel" else "💬"
            lines.append(f"{icon} {title}: <b>{r['balance']}</b> баллов")
        await message.answer("\n".join(lines), parse_mode="HTML")
    else:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow('SELECT balance FROM balances WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
        balance = row['balance'] if row else 0
        await message.answer(f"💰 {message.from_user.first_name}, твой баланс в этом чате: {balance} баллов.")


@dp.message(F.text == "🗑 Сбросить прогресс", F.chat.type == "private")
async def cmd_reset_menu(message: Message):
    user_id = message.from_user.id
    async with db_pool.acquire() as conn:
        if user_id in ADMIN_IDS:
            rows = await conn.fetch('SELECT chat_id, title, chat_type, linked_chat_id FROM managed_chats')
        else:
            rows = await conn.fetch('SELECT chat_id, title, chat_type, linked_chat_id FROM managed_chats WHERE owner_id = $1', user_id)

    if not rows:
        await message.answer("У тебя нет чатов или каналов, где ты являешься владельцем.")
        return

    shown = set()
    buttons = []
    for r in rows:
        chat_id = r['chat_id']
        linked_id = r['linked_chat_id']
        if chat_id in shown: continue
        title = r['title'] or str(chat_id)
        chat_type = "Канал" if r['chat_type'] == "channel" else "Чат"
        callback_data = f"resetchat_{chat_id}_{linked_id if linked_id else 0}"
        buttons.append([InlineKeyboardButton(text=f"🗑 {chat_type}: {title}", callback_data=callback_data)])
        shown.add(chat_id)
        if linked_id: shown.add(linked_id)

    kb = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer("Выбери чат для сброса:", reply_markup=kb)


@dp.callback_query(F.data.startswith("resetchat_"))
async def handle_reset_chat(callback: CallbackQuery):
    parts = callback.data.split("_")
    chat_id = int(parts[1])
    linked_id = int(parts[2]) if parts[2] != "0" else None

    async with db_pool.acquire() as conn:
        owner_row = await conn.fetchrow('SELECT owner_id, title FROM managed_chats WHERE chat_id = $1', chat_id)
        if not owner_row:
            await callback.answer("Чат не найден", show_alert=True)
            return
        if callback.from_user.id not in ADMIN_IDS and owner_row['owner_id'] != callback.from_user.id:
            await callback.answer("⛔ Нет прав.", show_alert=True)
            return

        chat_ids = [chat_id] + ([linked_id] if linked_id else [])
        for cid in chat_ids:
            await conn.execute('DELETE FROM messages WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM reactions WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM channel_rewards WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM balances WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM transactions WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM referrals WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM referral_links WHERE chat_id = $1', cid)
            await conn.execute('DELETE FROM predictions WHERE chat_id = $1', cid)

    await callback.answer("✅ Все данные чата сброшены!", show_alert=True)
    title = owner_row['title'] or chat_id
    try:
        await callback.message.edit_text(f"🗑 Все данные для «{title}» удалены.")
    except Exception:
        pass


@dp.message(F.chat.type.in_({"group", "supergroup"}))
async def save_msg(message: Message):
    if not message.from_user or message.from_user.is_bot: return
    msg_text = message.text or message.caption or ""
    async with db_pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO messages (chat_id, message_id, author_id, text) 
            VALUES ($1, $2, $3, $4) 
            ON CONFLICT (chat_id, message_id) DO UPDATE SET text = EXCLUDED.text
        ''', message.chat.id, message.message_id, message.from_user.id, msg_text)
        await conn.execute('''
            INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
        ''', message.from_user.id, message.from_user.first_name, message.from_user.username)


@dp.channel_post()
async def handle_channel_post(message: Message):
    if message.chat.type != "channel": return
    if message.from_user and not message.from_user.is_bot:
        msg_text = message.text or message.caption or ""
        async with db_pool.acquire() as conn:
            await conn.execute('''
                INSERT INTO messages (chat_id, message_id, author_id, text) 
                VALUES ($1, $2, $3, $4) 
                ON CONFLICT (chat_id, message_id) DO UPDATE SET text = EXCLUDED.text
            ''', message.chat.id, message.message_id, message.from_user.id, msg_text)
            await conn.execute('''
                INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
            ''', message.from_user.id, message.from_user.first_name, message.from_user.username)

    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="👀 Забрать баллы", callback_data=f"earn_{message.message_id}")]])
    try:
        await message.edit_reply_markup(reply_markup=kb)
    except Exception as e:
        print(f"❌ [КАНАЛ] Не удалось добавить кнопку: {e}")


@dp.callback_query(F.data.startswith("earn_"))
async def handle_earn_button(callback: CallbackQuery):
    if not callback.message: return
    user = callback.from_user
    channel_id = callback.message.chat.id
    msg_id = int(callback.data.split("_", 1)[1])
    
    try:
        async with db_pool.acquire() as conn:
            author_row = await conn.fetchrow('SELECT author_id, text FROM messages WHERE chat_id = $1 AND message_id = $2', channel_id, msg_id)
            msg_text = author_row['text'] if author_row else ""
            
            if author_row and author_row['author_id'] == user.id:
                await callback.answer("❌ Вы не можете зарабатывать баллы на своих постах!", show_alert=True)
                return

            async with conn.transaction():
                row = await conn.fetchrow('SELECT click_count FROM channel_rewards WHERE chat_id = $1 AND message_id = $2 AND user_id = $3', channel_id, msg_id, user.id)
                
                reward_given = False
                if not row:
                    await conn.execute('INSERT INTO channel_rewards (chat_id, message_id, user_id, click_count, max_rewarded) VALUES ($1, $2, $3, 1, 1)', channel_id, msg_id, user.id)
                    reward_given = True
                else:
                    click_count = row['click_count'] + 1
                    if click_count <= 1:
                        await conn.execute('UPDATE channel_rewards SET click_count = $1, max_rewarded = max_rewarded + 1 WHERE chat_id = $2 AND message_id = $3 AND user_id = $4', click_count, channel_id, msg_id, user.id)
                        reward_given = True
                    else:
                        await conn.execute('UPDATE channel_rewards SET click_count = $1 WHERE chat_id = $2 AND message_id = $3 AND user_id = $4', click_count, channel_id, msg_id, user.id)
                        if click_count == 2:
                            await callback.answer("⚠️ Лимит исчерпан. Баллы не начислены.", show_alert=True)
                        else:
                            await conn.execute('''
                                INSERT INTO balances (chat_id, user_id, balance) VALUES ($1, $2, -5)
                                ON CONFLICT (chat_id, user_id) DO UPDATE SET balance = balances.balance - 5
                            ''', channel_id, user.id)
                            await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $2, -5, 'fine', $3)", channel_id, user.id, msg_text)
                            await callback.answer("❌ Штраф -5 баллов за накрутку!", show_alert=True)
                        return

                if reward_given:
                    await conn.execute('''
                        INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                        ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
                    ''', user.id, user.first_name, user.username)
                    await conn.execute('''
                        INSERT INTO balances (chat_id, user_id, balance) VALUES ($1, $2, 1)
                        ON CONFLICT (chat_id, user_id) DO UPDATE SET balance = balances.balance + 1
                    ''', channel_id, user.id)
                    await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $2, 1, 'channel_earn', $3)", channel_id, user.id, msg_text)
                    await callback.answer("✅ +1 балл!")
    except Exception as e:
        print(f"❌ [КАНАЛ] Ошибка: {e}")
        await callback.answer("Ошибка сервера", show_alert=True)


@dp.message_reaction()
async def handle_reaction(reaction: MessageReactionUpdated):
    user = reaction.user
    if not user: return
    old = {r.emoji for r in reaction.old_reaction if r.type == 'emoji'}
    new = {r.emoji for r in reaction.new_reaction if r.type == 'emoji'}
    added = new - old
    if not added: return

    chat_id = reaction.chat.id
    msg_id = reaction.message_id

    try:
        if reaction.chat.type == "channel": return
        
        async with db_pool.acquire() as conn:
            msg = await conn.fetchrow('SELECT author_id, text FROM messages WHERE chat_id = $1 AND message_id = $2', chat_id, msg_id)
            if not msg: return
            target_user_id = msg['author_id']
            msg_text = msg['text'] or ""
            
            if target_user_id == user.id: return
            
            is_mod = await conn.fetchval('SELECT 1 FROM chat_admins WHERE chat_id = $1 AND user_id = $2', chat_id, user.id)
            multiplier = 5 if is_mod else 1

            async with conn.transaction():
                await conn.execute('''
                    INSERT INTO users (user_id, first_name, username) VALUES ($1, $2, $3)
                    ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
                ''', user.id, user.first_name, user.username)

                row = await conn.fetchrow('''
                    SELECT id, max_rewarded, rewarded_emojis, toggles FROM reactions
                    WHERE chat_id = $1 AND user_id = $2 AND message_id = $3
                ''', chat_id, user.id, msg_id)
                current_unique = len(new)

                if row is None:
                    reward = current_unique * multiplier
                    await conn.execute('''
                        INSERT INTO reactions (chat_id, user_id, message_id, max_rewarded, rewarded_emojis, toggles)
                        VALUES ($1, $2, $3, $4, $5, 0)
                    ''', chat_id, user.id, msg_id, reward, list(new))
                    
                    await conn.execute('''
                        INSERT INTO balances (chat_id, user_id, balance) VALUES ($1, $2, $3)
                        ON CONFLICT (chat_id, user_id) DO UPDATE SET balance = balances.balance + EXCLUDED.balance
                    ''', chat_id, target_user_id, reward)
                    await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $3, $4, 'reaction_earn', $5)", chat_id, user.id, target_user_id, reward, msg_text)
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
                await conn.execute('UPDATE reactions SET max_rewarded = $1, rewarded_emojis = $2, toggles = $3 WHERE id = $4', max_rewarded, list(rewarded_emojis), new_toggles, row['id'])

                if total_reward > 0:
                    final_reward = total_reward * multiplier
                    await conn.execute('''
                        INSERT INTO balances (chat_id, user_id, balance) VALUES ($1, $2, $3)
                        ON CONFLICT (chat_id, user_id) DO UPDATE SET balance = balances.balance + EXCLUDED.balance
                    ''', chat_id, target_user_id, final_reward)
                    await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $3, $4, 'reaction_earn', $5)", chat_id, user.id, target_user_id, final_reward, msg_text)

                if new_manipulations > 0 and new_toggles > 1:
                    fine = 5 * multiplier
                    await conn.execute('''
                        INSERT INTO balances (chat_id, user_id, balance) VALUES ($1, $2, $3)
                        ON CONFLICT (chat_id, user_id) DO UPDATE SET balance = balances.balance - $3
                    ''', chat_id, user.id, fine)
                    await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $2, $3, 'fine', $4)", chat_id, user.id, -fine, msg_text)
    except Exception as e:
        print(f"❌ [ЛОГ] Ошибка реакции: {e}")


async def check_referrals_loop():
    while True:
        try:
            await asyncio.sleep(60)
            async with db_pool.acquire() as conn:
                rows = await conn.fetch("SELECT referrer_id, referred_id, chat_id FROM referrals WHERE status = 'pending' AND check_at <= NOW()")
                
            for r in rows:
                try:
                    member = await bot.get_chat_member(r['chat_id'], r['referred_id'])
                    if member.status in ['member', 'administrator', 'creator']:
                        async with db_pool.acquire() as conn:
                            async with conn.transaction():
                                await conn.execute("UPDATE referrals SET status = 'completed' WHERE referred_id = $1 AND chat_id = $2", r['referred_id'], r['chat_id'])
                                await conn.execute('''
                                    INSERT INTO balances (chat_id, user_id, balance) VALUES ($1, $2, 10)
                                    ON CONFLICT (chat_id, user_id) DO UPDATE SET balance = balances.balance + 10
                                ''', r['chat_id'], r['referrer_id'])
                                await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type) VALUES ($1, $2, $2, 10, 'referral')", r['chat_id'], r['referrer_id'])
                                print(f"💰 [РЕФ] {r['referrer_id']} получил +10 за {r['referred_id']}.")
                    else:
                        async with db_pool.acquire() as conn:
                            await conn.execute("UPDATE referrals SET status = 'failed' WHERE referred_id = $1 AND chat_id = $2", r['referred_id'], r['chat_id'])
                except Exception as e:
                    print(f"⚠️ Ошибка проверки рефа {r['referred_id']}: {e}")
                    async with db_pool.acquire() as conn:
                        await conn.execute("UPDATE referrals SET status = 'failed' WHERE referred_id = $1 AND chat_id = $2", r['referred_id'], r['chat_id'])
                await asyncio.sleep(0.5)
        except Exception as e:
            print(f"❌ Ошибка фонового цикла: {e}")


def validate_init_data(init_data: str) -> dict | None:
    try:
        parsed_data = dict(parse_qsl(init_data))
        if "hash" not in parsed_data: return None
        received_hash = parsed_data.pop("hash")
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed_data.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(calculated_hash, received_hash):
            return json.loads(parsed_data.get("user", "{}"))
        return None
    except Exception:
        return None


async def api_balance(request):
    try:
        init_data = request.query.get("initData")
        if not init_data: return web.json_response({"error": "No initData"}, status=401)
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        
        async with db_pool.acquire() as conn:
            total = await conn.fetchval('SELECT COALESCE(SUM(balance), 0) FROM balances WHERE user_id = $1', user_id)
            
            rows = await conn.fetch('''
                SELECT b.chat_id, b.balance, m.title, m.chat_type
                FROM balances b 
                LEFT JOIN managed_chats m ON m.chat_id = b.chat_id
                WHERE b.user_id = $1 AND b.balance != 0 
                ORDER BY b.balance DESC
            ''', user_id)
            
            my_chats_raw = await conn.fetch('''
                SELECT m.chat_id, MAX(COALESCE(m.title, 'Без названия')) as title, MAX(COALESCE(m.chat_type, 'group')) as chat_type
                FROM managed_chats m
                LEFT JOIN balances b ON b.chat_id = m.chat_id AND b.user_id = $1
                LEFT JOIN chat_admins ca ON ca.chat_id = m.chat_id AND ca.user_id = $1
                WHERE b.user_id IS NOT NULL OR ca.user_id IS NOT NULL OR m.owner_id = $1
                GROUP BY m.chat_id
            ''', user_id)
            
            my_chats = []
            seen_titles = set() 
            
            for r in my_chats_raw:
                title = r['title']
                if title in seen_titles:
                    continue
                seen_titles.add(title)
                
                cid = r['chat_id']
                link = None
                
                try:
                    inv = await asyncio.wait_for(bot.create_chat_invite_link(chat_id=cid, name=f"От {user_data.get('first_name', 'User')}"), timeout=2.0)
                    link = inv.invite_link
                except Exception as e:
                    print(f"⚠️ Не удалось создать ссылку для {cid}: {e}")
                
                my_chats.append({
                    "chat_id": cid,
                    "title": title,
                    "chat_type": r['chat_type'],
                    "referral_link": link
                })
            
        return web.json_response({
            "user_id": user_id,
            "total_balance": total,
            "balances": [{"chat_id": r["chat_id"], "balance": r["balance"], "title": r["title"] or f"Чат {r['chat_id']}", "chat_type": r["chat_type"]} for r in rows],
            "my_chats": my_chats
        })
    except Exception as e:
        print(f"❌ КРИТИЧЕСКАЯ ОШИБКА В API_BALANCE: {e}")
        return web.json_response({"error": "Internal Server Error", "details": str(e)}, status=500)


async def api_top(request):
    init_data = request.query.get("initData")
    if not init_data: return web.json_response({"error": "No initData"}, status=401)
    user_data = validate_init_data(init_data)
    if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
    user_id = user_data.get("id")
    chat_id_str = request.query.get("chat_id")
    
    if not chat_id_str:
        return web.json_response({"error": "No chat_id"}, status=400)
    
    chat_id = int(chat_id_str)
    
    async with db_pool.acquire() as conn:
        top_rows = await conn.fetch('''
            SELECT b.user_id, b.balance, u.first_name
            FROM balances b JOIN users u ON u.user_id = b.user_id
            WHERE b.chat_id = $1
            ORDER BY b.balance DESC LIMIT 5
        ''', chat_id)
        
        user_bal_row = await conn.fetchrow('SELECT balance FROM balances WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
        user_bal = user_bal_row['balance'] if user_bal_row else 0
        
        rank_row = await conn.fetchval('SELECT COUNT(*) + 1 FROM balances WHERE chat_id = $1 AND balance > $2', chat_id, user_bal)
        
        to_top5 = 0
        if len(top_rows) >= 5 and rank_row > 5:
            fifth_place_bal = top_rows[-1]['balance']
            to_top5 = (fifth_place_bal - user_bal) + 1
        elif len(top_rows) < 5 and rank_row > len(top_rows):
             to_top5 = 1 
             
        return web.json_response({
            "top": [{"user_id": r["user_id"], "balance": r["balance"], "first_name": r["first_name"] or "Аноним"} for r in top_rows],
            "user_place": {
                "rank": rank_row,
                "balance": user_bal,
                "name": user_data.get('first_name', 'Ты'),
                "to_top5": to_top5
            }
        })


async def api_shop_casino(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        chat_id = int(data.get("chat_id"))
        bet = int(data.get("bet"))
        
        if bet <= 0:
            return web.json_response({"error": "Ставка должна быть больше 0"}, status=400)
            
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                bal_row = await conn.fetchrow('SELECT balance FROM balances WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
                current_bal = bal_row['balance'] if bal_row else 0
                
                if current_bal < bet:
                    return web.json_response({"error": "Недостаточно баллов в этом чате"}, status=400)
                
                await conn.execute('UPDATE balances SET balance = balance - $1 WHERE chat_id = $2 AND user_id = $3', bet, chat_id, user_id)
                await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type) VALUES ($1, $2, $2, $3, 'casino_bet')", chat_id, user_id, -bet)
                
                win = random.choice([True, False])
                
                if win:
                    win_amount = bet * 2
                    await conn.execute('UPDATE balances SET balance = balance + $1 WHERE chat_id = $2 AND user_id = $3', win_amount, chat_id, user_id)
                    await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type) VALUES ($1, $2, $2, $3, 'casino_win')", chat_id, user_id, win_amount)
                    return web.json_response({"result": "win", "amount": win_amount})
                else:
                    return web.json_response({"result": "lose", "amount": bet})
    except Exception as e:
        print(f"❌ Ошибка казино: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def api_shop_post(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        chat_id = int(data.get("chat_id"))
        text = data.get("text")
        is_anonymous = data.get("is_anonymous", False)
        
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        user_name = user_data.get("first_name", "User")
        
        cost = 20 
        
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                bal_row = await conn.fetchrow('SELECT balance FROM balances WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
                current_bal = bal_row['balance'] if bal_row else 0
                
                if current_bal < cost:
                    return web.json_response({"error": f"Нужно {cost} баллов в этом чате"}, status=400)
                
                if is_anonymous:
                    post_text = f"🕵️‍♂️ <b>Анонимное сообщение:</b>\n\n{text}"
                else:
                    post_text = f"📢 <b>Сообщение от {user_name}:</b>\n\n{text}"
                
                try:
                    await bot.send_message(chat_id=chat_id, text=post_text, parse_mode="HTML")
                except Exception as e:
                    return web.json_response({"error": f"Не удалось отправить в канал: {e}"}, status=500)
                
                await conn.execute('UPDATE balances SET balance = balance - $1 WHERE chat_id = $2 AND user_id = $3', cost, chat_id, user_id)
                await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $2, $3, 'shop_post', $4)", chat_id, user_id, -cost, text)
                
                return web.json_response({"result": "ok"})
    except Exception as e:
        print(f"❌ Ошибка поста: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def api_predictions_list(request):
    try:
        init_data = request.query.get("initData")
        chat_id_str = request.query.get("chat_id")
        if not init_data or not chat_id_str: return web.json_response({"error": "No data"}, status=400)
        
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        chat_id = int(chat_id_str)
        
        async with db_pool.acquire() as conn:
            is_admin = await conn.fetchval('SELECT 1 FROM chat_admins WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
            
            preds = await conn.fetch('''
                SELECT id, question, status, end_time, pool_yes, pool_no, creator_id
                FROM predictions WHERE chat_id = $1 ORDER BY id DESC LIMIT 20
            ''', chat_id)
            
            res = []
            for p in preds:
                user_bet = await conn.fetchrow('SELECT amount, choice FROM prediction_bets WHERE prediction_id = $1 AND user_id = $2', p['id'], user_id)
                res.append({
                    "id": p['id'],
                    "question": p['question'],
                    "status": p['status'],
                    "end_time": p['end_time'].isoformat(),
                    "pool_yes": p['pool_yes'],
                    "pool_no": p['pool_no'],
                    "user_bet": dict(user_bet) if user_bet else None
                })
                
            return web.json_response({"predictions": res, "is_admin": bool(is_admin)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_predictions_create(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        chat_id = int(data.get("chat_id"))
        question = data.get("question")
        hours = int(data.get("hours", 3))
        
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        
        async with db_pool.acquire() as conn:
            is_admin = await conn.fetchval('SELECT 1 FROM chat_admins WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
            if not is_admin and user_id not in ADMIN_IDS:
                return web.json_response({"error": "Ты не админ этого чата"}, status=403)
            
            end_time = datetime.now() + timedelta(hours=hours)
            await conn.execute('''
                INSERT INTO predictions (chat_id, creator_id, question, status, end_time)
                VALUES ($1, $2, $3, 'active', $4)
            ''', chat_id, user_id, question, end_time)
            
            return web.json_response({"result": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_predictions_bet(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        chat_id = int(data.get("chat_id"))
        pred_id = int(data.get("pred_id"))
        choice = data.get("choice")
        amount = int(data.get("amount"))
        
        if amount <= 0: return web.json_response({"error": "Ставка должна быть > 0"}, status=400)
        
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                pred = await conn.fetchrow('SELECT status, end_time FROM predictions WHERE id = $1 AND chat_id = $2', pred_id, chat_id)
                if not pred or pred['status'] != 'active':
                    return web.json_response({"error": "Ставка закрыта или не найдена"}, status=400)
                
                if datetime.now() > pred['end_time'].replace(tzinfo=None):
                    return web.json_response({"error": "Время ставок истекло!"}, status=400)
                
                bal_row = await conn.fetchrow('SELECT balance FROM balances WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
                current_bal = bal_row['balance'] if bal_row else 0
                if current_bal < amount:
                    return web.json_response({"error": "Недостаточно баллов"}, status=400)
                
                existing_bet = await conn.fetchrow('SELECT choice FROM prediction_bets WHERE prediction_id = $1 AND user_id = $2', pred_id, user_id)
                if existing_bet and existing_bet['choice'] != choice:
                    return web.json_response({"error": "Ты уже ставил на другой исход!"}, status=400)
                
                await conn.execute('UPDATE balances SET balance = balance - $1 WHERE chat_id = $2 AND user_id = $3', amount, chat_id, user_id)
                await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type, message_text) VALUES ($1, $2, $2, $3, 'prediction_bet', $4)", chat_id, user_id, -amount, f"Ставка на {choice}")
                
                if existing_bet:
                    await conn.execute('UPDATE prediction_bets SET amount = amount + $1 WHERE prediction_id = $2 AND user_id = $3', amount, pred_id, user_id)
                else:
                    await conn.execute('INSERT INTO prediction_bets (prediction_id, user_id, amount, choice) VALUES ($1, $2, $3, $4)', pred_id, user_id, amount, choice)
                
                if choice == 'yes':
                    await conn.execute('UPDATE predictions SET pool_yes = pool_yes + $1 WHERE id = $2', amount, pred_id)
                else:
                    await conn.execute('UPDATE predictions SET pool_no = pool_no + $1 WHERE id = $2', amount, pred_id)
                    
                return web.json_response({"result": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_predictions_resolve(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        chat_id = int(data.get("chat_id"))
        pred_id = int(data.get("pred_id"))
        outcome = data.get("outcome")
        
        user_data = validate_init_data(init_data)
        if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
        user_id = user_data.get("id")
        
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                is_admin = await conn.fetchval('SELECT 1 FROM chat_admins WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
                if not is_admin and user_id not in ADMIN_IDS:
                    return web.json_response({"error": "Ты не админ"}, status=403)
                    
                pred = await conn.fetchrow('SELECT pool_yes, pool_no, status FROM predictions WHERE id = $1', pred_id)
                if not pred or pred['status'] != 'active':
                    return web.json_response({"error": "Уже завершено"}, status=400)
                
                pool_yes = pred['pool_yes']
                pool_no = pred['pool_no']
                total_pool = pool_yes + pool_no
                
                win_pool = pool_yes if outcome == 'yes' else pool_no
                
                if win_pool == 0:
                    bets = await conn.fetch('SELECT user_id, amount FROM prediction_bets WHERE prediction_id = $1', pred_id)
                    for b in bets:
                        await conn.execute('UPDATE balances SET balance = balance + $1 WHERE chat_id = $2 AND user_id = $3', b['amount'], chat_id, b['user_id'])
                    await conn.execute("UPDATE predictions SET status = 'canceled' WHERE id = $1", pred_id)
                    return web.json_response({"result": "canceled"})
                
                winning_bets = await conn.fetch('SELECT user_id, amount FROM prediction_bets WHERE prediction_id = $1 AND choice = $2', pred_id, outcome)
                for b in winning_bets:
                    payout = int((b['amount'] / win_pool) * total_pool)
                    await conn.execute('UPDATE balances SET balance = balance + $1 WHERE chat_id = $2 AND user_id = $3', payout, chat_id, b['user_id'])
                    await conn.execute("INSERT INTO transactions (chat_id, sender_id, receiver_id, amount, type) VALUES ($1, $2, $2, $3, 'prediction_win')", chat_id, b['user_id'], payout)
                
                await conn.execute("UPDATE predictions SET status = $1 WHERE id = $2", f"resolved_{outcome}", pred_id)
                return web.json_response({"result": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_pixel_get(request):
    try:
        init_data = request.query.get("initData")
        if not init_data: return web.json_response({"error": "No initData"}, status=401)
        if not validate_init_data(init_data): return web.json_response({"error": "Invalid initData"}, status=403)
        
        async with db_pool.acquire() as conn:
            rows = await conn.fetch('SELECT x, y, color FROM pixel_battle')
            
        pixels = [{"x": r["x"], "y": r["y"], "color": r["color"]} for r in rows]
        return web.json_response({"pixels": pixels})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_pixel_set(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        x = int(data.get("x"))
        y = int(data.get("y"))
        color = data.get("color")
        
        if not validate_init_data(init_data): return web.json_response({"error": "Invalid initData"}, status=403)
        
        if x < 0 or x >= 100 or y < 0 or y >= 100:
            return web.json_response({"error": "Координаты вне поля (100x100)"}, status=400)
            
        async with db_pool.acquire() as conn:
            await conn.execute('''
                INSERT INTO pixel_battle (x, y, color) VALUES ($1, $2, $3)
                ON CONFLICT (x, y) DO UPDATE SET color = EXCLUDED.color
            ''', x, y, color)
            
        return web.json_response({"result": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_pixel_reset(request):
    try:
        data = await request.json()
        init_data = data.get("initData")
        if not validate_init_data(init_data): return web.json_response({"error": "Invalid initData"}, status=403)
        
        async with db_pool.acquire() as conn:
            await conn.execute('DELETE FROM pixel_battle')
            
        return web.json_response({"result": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def api_history(request):
    init_data = request.query.get("initData")
    if not init_data: return web.json_response({"error": "No initData"}, status=401)
    user_data = validate_init_data(init_data)
    if not user_data: return web.json_response({"error": "Invalid initData"}, status=403)
    user_id = user_data.get("id")
    chat_id_str = request.query.get("chat_id")
    
    async with db_pool.acquire() as conn:
        if chat_id_str:
            chat_id = int(chat_id_str)
            is_admin = await conn.fetchval('SELECT 1 FROM chat_admins WHERE chat_id = $1 AND user_id = $2', chat_id, user_id)
            
            if is_admin:
                rows = await conn.fetch('''
                    SELECT t.id, t.sender_id, t.receiver_id, t.amount, t.type, t.message_text, t.created_at, 
                           u1.first_name as sender_name, u2.first_name as receiver_name,
                           m.title as chat_title
                    FROM transactions t
                    LEFT JOIN users u1 ON u1.user_id = t.sender_id
                    LEFT JOIN users u2 ON u2.user_id = t.receiver_id
                    LEFT JOIN managed_chats m ON m.chat_id = t.chat_id
                    WHERE t.chat_id = $1 ORDER BY t.created_at DESC LIMIT 50
                ''', chat_id)
            else:
                rows = await conn.fetch('''
                    SELECT t.id, t.sender_id, t.receiver_id, t.amount, t.type, t.message_text, t.created_at, 
                           u1.first_name as sender_name, u2.first_name as receiver_name,
                           m.title as chat_title
                    FROM transactions t
                    LEFT JOIN users u1 ON u1.user_id = t.sender_id
                    LEFT JOIN users u2 ON u2.user_id = t.receiver_id
                    LEFT JOIN managed_chats m ON m.chat_id = t.chat_id
                    WHERE t.chat_id = $1 AND (t.sender_id = $2 OR t.receiver_id = $2) ORDER BY t.created_at DESC LIMIT 50
                ''', chat_id, user_id)
        else:
            rows = await conn.fetch('''
                SELECT t.id, t.chat_id, t.amount, t.type, t.message_text, t.created_at, 
                       u1.first_name as sender_name, u2.first_name as receiver_name,
                       m.title as chat_title
                FROM transactions t 
                LEFT JOIN users u1 ON u1.user_id = t.sender_id
                LEFT JOIN users u2 ON u2.user_id = t.receiver_id
                LEFT JOIN managed_chats m ON m.chat_id = t.chat_id
                WHERE t.receiver_id = $1 OR t.sender_id = $1 ORDER BY t.created_at DESC LIMIT 50
            ''', user_id)
            
    history_data = []
    for r in rows:
        item = dict(r)
        if isinstance(item.get('created_at'), datetime):
            item['created_at'] = item['created_at'].isoformat()
            
        if not item['message_text']:
            item['message_text'] = ""
            
        history_data.append(item)

    return web.json_response({"history": history_data})


async def handle_ping(request):
    return web.Response(text="Bot is alive")

async def serve_index(request):
    file_path = os.path.join(os.path.dirname(__file__), 'webapp', 'index.html')
    return web.FileResponse(file_path)

async def start_web_server():
    app = web.Application()
    app.router.add_get('/', handle_ping)
    app.router.add_get('/api/balance', api_balance)
    app.router.add_get('/api/top', api_top)
    app.router.add_get('/api/history', api_history)
    
    app.router.add_post('/api/shop/casino', api_shop_casino)
    app.router.add_post('/api/shop/post', api_shop_post)
    
    app.router.add_get('/api/predictions', api_predictions_list)
    app.router.add_post('/api/predictions/create', api_predictions_create)
    app.router.add_post('/api/predictions/bet', api_predictions_bet)
    app.router.add_post('/api/predictions/resolve', api_predictions_resolve)

    app.router.add_get('/api/pixel/get', api_pixel_get)
    app.router.add_post('/api/pixel/set', api_pixel_set)
    app.router.add_post('/api/pixel/reset', api_pixel_reset)
    
    app.router.add_get('/webapp', serve_index)
    app.router.add_get('/webapp/', serve_index)
    app.router.add_static('/webapp/', path=os.path.join(os.path.dirname(__file__), 'webapp'), name='webapp_static')
    
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 10000))
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    print(f"✅ Веб-сервер на порту {port}")


async def main():
    global bot, BOT_USERNAME
    if not BOT_TOKEN: raise RuntimeError("❌ BOT_TOKEN не задан!")
    if not DATABASE_URL: raise RuntimeError("❌ DATABASE_URL не задан!")
    
    await init_db()
    await start_web_server()
    
    bot = Bot(token=BOT_TOKEN)
    me = await bot.get_me()
    BOT_USERNAME = me.username
    
    await bot.delete_webhook(drop_pending_updates=True)
    
    asyncio.create_task(check_referrals_loop())
    
    print("✅ Бот запущен.")
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())

if __name__ == "__main__":
    asyncio.run(main())
