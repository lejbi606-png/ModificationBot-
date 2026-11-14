const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe.user;
if (user) {
    document.getElementById('greeting').innerText = `Привет, ${user.first_name}!`;
}

let allMyChats = []; 

async function fetchAPI(endpoint, params = "") { /* ... без изменений ... */ 
    try {
        if (!tg.initData) throw new Error('Нет initData');
        const response = await fetch(`/api/${endpoint}?initData=${encodeURIComponent(tg.initData)}${params}`);
        if (!response.ok) throw new Error('Network error');
        return await response.json();
    } catch (error) { console.error("Ошибка API:", error); return null; }
}

async function postAPI(endpoint, body) { /* ... без изменений ... */
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

function switchTab(tabName) { /* ... без изменений ... */
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    if (tabName === 'history') loadHistory();
    if (tabName === 'top') loadTop();
    if (tabName === 'bets') loadBets();
    if (tabName === 'pixel') initPixelBattle();
}

/* ... функции loadBalance, loadTop, loadShop, playCasino, sendPost, loadBets, createBet, placeBet, resolveBet, loadHistory ... */
/* Они остаются точно такими же, как в прошлом рабочем коде. Я не буду их дублировать, чтобы не раздувать ответ. */

// ================== ПИКСЕЛЬ БАТЛ (ПРАВИЛЬНЫЙ ЗУМ) ==================
const GRID_SIZE = 100;
const CANVAS_SIZE = 800; // Внутреннее разрешение холста

let canvas, ctx, viewport;
let isPixelInitialized = false;
let currentColor = "#FF3B30";
let cachedPixels = [];

// Состояние трансформации
let scale = 1;
let translateX = 0;
let translateY = 0;
let isDragging = false;
let lastTouchX = 0, lastTouchY = 0;
let initialDistance = 0;
let initialScale = 1;

const COLORS = [ /* ... те же 20 цветов ... */
    "#FFFFFF", "#000000", "#808080", "#C0C0C0",
    "#FF0000", "#FF4500", "#FF8C00", "#FFFF00",
    "#008000", "#00FF00", "#32CD32", "#00FA9A",
    "#00FFFF", "#0000FF", "#000080", "#8A2BE2",
    "#FF00FF", "#FF1493", "#A52A2A", "#D2691E"
];

async function initPixelBattle() {
    if (isPixelInitialized) { fetchAndDrawPixels(); return; }
    
    canvas = document.getElementById('pixel-canvas');
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    viewport = document.getElementById('pixel-viewport');
    
    // Палитра
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

    // Сброс трансформации при инициализации
    resetTransform();

    // --- ОБРАБОТКА КАСАНИЙ ---
    viewport.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd);
    viewport.addEventListener('touchcancel', handleTouchEnd);

    // Для десктопа (мышь)
    viewport.addEventListener('mousedown', handleMouseDown);
    viewport.addEventListener('mousemove', handleMouseMove);
    viewport.addEventListener('mouseup', handleMouseUp);
    viewport.addEventListener('wheel', handleWheel, { passive: false });

    isPixelInitialized = true;
    fetchAndDrawPixels();
    setInterval(fetchAndDrawPixels, 3000);
}

function resetTransform() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
}

function applyTransform() {
    canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

// --- TOUCH ОБРАБОТЧИКИ ---
function handleTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
        // Панорамирование
        isDragging = true;
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
        // Зум
        isDragging = false;
        initialDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        initialScale = scale;
    }
}

function handleTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && isDragging) {
        const dx = e.touches[0].clientX - lastTouchX;
        const dy = e.touches[0].clientY - lastTouchY;
        translateX += dx;
        translateY += dy;
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
        applyTransform();
    } else if (e.touches.length === 2) {
        const currentDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const newScale = Math.min(Math.max(initialScale * (currentDistance / initialDistance), 1), 5);
        scale = newScale;
        applyTransform();
    }
}

function handleTouchEnd(e) {
    if (e.touches.length === 0) {
        isDragging = false;
    }
}

// --- MOUSE ОБРАБОТЧИКИ (ДЛЯ ДЕСКТОПА) ---
function handleMouseDown(e) {
    isDragging = true;
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
    // Запоминаем, что это не клик, если сдвинем
    viewport.dataset.dragged = "false";
}

function handleMouseMove(e) {
    if (isDragging) {
        const dx = e.clientX - lastTouchX;
        const dy = e.clientY - lastTouchY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            viewport.dataset.dragged = "true";
        }
        translateX += dx;
        translateY += dy;
        lastTouchX = e.clientX;
        lastTouchY = e.clientY;
        applyTransform();
    }
}

function handleMouseUp(e) {
    if (isDragging && viewport.dataset.dragged === "false") {
        // Это был клик, а не перетаскивание — ставим пиксель
        placePixelFromEvent(e);
    }
    isDragging = false;
}

function handleWheel(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(scale * delta, 1), 5);

    // Зум относительно курсора
    translateX = mouseX - (mouseX - translateX) * (newScale / scale);
    translateY = mouseY - (mouseY - translateY) * (newScale / scale);
    scale = newScale;
    applyTransform();
}

// --- КЛИК / РИСОВАНИЕ ---
viewport.addEventListener('click', (e) => {
    // Если это был тач, touchend уже обработал, клик игнорируем
    if (e.pointerType === 'touch') return;
    // Для мыши: если было перетаскивание, не ставим пиксель
    if (viewport.dataset.dragged === "true") return;
    placePixelFromEvent(e);
});

async function placePixelFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    
    // Пересчитываем координаты с учетом scale и translate
    // canvas имеет размер 800x800, но на экране может быть меньше/больше
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID_SIZE);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID_SIZE);

    if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
        // Рисуем оптимистично
        drawPixelOnCanvas(x, y, currentColor);
        
        // Отправляем на сервер
        await postAPI('pixel/set', { x, y, color: currentColor });
    }
}

function drawPixelOnCanvas(x, y, color) {
    // 800 / 100 = 8 пикселей на ячейку
    const cellSize = CANVAS_SIZE / GRID_SIZE;
    ctx.fillStyle = color;
    ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
}

function redrawCanvas() {
    if (!isPixelInitialized) return;
    
    // Белый фон
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    
    // Пиксели (БЕЗ СЕТКИ)
    cachedPixels.forEach(p => {
        drawPixelOnCanvas(p.x, p.y, p.color);
    });
}

async function fetchAndDrawPixels() {
    if (!isPixelInitialized) return;
    const data = await fetchAPI('pixel/get');
    if (!data || !data.pixels) return;
    cachedPixels = data.pixels;
    redrawCanvas();
}

// Сброс
let resetConfirmPending = false;
let resetTimeout = null;

async function resetCanvas(event) {
    const btn = event.target;
    if (!resetConfirmPending) {
        resetConfirmPending = true;
        btn.innerText = "⚠️ Нажми ещё раз";
        btn.style.background = '#ff8c00';
        clearTimeout(resetTimeout);
        resetTimeout = setTimeout(() => {
            resetConfirmPending = false;
            btn.innerText = "🗑 Сбросить холст";
            btn.style.background = '#ff4a4a';
        }, 3000);
        return;
    }
    clearTimeout(resetTimeout);
    resetConfirmPending = false;
    btn.innerText = "Сброс...";
    btn.disabled = true;
    btn.style.background = '#ff4a4a';
    
    try {
        const response = await fetch('/api/pixel/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: tg.initData })
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); }
        catch { throw new Error(`Сервер вернул: ${text.substring(0, 100)}`); }
        if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
        
        tg.showAlert("✅ Холст очищен!");
        cachedPixels = [];
        redrawCanvas();
    } catch (e) {
        tg.showAlert("❌ " + e.message);
    } finally {
        btn.innerText = "🗑 Сбросить холст";
        btn.disabled = false;
        btn.style.background = '#ff4a4a';
    }
}

// ... остальные функции loadHistory и т.д. ...

loadBalance();
