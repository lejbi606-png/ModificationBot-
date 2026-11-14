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
    } catch (error) { console.error("Ошибка API:", error); return null; }
}

async function postAPI(endpoint, body) {
    try {
        const response = await fetch(`/api/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, initData: tg.initData })
        });
        const text = await response.text();
        try { return { ok: response.ok, data: JSON.parse(text) }; }
        catch { return { ok: false, data: { error: `Сервер ответил: ${text.substring(0, 100)}` } }; }
    } catch (error) { return { ok: false, data: { error: "Ошибка сети: " + error.message } }; }
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    if (tabName === 'history') loadHistory();
    if (tabName === 'top') loadTop();
    if (tabName === 'bets') loadBets();
    if (tabName === 'pixel') initPixelBattle();
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
        const optTop = document.createElement('option'); optTop.value = chat.chat_id; optTop.innerText = chat.title; topSelect.appendChild(optTop);
        const optHist = document.createElement('option'); optHist.value = chat.chat_id; optHist.innerText = `Админ: ${chat.title}`; historySelect.appendChild(optHist);
        const optShop = document.createElement('option'); optShop.value = chat.chat_id; optShop.innerText = `${chat.title}`; shopSelect.appendChild(optShop);
        const optBets = document.createElement('option'); optBets.value = chat.chat_id; optBets.innerText = `${chat.title}`; betsSelect.appendChild(optBets);
    });
}

function copyLink(link) {
    navigator.clipboard.writeText(link).then(() => tg.showAlert("Ссылка скопирована!")).catch(err => tg.showAlert("Не удалось скопировать: " + link));
}

async function loadTop() {
    const select = document.getElementById('top-chat-select'); const chatId = select.value;
    const topList = document.getElementById('top-list'); const youPlate = document.getElementById('you-plate');
    if (!chatId) { topList.innerHTML = '<div class="loading">Выбери чат из списка</div>'; youPlate.style.display = 'none'; return; }
    topList.innerHTML = '<div class="loading">Загрузка...</div>';
    const data = await fetchAPI('top', `&chat_id=${chatId}`);
    if (!data || !data.top) { topList.innerHTML = '<div class="loading">Ошибка загрузки</div>'; youPlate.style.display = 'none'; return; }
    topList.innerHTML = data.top.length ? '' : '<div class="loading">Никого нет</div>';
    data.top.forEach((item, index) => {
        const div = document.createElement('div'); div.className = 'list-item';
        const isMe = item.user_id === tg.initDataUnsafe.user.id;
        if (isMe) div.setAttribute('style', 'border: 1px solid var(--button-color);');
        let medal = ""; let colorClass = "";
        if (index === 0) { medal = "🥇 "; colorClass = "gold-text"; } else if (index === 1) { medal = "🥈 "; colorClass = "silver-text"; } else if (index === 2) { medal = "🥉 "; colorClass = "bronze-text"; }
        div.innerHTML = `<div class="top-left"><div class="rank">${medal}${index + 1}</div><div class="title ${colorClass}">${item.first_name}</div></div><div class="amount">${item.balance}</div>`;
        topList.appendChild(div);
    });
    youPlate.style.display = 'flex';
    document.getElementById('you-rank').innerText = `#${data.user_place.rank}`;
    document.getElementById('you-name').innerText = data.user_place.name;
    document.getElementById('you-balance').innerText = `${data.user_place.balance} б.`;
    document.getElementById('you-hint').innerText = data.user_place.to_top5 > 0 ? `До Топ-5: ${data.user_place.to_top5} б.` : `Ты в Топ-5!`;
}

async function loadShop() {}
async function playCasino() {
    const chatId = document.getElementById('shop-chat-select').value; const betStr = document.getElementById('casino-bet').value;
    if (!chatId) return tg.showAlert("Выбери чат!"); const bet = parseInt(betStr); if (!bet || bet <= 0) return tg.showAlert("Введи корректную ставку!");
    const btn = event.target; btn.innerText = "..."; btn.disabled = true;
    const res = await postAPI('shop/casino', { chat_id: chatId, bet: bet });
    btn.innerText = "Крутить"; btn.disabled = false;
    if (!res.ok) return tg.showAlert(res.data.error || "Ошибка");
    if (res.data.result === 'win') tg.showAlert(`🎉 Ты выиграл ${res.data.amount} баллов!`); else tg.showAlert(`💸 Ты проиграл ${res.data.amount} баллов.`);
    loadBalance(); 
}

async function sendPost() {
    const chatId = document.getElementById('shop-chat-select').value; const text = document.getElementById('post-text').value.trim(); const isAnon = document.getElementById('post-anon').checked;
    if (!chatId) return tg.showAlert("Выбери канал!"); if (!text) return tg.showAlert("Напиши текст!");
    const btn = event.target; btn.innerText = "Отправка..."; btn.disabled = true;
    const res = await postAPI('shop/post', { chat_id: chatId, text: text, is_anonymous: isAnon });
    btn.innerText = "Опубликовать"; btn.disabled = false;
    if (!res.ok) return tg.showAlert(res.data.error || "Ошибка");
    tg.showAlert("✅ Сообщение опубликовано!"); document.getElementById('post-text').value = ''; loadBalance(); 
}

async function loadBets() {
    const select = document.getElementById('bets-chat-select'); const chatId = select.value;
    const betsList = document.getElementById('bets-list'); const adminPanel = document.getElementById('admin-bets-panel');
    if (!chatId) { betsList.innerHTML = '<div class="loading">Выбери чат из списка</div>'; adminPanel.style.display = 'none'; return; }
    betsList.innerHTML = '<div class="loading">Загрузка...</div>';
    const data = await fetchAPI('predictions', `&chat_id=${chatId}`);
    if (!data) { betsList.innerHTML = '<div class="loading">Ошибка</div>'; return; }
    adminPanel.style.display = data.is_admin ? 'block' : 'none';
    betsList.innerHTML = data.predictions.length ? '' : '<div class="loading">Нет активных ставок</div>';
    data.predictions.forEach(pred => {
        const div = document.createElement('div'); div.className = 'shop-card'; div.style.marginBottom = '16px'; div.style.border = pred.status === 'active' ? '1px solid var(--button-color)' : 'none';
        const endDate = new Date(pred.end_time); const now = new Date(); const isEnded = now > endDate; const timeLeftStr = isEnded ? "Завершено" : `До конца: ${Math.ceil((endDate - now) / 60000)} мин.`;
        let statusBadge = "";
        if (pred.status === 'active') statusBadge = `<span style="color: var(--button-color);">${timeLeftStr}</span>`;
        else if (pred.status === 'canceled') statusBadge = `<span style="color: var(--hint-color);">Отменено</span>`;
        else if (pred.status === 'resolved_yes') statusBadge = `<span style="color: #4cd964;">Итог: ДА</span>`;
        else if (pred.status === 'resolved_no') statusBadge = `<span style="color: #ff4a4a;">Итог: НЕТ</span>`;
        let userBetHtml = ""; if (pred.user_bet) userBetHtml = `<div style="font-size: 13px; color: var(--hint-color); margin-bottom: 8px;">Твоя ставка: ${pred.user_bet.amount} на ${pred.user_bet.choice === 'yes' ? 'ДА' : 'НЕТ'}</div>`;
        let actionHtml = "";
        if (pred.status === 'active' && !isEnded) {
            if (data.is_admin) {
                actionHtml = `<div style="display: flex; gap: 10px; margin-top: 10px;"><button class="tab-btn" style="flex:1; background: #4cd964; color: white;" onclick="resolveBet(${pred.id}, 'yes')">Исход: ДА</button><button class="tab-btn" style="flex:1; background: #ff4a4a; color: white;" onclick="resolveBet(${pred.id}, 'no')">Исход: НЕТ</button></div>`;
            } else {
                if (!pred.user_bet) {
                    actionHtml = `<div style="display: flex; gap: 10px; margin-top: 10px;"><input type="number" id="bet-amt-${pred.id}" placeholder="Сумма" style="width: 80px; padding: 8px; border-radius: 8px; border: none; background: var(--bg-color); color: white;"><button class="tab-btn" style="flex:1; background: #4cd964; color: white;" onclick="placeBet(${pred.id}, 'yes')">ДА</button><button class="tab-btn" style="flex:1; background: #ff4a4a; color: white;" onclick="placeBet(${pred.id}, 'no')">НЕТ</button></div>`;
                } else {
                    actionHtml = `<div style="display: flex; gap: 10px; margin-top: 10px;"><input type="number" id="bet-amt-${pred.id}" placeholder="Докинуть" style="width: 80px; padding: 8px; border-radius: 8px; border: none; background: var(--bg-color); color: white;"><button class="tab-btn" style="flex:1; background: var(--button-color); color: white;" onclick="placeBet(${pred.id}, '${pred.user_bet.choice}')">Докинуть на ${pred.user_bet.choice === 'yes' ? 'ДА' : 'НЕТ'}</button></div>`;
                }
            }
        }
        div.innerHTML = `<h2 style="font-size: 15px; color: white; text-transform: none; margin-bottom: 8px;">${pred.question}</h2><div style="font-size: 13px; margin-bottom: 8px;">${statusBadge}</div><div style="font-size: 13px; color: var(--hint-color); margin-bottom: 8px;">Банк: ДА [${pred.pool_yes}] / НЕТ [${pred.pool_no}]</div>${userBetHtml}${actionHtml}`;
        betsList.appendChild(div);
    });
}

async function createBet() {
    const chatId = document.getElementById('bets-chat-select').value; const question = document.getElementById('bet-question').value.trim(); const hours = document.getElementById('bet-hours').value;
    if (!chatId) return tg.showAlert("Выбери чат!"); if (!question) return tg.showAlert("Напиши вопрос!");
    const btn = event.target; btn.innerText = "..."; btn.disabled = true;
    const res = await postAPI('predictions/create', { chat_id: chatId, question: question, hours: hours });
    btn.innerText = "Создать"; btn.disabled = false;
    if (!res.ok) return tg.showAlert(res.data.error);
    document.getElementById('bet-question').value = ''; loadBets();
}

async function placeBet(predId, choice) {
    const chatId = document.getElementById('bets-chat-select').value; const amountStr = document.getElementById(`bet-amt-${predId}`).value; const amount = parseInt(amountStr);
    if (!amount || amount <= 0) return tg.showAlert("Введи сумму!");
    const btn = event.target; btn.innerText = "..."; btn.disabled = true;
    const res = await postAPI('predictions/bet', { chat_id: chatId, pred_id: predId, choice: choice, amount: amount });
    btn.innerText = choice === 'yes' ? "ДА" : "НЕТ"; btn.disabled = false;
    if (!res.ok) return tg.showAlert(res.data.error);
    loadBets(); loadBalance();
}

async function resolveBet(predId, outcome) {
    const chatId = document.getElementById('bets-chat-select').value;
    const res = await postAPI('predictions/resolve', { chat_id: chatId, pred_id: predId, outcome: outcome });
    if (!res.ok) return tg.showAlert(res.data.error);
    loadBets();
}

// ================== ПИКСЕЛЬ БАТЛ (500x500 + ШТАМП) ==================
const CANVAS_SIZE = 2000;
const GRID_SIZE = 500;
const CELL_SIZE = CANVAS_SIZE / GRID_SIZE; // 4px

let canvas, ctx, viewport;
let isPixelInitialized = false;
let currentColor = "#FF3B30";
let cachedPixels = [];

// Трансформации холста
let scale = 1, translateX = 0, translateY = 0;
let isDragging = false, isZooming = false;
let lastTouchX = 0, lastTouchY = 0;
let initialDistance = 0, initialScale = 1;

// Штамп
let stampPixels = [];
let stampVisible = false;
let stampX = 250; // Центр
let stampY = 250;
let stampScale = 1;
let initialStampScale = 1;
let stampImgWidth = 0, stampImgHeight = 0;

const COLORS = [
    "#FFFFFF", "#000000", "#808080", "#C0C0C0", "#FF0000", "#8B0000", "#FF4500", "#FF8C00", 
    "#FFFF00", "#808000", "#008000", "#00FF00", "#32CD32", "#00FA9A", "#00FFFF", "#008080",
    "#0000FF", "#000080", "#8A2BE2", "#4B0082", "#FF00FF", "#800080", "#FF1493", "#FFC0CB",
    "#A52A2A", "#D2691E", "#F5DEB3", "#E6E6FA", "#ADD8E6", "#90EE90", "#F08080", "#9370DB",
    "#20B2AA", "#FFD700", "#B22222", "#191970", "#7FFF00", "#DDA0DD", "#98FB98", "#00CED1"
];

async function initPixelBattle() {
    if (isPixelInitialized) { fetchAndDrawPixels(); return; }
    canvas = document.getElementById('pixel-canvas');
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    viewport = document.getElementById('pixel-viewport');
    
    const palette = document.getElementById('color-palette');
    palette.innerHTML = '';
    COLORS.forEach(color => {
        const div = document.createElement('div');
        div.className = 'color-swatch';
        div.style.backgroundColor = color;
        if (color === currentColor) div.classList.add('selected');
        div.onclick = () => {
            document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
            currentColor = color;
        };
        palette.appendChild(div);
    });

    resetTransform();

    viewport.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd);
    viewport.addEventListener('touchcancel', handleTouchEnd);
    viewport.addEventListener('mousedown', handleMouseDown);
    viewport.addEventListener('mousemove', handleMouseMove);
    viewport.addEventListener('mouseup', handleMouseUp);
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('click', handleCanvasClick);

    isPixelInitialized = true;
    fetchAndDrawPixels();
    setInterval(fetchAndDrawPixels, 3000);
}

function resetTransform() {
    scale = 1; translateX = 0; translateY = 0; applyTransform();
}

function applyTransform() {
    canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

// --- УПРАВЛЕНИЕ ЖЕСТАМИ (ШТАМП vs ХОЛСТ) ---
function handleTouchStart(e) {
    if (e.touches.length === 1) {
        isDragging = true; isZooming = false;
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        viewport.dataset.dragged = "false";
    } else if (e.touches.length === 2) {
        isDragging = false; isZooming = true;
        initialDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (stampVisible) initialStampScale = stampScale;
        else initialScale = scale;
    }
}

function handleTouchMove(e) {
    if (e.touches.length === 1 && isDragging) {
        const dx = e.touches[0].clientX - lastTouchX;
        const dy = e.touches[0].clientY - lastTouchY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) viewport.dataset.dragged = "true";
        
        if (stampVisible) {
            // Двигаем ШТАМП
            stampX += dx / (CELL_SIZE * scale);
            stampY += dy / (CELL_SIZE * scale);
            drawCanvas();
        } else {
            // Двигаем ХОЛСТ
            translateX += dx; translateY += dy; applyTransform();
        }
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
        const currentDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (stampVisible) {
            // Зумим ШТАМП
            stampScale = Math.max(0.1, Math.min(5, initialStampScale * (currentDistance / initialDistance)));
            drawCanvas();
        } else {
            // Зумим ХОЛСТ
            scale = Math.min(Math.max(initialScale * (currentDistance / initialDistance), 1), 15);
            applyTransform();
        }
    }
}

function handleTouchEnd(e) {
    if (e.touches.length === 0) {
        if (isDragging && viewport.dataset.dragged === "false" && !isZooming && !stampVisible) {
            placePixelFromEvent(e.changedTouches[0]);
        }
        isDragging = false; isZooming = false;
    }
}

function handleMouseDown(e) {
    isDragging = true; isZooming = false;
    lastTouchX = e.clientX; lastTouchY = e.clientY;
    viewport.dataset.dragged = "false";
}
function handleMouseMove(e) {
    if (isDragging) {
        const dx = e.clientX - lastTouchX; const dy = e.clientY - lastTouchY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) viewport.dataset.dragged = "true";
        if (stampVisible) {
            stampX += dx / (CELL_SIZE * scale); stampY += dy / (CELL_SIZE * scale);
            drawCanvas();
        } else {
            translateX += dx; translateY += dy; applyTransform();
        }
        lastTouchX = e.clientX; lastTouchY = e.clientY;
    }
}
function handleMouseUp(e) {
    if (isDragging && viewport.dataset.dragged === "false" && !isZooming && !stampVisible) placePixelFromEvent(e);
    isDragging = false; isZooming = false;
}
function handleWheel(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1; 
    
    if (stampVisible) {
        stampScale = Math.max(0.1, Math.min(5, stampScale * delta));
        drawCanvas();
    } else {
        const newScale = Math.min(Math.max(scale * delta, 1), 15);
        translateX = mouseX - (mouseX - translateX) * (newScale / scale);
        translateY = mouseY - (mouseY - translateY) * (newScale / scale);
        scale = newScale; applyTransform();
    }
}

function handleCanvasClick(e) {
    if (viewport.dataset.dragged === "true" || stampVisible) return; 
    placePixelFromEvent(e);
}

async function placePixelFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    const x = Math.floor(canvasX / CELL_SIZE);
    const y = Math.floor(canvasY / CELL_SIZE);

    if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
        drawPixelOnCanvas(x, y, currentColor);
        await postAPI('pixel/set', { x, y, color: currentColor });
    }
}

function drawPixelOnCanvas(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
}

function drawCanvas() {
    if (!isPixelInitialized) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    
    // Рисуем холст
    cachedPixels.forEach(p => drawPixelOnCanvas(p.x, p.y, p.color));

    // Рисуем штамп (полупрозрачный поверх)
    if (stampVisible && stampPixels.length > 0) {
        ctx.globalAlpha = 0.6; // Прозрачность штампа
        stampPixels.forEach(p => {
            const px = Math.floor(stampX + p.x * stampScale);
            const py = Math.floor(stampY + p.y * stampScale);
            if (px >= 0 && px < GRID_SIZE && py >= 0 && py < GRID_SIZE) {
                // Рисуем штамп поверх (визуально)
                ctx.fillStyle = p.color;
                ctx.fillRect(px * CELL_SIZE, py * CELL_SIZE, CELL_SIZE * stampScale, CELL_SIZE * stampScale);
            }
        });
        ctx.globalAlpha = 1.0;
    }
}

async function fetchAndDrawPixels() {
    if (!isPixelInitialized) return;
    const data = await fetchAPI('pixel/get');
    if (!data || !data.pixels) return;
    cachedPixels = data.pixels;
    drawCanvas();
}

// --- СБРОС ---
let resetConfirmPending = false; let resetTimeout = null;
async function resetCanvas(event) {
    const btn = event.target;
    if (!resetConfirmPending) {
        resetConfirmPending = true; btn.innerText = "⚠️ Нажми ещё раз"; btn.style.background = '#ff8c00';
        clearTimeout(resetTimeout);
        resetTimeout = setTimeout(() => { resetConfirmPending = false; btn.innerText = "🗑 Сбросить"; btn.style.background = '#ff4a4a'; }, 3000);
        return;
    }
    clearTimeout(resetTimeout); resetConfirmPending = false; btn.innerText = "Сброс..."; btn.disabled = true; btn.style.background = '#ff4a4a';
    try {
        const response = await fetch('/api/pixel/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Ошибка');
        tg.showAlert("✅ Холст очищен!"); cachedPixels = []; drawCanvas();
    } catch (e) { tg.showAlert("❌ " + e.message); }
    finally { btn.innerText = "🗑 Сбросить"; btn.disabled = false; btn.style.background = '#ff4a4a'; }
}

// --- ЛОГИКА ШТАМПА ---
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            processImageToStamp(img);
        }
        img.src = e.target.result;
    }
    reader.readAsDataURL(file);
    event.target.value = '';
}

function processImageToStamp(img) {
    // Ограничиваем исходный размер картинки до 50 пикселей в ширину/высоту
    const maxSize = 50;
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    
    let w = img.width, h = img.height;
    if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; } 
    else { w = Math.round(w * maxSize / h); h = maxSize; }
    
    tempCanvas.width = w; tempCanvas.height = h;
    tempCtx.drawImage(img, 0, 0, w, h);
    
    const imgData = tempCtx.getImageData(0, 0, w, h).data;
    const pixels = [];
    
    // Квантуем цвета под нашу палитру
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = imgData[i], g = imgData[i+1], b = imgData[i+2], a = imgData[i+3];
            if (a < 50) continue; // Прозрачные пиксели пропускаем
            const nearestColor = getNearestColor(r, g, b);
            pixels.push({ x: x, y: y, color: nearestColor });
        }
    }
    
    stampPixels = pixels;
    stampImgWidth = w;
    stampImgHeight = h;
    stampScale = 1;
    stampX = (GRID_SIZE - w) / 2; // Центр холста
    stampY = (GRID_SIZE - h) / 2;
    stampVisible = true;
    
    document.getElementById('stamp-controls').style.display = 'block';
    drawCanvas();
}

function getNearestColor(r, g, b) {
    let minDist = Infinity;
    let bestColor = "#000000";
    for (const color of COLORS) {
        const cr = parseInt(color.slice(1,3), 16);
        const cg = parseInt(color.slice(3,5), 16);
        const cb = parseInt(color.slice(5,7), 16);
        const dist = Math.pow(r - cr, 2) + Math.pow(g - cg, 2) + Math.pow(b - cb, 2);
        if (dist < minDist) { minDist = dist; bestColor = color; }
    }
    return bestColor;
}

function applyStamp() {
    if (!stampVisible || stampPixels.length === 0) return;
    
    const pixelsToSave = [];
    // Пересчитываем пиксели штампа в глобальные координаты холста
    stampPixels.forEach(p => {
        // Из-за масштаба штампа, один пиксель картинки может занимать несколько клеток.
        // Нам нужно "растянуть" пиксели. 
        for (let sy = 0; sy < stampScale; sy++) {
            for (let sx = 0; sx < stampScale; sx++) {
                const px = Math.floor(stampX + p.x * stampScale + sx);
                const py = Math.floor(stampY + p.y * stampScale + sy);
                if (px >= 0 && px < GRID_SIZE && py >= 0 && py < GRID_SIZE) {
                    pixelsToSave.push({ x: px, y: py, color: p.color });
                }
            }
        }
    });

    if (pixelsToSave.length === 0) return tg.showAlert("Штамп за пределами холста");

    tg.showPopup({
        title: 'Поставить штамп?',
        message: `Будет закрашено ${pixelsToSave.length} пикселей.`,
        buttons: [{id: 'ok', type: 'default', text: 'Поставить'}, {id: 'cancel', type: 'cancel'}]
    }, async (buttonId) => {
        if (buttonId !== 'ok') return;
        
        const res = await postAPI('pixel/set_batch', { pixels: pixelsToSave });
        if (res.ok) {
            tg.showAlert("✅ Штамп поставлен!");
            cancelStamp();
            fetchAndDrawPixels(); // Обновляем чистый холст
        } else {
            tg.showAlert("Ошибка: " + (res.data.error || "Неизвестно"));
        }
    });
}

function cancelStamp() {
    stampVisible = false;
    stampPixels = [];
    document.getElementById('stamp-controls').style.display = 'none';
    document.getElementById('stamp-input').value = '';
    drawCanvas();
}

// --- ИСТОРИЯ ---
async function loadHistory() {
    const select = document.getElementById('history-chat-select'); const chatId = select.value; const params = chatId ? `&chat_id=${chatId}` : '';
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '<div class="loading">Загрузка...</div>';
    const data = await fetchAPI('history', params); historyList.innerHTML = '';
    if (!data || !data.history || !data.history.length) { historyList.innerHTML = '<div class="loading">История пуста</div>'; return; }
    data.history.forEach(item => {
        let title = ''; let amountStr = item.amount > 0 ? `+${item.amount}` : `${item.amount}`; let amountClass = item.amount > 0 ? 'positive' : 'negative';
        if (item.type === 'reaction_earn') title = chatId ? `${item.sender_name} ➔ ${item.receiver_name}` : `Реакция от ${item.sender_name || 'Кто-то'}`;
        else if (item.type === 'channel_earn') title = `Забрал балл в канале`;
        else if (item.type === 'fine') title = `Штраф за накрутку`;
        else if (item.type === 'referral') title = `Бонус за друга`;
        else if (item.type === 'casino_win') title = `🎰 Выигрыш в казино`;
        else if (item.type === 'casino_bet') title = `🎰 Ставка в казино`;
        else if (item.type === 'shop_post') title = `📢 Пост в канале`;
        else if (item.type === 'prediction_bet') title = `📈 Ставка на событие`;
        else if (item.type === 'prediction_win') title = `🏆 Выигрыш по ставке`;
        else title = `${item.type}`;
        if (!chatId && item.chat_title) title = `[${item.chat_title}] ` + title;
        const div = document.createElement('div'); div.className = 'list-item'; div.style.flexDirection = 'column'; div.style.alignItems = 'flex-start';
        const msgTextHtml = item.message_text ? `<div class="subtitle">${item.message_text}</div>` : '';
        div.innerHTML = `<div style="display: flex; justify-content: space-between; width: 100%; align-items: center;"><div class="title">${title}</div><div class="amount ${amountClass}">${amountStr}</div></div>${msgTextHtml}`;
        historyList.appendChild(div);
    });
}

loadBalance();
