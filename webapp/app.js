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
        const response = await fetch(`/api/${endpoint}?initData=${encodeURIComponent(tg.initData)}${params}`);
        if (!response.ok) throw new Error('Network error');
        return await response.json();
    } catch (error) {
        console.error("Ошибка API:", error);
        return null;
    }
}

async function postAPI(endpoint, body) {
    try {
        const response = await fetch(`/api/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, initData: tg.initData })
        });
        return { ok: response.ok, data: await response.json() };
    } catch (error) {
        return { ok: false, data: { error: "Ошибка сети" } };
    }
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    if (tabName === 'history') loadHistory();
    if (tabName === 'top') loadTop();
    if (tabName === 'bets') loadBets();
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
            : `<div style="color: #ff4a4a; font-size: 12px; text-align: center; width: 100%;">Нет прав на ссылку</div>`;

        div.innerHTML = `<div class="title">${icon} ${item.title || item.chat_id}</div>${buttonHtml}`;
        refList.appendChild(div);
    });
    
    const topSelect = document.getElementById('top-chat-select');
    const historySelect = document.getElementById('history-chat-select');
    const shopSelect = document.getElementById('shop-chat-select');
    const betsSelect = document.getElementById('bets-chat-select');
    
    topSelect.innerHTML = '<option value="">Выбери чат...</option>';
    historySelect.innerHTML = '<option value="">Моя общая история</option>';
    shopSelect.innerHTML = '<option value="">Выбери чат для списания...</option>';
    betsSelect.innerHTML = '<option value="">Выбери чат...</option>';
    
    allMyChats.forEach(chat => {
        const optTop = document.createElement('option');
        optTop.value = chat.chat_id;
        optTop.innerText = chat.title;
        topSelect.appendChild(optTop);
        
        const optHist = document.createElement('option');
        optHist.value = chat.chat_id;
        optHist.innerText = `Админ: ${chat.title}`;
        historySelect.appendChild(optHist);

        const optShop = document.createElement('option');
        optShop.value = chat.chat_id;
        optShop.innerText = `${chat.title}`;
        shopSelect.appendChild(optShop);

        const optBets = document.createElement('option');
        optBets.value = chat.chat_id;
        optBets.innerText = `${chat.title}`;
        betsSelect.appendChild(optBets);
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

        let medal = "";
        let colorClass = "";
        if (index === 0) { medal = "🥇 "; colorClass = "gold-text"; }
        else if (index === 1) { medal = "🥈 "; colorClass = "silver-text"; }
        else if (index === 2) { medal = "🥉 "; colorClass = "bronze-text"; }
        
        div.innerHTML = `
            <div class="top-left">
                <div class="rank">${medal}${index + 1}</div>
                <div class="title ${colorClass}">${item.first_name}</div>
            </div>
            <div class="amount">${item.balance}</div>
        `;
        topList.appendChild(div);
    });

    youPlate.style.display = 'flex';
    document.getElementById('you-rank').innerText = `#${data.user_place.rank}`;
    document.getElementById('you-name').innerText = data.user_place.name;
    document.getElementById('you-balance').innerText = `${data.user_place.balance} б.`;
    if (data.user_place.to_top5 > 0) {
        document.getElementById('you-hint').innerText = `До Топ-5: ${data.user_place.to_top5} б.`;
    } else {
        document.getElementById('you-hint').innerText = `Ты в Топ-5!`;
    }
}

async function loadShop() {
    const select = document.getElementById('shop-chat-select');
    if (!select.value) {
        // Просто визуальное предупреждение
    }
}

async function playCasino() {
    const chatId = document.getElementById('shop-chat-select').value;
    const betStr = document.getElementById('casino-bet').value;
    
    if (!chatId) return tg.showAlert("Выбери чат!");
    const bet = parseInt(betStr);
    if (!bet || bet <= 0) return tg.showAlert("Введи корректную ставку!");

    const btn = event.target;
    btn.innerText = "...";
    btn.disabled = true;

    const res = await postAPI('shop/casino', { chat_id: chatId, bet: bet });
    
    btn.innerText = "Крутить";
    btn.disabled = false;

    if (!res.ok) {
        tg.showAlert(res.data.error || "Ошибка");
        return;
    }

    if (res.data.result === 'win') {
        tg.showAlert(`🎉 Ты выиграл ${res.data.amount} баллов!`);
    } else {
        tg.showAlert(`💸 Ты проиграл ${res.data.amount} баллов.`);
    }
    
    loadBalance(); 
}

async function sendPost() {
    const chatId = document.getElementById('shop-chat-select').value;
    const text = document.getElementById('post-text').value.trim();
    const isAnon = document.getElementById('post-anon').checked;
    
    if (!chatId) return tg.showAlert("Выбери канал!");
    if (!text) return tg.showAlert("Напиши текст!");

    const btn = event.target;
    btn.innerText = "Отправка...";
    btn.disabled = true;

    const res = await postAPI('shop/post', { chat_id: chatId, text: text, is_anonymous: isAnon });
    
    btn.innerText = "Опубликовать";
    btn.disabled = false;

    if (!res.ok) {
        tg.showAlert(res.data.error || "Ошибка");
        return;
    }

    tg.showAlert("✅ Сообщение опубликовано!");
    document.getElementById('post-text').value = '';
    loadBalance(); 
}

// ================== СТАВКИ ==================
async function loadBets() {
    const select = document.getElementById('bets-chat-select');
    const chatId = select.value;
    const betsList = document.getElementById('bets-list');
    const adminPanel = document.getElementById('admin-bets-panel');
    
    if (!chatId) {
        betsList.innerHTML = '<div class="loading">Выбери чат из списка</div>';
        adminPanel.style.display = 'none';
        return;
    }

    betsList.innerHTML = '<div class="loading">Загрузка...</div>';
    const data = await fetchAPI('predictions', `&chat_id=${chatId}`);
    
    if (!data) {
        betsList.innerHTML = '<div class="loading">Ошибка</div>';
        return;
    }

    adminPanel.style.display = data.is_admin ? 'block' : 'none';
    betsList.innerHTML = data.predictions.length ? '' : '<div class="loading">Нет активных ставок</div>';

    data.predictions.forEach(pred => {
        const div = document.createElement('div');
        div.className = 'shop-card';
        div.style.marginBottom = '16px';
        div.style.border = pred.status === 'active' ? '1px solid var(--button-color)' : 'none';

        const endDate = new Date(pred.end_time);
        const now = new Date();
        const isEnded = now > endDate;
        const timeLeftStr = isEnded ? "Завершено" : `До конца: ${Math.ceil((endDate - now) / 60000)} мин.`;
        
        let statusBadge = "";
        if (pred.status === 'active') statusBadge = `<span style="color: var(--button-color);">${timeLeftStr}</span>`;
        else if (pred.status === 'canceled') statusBadge = `<span style="color: var(--hint-color);">Отменено (нет победителей)</span>`;
        else if (pred.status === 'resolved_yes') statusBadge = `<span style="color: #4cd964;">Итог: ДА</span>`;
        else if (pred.status === 'resolved_no') statusBadge = `<span style="color: #ff4a4a;">Итог: НЕТ</span>`;

        let userBetHtml = "";
        if (pred.user_bet) {
            userBetHtml = `<div style="font-size: 13px; color: var(--hint-color); margin-bottom: 8px;">Твоя ставка: ${pred.user_bet.amount} на ${pred.user_bet.choice === 'yes' ? 'ДА' : 'НЕТ'}</div>`;
        }

        let actionHtml = "";
        if (pred.status === 'active' && !isEnded) {
            if (data.is_admin) {
                actionHtml = `
                    <div style="display: flex; gap: 10px; margin-top: 10px;">
                        <button class="tab-btn" style="flex:1; background: #4cd964; color: white;" onclick="resolveBet(${pred.id}, 'yes')">Исход: ДА</button>
                        <button class="tab-btn" style="flex:1; background: #ff4a4a; color: white;" onclick="resolveBet(${pred.id}, 'no')">Исход: НЕТ</button>
                    </div>
                `;
            } else {
                if (!pred.user_bet) {
                    actionHtml = `
                        <div style="display: flex; gap: 10px; margin-top: 10px;">
                            <input type="number" id="bet-amt-${pred.id}" placeholder="Сумма" style="width: 80px; padding: 8px; border-radius: 8px; border: none; background: var(--bg-color); color: white;">
                            <button class="tab-btn" style="flex:1; background: #4cd964; color: white;" onclick="placeBet(${pred.id}, 'yes')">ДА</button>
                            <button class="tab-btn" style="flex:1; background: #ff4a4a; color: white;" onclick="placeBet(${pred.id}, 'no')">НЕТ</button>
                        </div>
                    `;
                } else {
                    actionHtml = `
                        <div style="display: flex; gap: 10px; margin-top: 10px;">
                            <input type="number" id="bet-amt-${pred.id}" placeholder="Докинуть" style="width: 80px; padding: 8px; border-radius: 8px; border: none; background: var(--bg-color); color: white;">
                            <button class="tab-btn" style="flex:1; background: var(--button-color); color: white;" onclick="placeBet(${pred.id}, '${pred.user_bet.choice}')">Докинуть на ${pred.user_bet.choice === 'yes' ? 'ДА' : 'НЕТ'}</button>
                        </div>
                    `;
                }
            }
        }

        div.innerHTML = `
            <h2 style="font-size: 15px; color: white; text-transform: none; margin-bottom: 8px;">${pred.question}</h2>
            <div style="font-size: 13px; margin-bottom: 8px;">${statusBadge}</div>
            <div style="font-size: 13px; color: var(--hint-color); margin-bottom: 8px;">Банк: ДА [${pred.pool_yes}] / НЕТ [${pred.pool_no}]</div>
            ${userBetHtml}
            ${actionHtml}
        `;
        betsList.appendChild(div);
    });
}

async function createBet() {
    const chatId = document.getElementById('bets-chat-select').value;
    const question = document.getElementById('bet-question').value.trim();
    const hours = document.getElementById('bet-hours').value;

    if (!chatId) return tg.showAlert("Выбери чат!");
    if (!question) return tg.showAlert("Напиши вопрос!");

    const btn = event.target;
    btn.innerText = "...";
    btn.disabled = true;

    const res = await postAPI('predictions/create', { chat_id: chatId, question: question, hours: hours });
    
    btn.innerText = "Создать";
    btn.disabled = false;

    if (!res.ok) return tg.showAlert(res.data.error);
    document.getElementById('bet-question').value = '';
    loadBets();
}

async function placeBet(predId, choice) {
    const chatId = document.getElementById('bets-chat-select').value;
    const amountStr = document.getElementById(`bet-amt-${predId}`).value;
    const amount = parseInt(amountStr);

    if (!amount || amount <= 0) return tg.showAlert("Введи сумму!");

    const btn = event.target;
    btn.innerText = "...";
    btn.disabled = true;

    const res = await postAPI('predictions/bet', { chat_id: chatId, pred_id: predId, choice: choice, amount: amount });
    
    btn.innerText = choice === 'yes' ? "ДА" : "НЕТ";
    btn.disabled = false;

    if (!res.ok) return tg.showAlert(res.data.error);
    loadBets();
    loadBalance();
}

async function resolveBet(predId, outcome) {
    const chatId = document.getElementById('bets-chat-select').value;
    const res = await postAPI('predictions/resolve', { chat_id: chatId, pred_id: predId, outcome: outcome });
    if (!res.ok) return tg.showAlert(res.data.error);
    loadBets();
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
            title = chatId ? `${item.sender_name} ➔ ${item.receiver_name}` : `Реакция от ${item.sender_name || 'Кто-то'}`;
        } else if (item.type === 'channel_earn') {
            title = `Забрал балл в канале`;
        } else if (item.type === 'fine') {
            title = `Штраф за накрутку`;
        } else if (item.type === 'referral') {
            title = `Бонус за друга`;
        } else if (item.type === 'casino_win') {
            title = `🎰 Выигрыш в казино`;
        } else if (item.type === 'casino_bet') {
            title = `🎰 Ставка в казино`;
        } else if (item.type === 'shop_post') {
            title = `📢 Пост в канале`;
        } else if (item.type === 'prediction_bet') {
            title = `📈 Ставка на событие`;
        } else if (item.type === 'prediction_win') {
            title = `🏆 Выигрыш по ставке`;
        } else {
            title = `${item.type}`;
        }

        if (!chatId && item.chat_title) title = `[${item.chat_title}] ` + title;

        const div = document.createElement('div');
        div.className = 'list-item';
        div.style.flexDirection = 'column';
        div.style.alignItems = 'flex-start';
        
        const msgTextHtml = item.message_text ? `<div class="subtitle">${item.message_text}</div>` : '';
        
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
