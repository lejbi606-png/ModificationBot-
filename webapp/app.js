const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe.user;
if (user) {
    document.getElementById('greeting').innerText = `Привет, ${user.first_name}!`;
}

async function fetchAPI(endpoint, params = "") {
    try {
        if (!tg.initData) throw new Error('Нет initData');
        const response = await fetch(`/api/${endpoint}?initData=${encodeURIComponent(tg.initData)}${params}`);
        if (!response.ok) throw new Error('Network error');
        return await response.json();
    } catch (error) {
        console.error("Ошибка API:", error);
        return null;
    }
}

// ================== ВКЛАДКИ ==================
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'history') {
        loadHistory();
    }
}

// ================== БАЛАНС И РЕФКИ ==================
async function loadBalance() {
    const data = await fetchAPI('balance');
    if (!data) return;

    document.getElementById('total-balance').innerText = data.total_balance;

    // Список балансов
    const balancesList = document.getElementById('balances-list');
    balancesList.innerHTML = data.balances.length ? '' : '<div class="loading">У тебя пока нет баллов</div>';
    data.balances.forEach(item => {
        const icon = item.chat_type === 'channel' ? '📢' : '💬';
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `<div class="title">${icon} ${item.title || item.chat_id}</div><div class="amount">${item.balance}</div>`;
        balancesList.appendChild(div);
    });

    // Реферальные ссылки
    const refList = document.getElementById('ref-list');
    refList.innerHTML = data.my_chats.length ? '' : '<div class="loading">Ты пока не в одном чате</div>';
    
    data.my_chats.forEach(item => {
        const icon = item.chat_type === 'channel' ? '📢' : '💬';
        const link = `https://t.me/${tg.initDataUnsafe.user.username || 'bot'}?start=ref_${item.chat_id}_${data.user_id}`;
        
        const div = document.createElement('div');
        div.className = 'list-item';
        div.style.flexDirection = 'column';
        div.style.alignItems = 'flex-start';
        div.style.gap = '8px';
        div.innerHTML = `
            <div class="title">${icon} ${item.title || item.chat_id}</div>
            <button class="tab-btn" style="width:100%; background: var(--button-color); color: white;" onclick="copyLink('${link}')">Скопировать ссылку</button>
        `;
        refList.appendChild(div);
    });
}

function copyLink(link) {
    navigator.clipboard.writeText(link).then(() => {
        tg.showAlert("Ссылка скопирована!");
    }).catch(err => {
        tg.showAlert("Не удалось скопировать: " + link);
    });
}

// ================== ТОП ==================
async function loadTop() {
    const data = await fetchAPI('top');
    if (!data) return;
    const topList = document.getElementById('top-list');
    topList.innerHTML = data.top.length ? '' : '<div class="loading">Пока никого</div>';
    data.top.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `<div class="top-left"><div class="rank">${index + 1}</div><div class="title">${item.first_name}</div></div><div class="amount">${item.balance}</div>`;
        topList.appendChild(div);
    });
}

// ================== ИСТОРИЯ ==================
let historyChatsLoaded = false;

async function loadHistory() {
    const select = document.getElementById('history-chat-select');
    const historyList = document.getElementById('history-list');
    
    // Подгружаем список чатов для селектора (только если админ)
    if (!historyChatsLoaded) {
        const data = await fetchAPI('balance'); // Берем из баланса my_chats
        if (data && data.my_chats) {
            data.my_chats.forEach(chat => {
                const opt = document.createElement('option');
                opt.value = chat.chat_id;
                opt.innerText = `Админ: ${chat.title}`;
                select.appendChild(opt);
            });
            historyChatsLoaded = true;
        }
    }

    const chatId = select.value;
    const params = chatId ? `&chat_id=${chatId}` : '';
    const data = await fetchAPI('history', params);

    historyList.innerHTML = '';
    if (!data || !data.history.length) {
        historyList.innerHTML = '<div class="loading">История пуста</div>';
        return;
    }

    data.history.forEach(item => {
        let title = '';
        let amountStr = '';
        let amountClass = item.amount > 0 ? 'positive' : 'negative';
        
        if (item.type === 'reaction_earn') {
            title = `Реакция от ${item.sender_name || 'Кто-то'}`;
            amountStr = `+${item.amount}`;
        } else if (item.type === 'channel_earn') {
            title = `Кнопка в канале`;
            amountStr = `+${item.amount}`;
        } else if (item.type === 'fine') {
            title = `Штраф (накрутка)`;
            amountStr = `${item.amount}`;
        } else if (item.type === 'referral') {
            title = `Бонус за друга`;
            amountStr = `+${item.amount}`;
        } else {
            title = item.type;
            amountStr = item.amount > 0 ? `+${item.amount}` : item.amount;
        }

        if (chatId && item.sender_name && item.receiver_name) {
             title = `${item.sender_name} ➔ ${item.receiver_name}`;
        }

        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `<div class="title">${title}</div><div class="amount ${amountClass}">${amountStr}</div>`;
        historyList.appendChild(div);
    });
}

// Запуск
loadBalance();
loadTop();
