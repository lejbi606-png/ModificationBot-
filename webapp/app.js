const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe.user;
if (user) {
    document.getElementById('greeting').innerText = `Привет, ${user.first_name}!`;
}

let allMyChats = []; 

async function fetchAPI(endpoint, params = "") {
    try {
        if (!tg.initData) throw new Error('Нет initData');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); 
        const response = await fetch(`/api/${endpoint}?initData=${encodeURIComponent(tg.initData)}${params}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Network error');
        return await response.json();
    } catch (error) {
        console.error("Ошибка API:", error);
        return null;
    }
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    if (tabName === 'history') loadHistory();
    if (tabName === 'top') loadTop();
}

async function loadBalance() {
    const data = await fetchAPI('balance');
    if (!data) return;

    document.getElementById('total-balance').innerText = data.total_balance;
    allMyChats = data.my_chats || [];

    const balancesList = document.getElementById('balances-list');
    balancesList.innerHTML = data.balances.length ? '' : '<div class="loading">У тебя пока нет баллов</div>';
    data.balances.forEach(item => {
        const icon = item.chat_type === 'channel' ? '📢' : '💬';
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `<div class="title">${icon} ${item.title || item.chat_id}</div><div class="amount">${item.balance}</div>`;
        balancesList.appendChild(div);
    });

    const refList = document.getElementById('ref-list');
    refList.innerHTML = allMyChats.length ? '' : '<div class="loading">Ты пока не в одном чате</div>';
    allMyChats.forEach(item => {
        const icon = item.chat_type === 'channel' ? '📢' : '💬';
        const div = document.createElement('div');
        div.className = 'list-item';
        div.style.flexDirection = 'column';
        div.style.alignItems = 'flex-start';
        div.style.gap = '8px';
        
        let buttonHtml = item.referral_link 
            ? `<button class="tab-btn" style="width:100%; background: var(--button-color); color: white;" onclick="copyLink('${item.referral_link}')">Скопировать ссылку</button>`
            : `<div style="color: #ff4a4a; font-size: 12px; text-align: center; width: 100%;">Нет прав на ссылку (дай боту админку)</div>`;

        div.innerHTML = `<div class="title">${icon} ${item.title || item.chat_id}</div>${buttonHtml}`;
        refList.appendChild(div);
    });
    
    const topSelect = document.getElementById('top-chat-select');
    const historySelect = document.getElementById('history-chat-select');
    
    topSelect.innerHTML = '<option value="">Выбери чат...</option>';
    historySelect.innerHTML = '<option value="">Моя общая история</option>';
    
    allMyChats.forEach(chat => {
        const optTop = document.createElement('option');
        optTop.value = chat.chat_id;
        optTop.innerText = chat.title;
        topSelect.appendChild(optTop);
        
        const optHist = document.createElement('option');
        optHist.value = chat.chat_id;
        optHist.innerText = `Админ: ${chat.title}`;
        historySelect.appendChild(optHist);
    });
}

function copyLink(link) {
    navigator.clipboard.writeText(link).then(() => {
        tg.showAlert("Ссылка скопирована!");
    }).catch(err => {
        tg.showAlert("Не удалось скопировать: " + link);
    });
}

async function loadTop() {
    const select = document.getElementById('top-chat-select');
    const chatId = select.value;
    const topList = document.getElementById('top-list');
    const youPlate = document.getElementById('you-plate');
    
    if (!chatId) {
        topList.innerHTML = '<div class="loading">Выбери чат из списка</div>';
        youPlate.style.display = 'none';
        return;
    }

    topList.innerHTML = '<div class="loading">Загрузка...</div>';
    const data = await fetchAPI('top', `&chat_id=${chatId}`);
    
    if (!data || !data.top) {
        topList.innerHTML = '<div class="loading">Ошибка загрузки</div>';
        youPlate.style.display = 'none';
        return;
    }

    topList.innerHTML = data.top.length ? '' : '<div class="loading">Никого нет</div>';
    data.top.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        const isMe = item.user_id === tg.initDataUnsafe.user.id;
        if (isMe) div.setAttribute('style', 'border: 1px solid var(--button-color);');
        div.innerHTML = `<div class="top-left"><div class="rank">${index + 1}</div><div class="title">${item.first_name}</div></div><div class="amount">${item.balance}</div>`;
        topList.appendChild(div);
    });

    youPlate.style.display = 'flex';
    document.getElementById('you-rank').innerText = `#${data.user_place.rank}`;
    document.getElementById('you-name').innerText = data.user_place.name;
    document.getElementById('you-balance').innerText = `${data.user_place.balance} б.`;
    if (data.user_place.to_top10 > 0) {
        document.getElementById('you-hint').innerText = `До Топ-10: ${data.user_place.to_top10} б.`;
    } else {
        document.getElementById('you-hint').innerText = `Ты в Топ-10!`;
    }
}

async function loadHistory() {
    const select = document.getElementById('history-chat-select');
    const historyList = document.getElementById('history-list');
    const chatId = select.value;
    const params = chatId ? `&chat_id=${chatId}` : '';
    
    historyList.innerHTML = '<div class="loading">Загрузка...</div>';
    const data = await fetchAPI('history', params);
    historyList.innerHTML = '';

    if (!data || !data.history || !data.history.length) {
        historyList.innerHTML = '<div class="loading">История пуста</div>';
        return;
    }

    data.history.forEach(item => {
        let title = '';
        let amountStr = item.amount > 0 ? `+${item.amount}` : `${item.amount}`;
        let amountClass = item.amount > 0 ? 'positive' : 'negative';
        
        if (item.type === 'reaction_earn') {
            if (chatId && item.sender_name && item.receiver_name) {
                title = `${item.sender_name} ➔ ${item.receiver_name}`;
            } else {
                title = `Реакция от ${item.sender_name || 'Кто-то'}`;
            }
        } else if (item.type === 'channel_earn') {
            title = `Забрал балл в канале`;
        } else if (item.type === 'fine') {
            title = `Штраф за накрутку`;
        } else if (item.type === 'referral') {
            title = `Бонус за друга`;
        } else {
            title = `${item.type}`;
        }

        if (!chatId && item.chat_title) {
            title = `[${item.chat_title}] ` + title;
        }

        const div = document.createElement('div');
        div.className = 'list-item';
        div.style.flexDirection = 'column';
        div.style.alignItems = 'flex-start';
        
        const msgTextHtml = `<div class="subtitle">${item.message_text}</div>`;
        
        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                <div class="title">${title}</div>
                <div class="amount ${amountClass}">${amountStr}</div>
            </div>
            ${msgTextHtml}
        `;
        historyList.appendChild(div);
    });
}

loadBalance();
