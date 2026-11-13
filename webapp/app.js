const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe.user;
if (user) {
    document.getElementById('greeting').innerText = `Привет, ${user.first_name}!`;
}

async function fetchAPI(endpoint) {
    try {
        if (!tg.initData) {
            throw new Error('Нет initData');
        }
        const response = await fetch(`/api/${endpoint}?initData=${encodeURIComponent(tg.initData)}`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        return await response.json();
    } catch (error) {
        console.error("Ошибка API:", error);
        return null;
    }
}

async function loadBalance() {
    const balancesList = document.getElementById('balances-list');
    balancesList.innerHTML = ''; // очищаем загрузку
    
    const data = await fetchAPI('balance');
    
    if (!data) {
        balancesList.innerHTML = '<div class="loading" style="color: #ff4a4a;">Ошибка загрузки (Открой в Telegram)</div>';
        return;
    }

    document.getElementById('total-balance').innerText = data.total_balance;

    if (data.balances.length === 0) {
        balancesList.innerHTML = '<div class="loading">У тебя пока нет баллов</div>';
        return;
    }

    data.balances.forEach(item => {
        const chatTitle = item.title || `Чат ${item.chat_id}`;
        const icon = item.chat_type === 'channel' ? '📢' : '💬';
        
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <div class="title">${icon} ${chatTitle}</div>
            <div class="amount">${item.balance}</div>
        `;
        balancesList.appendChild(div);
    });
}

async function loadTop() {
    const topList = document.getElementById('top-list');
    topList.innerHTML = '';
    
    const data = await fetchAPI('top');
    
    if (!data) {
        topList.innerHTML = '<div class="loading" style="color: #ff4a4a;">Ошибка загрузки (Открой в Telegram)</div>';
        return;
    }

    if (data.top.length === 0) {
        topList.innerHTML = '<div class="loading">Пока никого нет</div>';
        return;
    }

    data.top.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `
            <div class="top-left">
                <div class="rank">${index + 1}</div>
                <div class="title">${item.first_name}</div>
            </div>
            <div class="amount">${item.balance}</div>
        `;
        topList.appendChild(div);
    });
}

loadBalance();
loadTop();
