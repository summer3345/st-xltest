/**
 * 骰子扰动 (Dice Query Perturbation) v1.0.0
 *
 * 原理：拦截向量检索请求（/api/vector/query 与 /api/vector/query-multi），
 * 在 searchText 前注入随机抽取的意象短句（重复 N 次以保证剂量），
 * 使查询向量发生语义偏移，从而打散 top-k 命中结果。
 *
 * 只扰动查询（query），绝不触碰入库（insert），不污染语料本身。
 * 通过 collectionId 过滤，保护需要精准检索的库（如 Data Bank）。
 */

const MODULE = 'dice_perturbation';
const LOG_TAG = '[骰子扰动]';

const defaultSettings = {
    enabled: true,        // 总开关
    repeat: 3,            // 剂量：roll 结果重复拼接次数（1-10）
    categoryFirst: true,  // 先随机选类目、再随机选条目（保证扰动方向铺满语义空间）
    logRoll: true,        // 在 F12 控制台打印每次 roll 结果
    excludePrefixes: 'file_',  // 排除前缀（逗号分隔）：collectionId 以此开头的不扰动。file_ = Data Bank 文件库
    whitelist: '',        // 白名单（逗号分隔）：非空时只扰动包含这些片段的 collectionId，排除前缀失效
};

let diceLibrary = null;
let settings = { ...defaultSettings };

// ---------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------

function getCtx() {
    try {
        return SillyTavern.getContext();
    } catch (e) {
        return null;
    }
}

function loadSettings() {
    const ctx = getCtx();
    if (!ctx || !ctx.extensionSettings) return;
    if (!ctx.extensionSettings[MODULE]) {
        ctx.extensionSettings[MODULE] = {};
    }
    settings = Object.assign({}, defaultSettings, ctx.extensionSettings[MODULE]);
    ctx.extensionSettings[MODULE] = settings;
}

function saveSettings() {
    const ctx = getCtx();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

async function loadDiceLibrary() {
    const url = new URL('./dice.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`dice.json 读取失败: HTTP ${res.status}`);
    diceLibrary = await res.json();
    const cats = Object.keys(diceLibrary);
    const total = cats.reduce((n, k) => n + (Array.isArray(diceLibrary[k]) ? diceLibrary[k].length : 0), 0);
    console.log(`${LOG_TAG} 骰子库已加载：${cats.length} 个类目，共 ${total} 条`);
}

// ---------------------------------------------------------------
// 骰子核心
// ---------------------------------------------------------------

function rollDice() {
    if (!diceLibrary) return null;
    const cats = Object.keys(diceLibrary).filter(
        k => Array.isArray(diceLibrary[k]) && diceLibrary[k].length > 0,
    );
    if (cats.length === 0) return null;

    if (settings.categoryFirst) {
        // 两段式：先选类目再选条目 —— 各类目出场概率均等，扰动方向铺满空间
        const cat = cats[Math.floor(Math.random() * cats.length)];
        const items = diceLibrary[cat];
        return { category: cat, text: items[Math.floor(Math.random() * items.length)] };
    }

    // 扁平式：所有条目等概率（条目多的类目会更常出现）
    const all = [];
    for (const k of cats) {
        for (const item of diceLibrary[k]) all.push({ category: k, text: item });
    }
    return all[Math.floor(Math.random() * all.length)];
}

// ---------------------------------------------------------------
// collectionId 过滤
// ---------------------------------------------------------------

function splitList(str) {
    return String(str || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function collectIds(body) {
    const ids = [];
    if (typeof body.collectionId === 'string') ids.push(body.collectionId);
    if (Array.isArray(body.collectionIds)) {
        for (const id of body.collectionIds) {
            if (typeof id === 'string') ids.push(id);
        }
    }
    return ids;
}

function idAllowed(id) {
    const wl = splitList(settings.whitelist);
    if (wl.length > 0) {
        // 白名单模式：只有包含白名单片段的 collection 才被扰动
        return wl.some(w => id.includes(w));
    }
    // 默认模式：排除指定前缀（如 Data Bank 的 file_），其余全部扰动
    const ex = splitList(settings.excludePrefixes);
    return !ex.some(p => id.startsWith(p));
}

function shouldPerturb(body) {
    const ids = collectIds(body);
    if (ids.length === 0) {
        // 拿不到 collectionId 的查询：保守起见仍然扰动，但在日志里标注
        return { perturb: true, ids: ['(无 collectionId)'] };
    }
    const allowed = ids.filter(idAllowed);
    // 注意：query-multi 一次请求可能携带多个 collection，searchText 是共享的，
    // 扰动是整体生效的。只要有一个 collection 在允许范围内就扰动，并完整记录日志。
    return { perturb: allowed.length > 0, ids };
}

// ---------------------------------------------------------------
// fetch 拦截
// ---------------------------------------------------------------

function isVectorQueryUrl(url) {
    // 覆盖 /api/vector/query 与 /api/vector/query-multi；
    // 显式排除 insert/purge 等其它向量端点（其实它们也不含 'query'，双保险）
    return url.includes('/api/vector/query') && !url.includes('/insert');
}

function installFetchHook() {
    if (window.__dicePerturbationInstalled) {
        console.warn(`${LOG_TAG} fetch 钩子已存在，跳过重复安装`);
        return;
    }
    const origFetch = window.fetch;

    window.fetch = async function (input, init) {
        try {
            if (settings.enabled && diceLibrary) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';

                if (isVectorQueryUrl(url) && init && typeof init.body === 'string') {
                    const body = JSON.parse(init.body);

                    if (typeof body.searchText === 'string' && body.searchText.length > 0) {
                        const { perturb, ids } = shouldPerturb(body);

                        if (perturb) {
                            const roll = rollDice();
                            if (roll) {
                                const repeat = Math.max(1, Math.min(10, Number(settings.repeat) || 1));
                                const injection = (roll.text + '\n').repeat(repeat);
                                body.searchText = injection + body.searchText;
                                init = Object.assign({}, init, { body: JSON.stringify(body) });

                                if (settings.logRoll) {
                                    console.log(
                                        `${LOG_TAG} 🎲 [${roll.category}] ${roll.text} ×${repeat} → collection: ${ids.join(', ')}`,
                                    );
                                }
                            }
                        } else if (settings.logRoll) {
                            console.log(`${LOG_TAG} ⛔ 已放行（过滤规则）→ collection: ${ids.join(', ')}`);
                        }
                    }
                }
            }
        } catch (e) {
            // 任何拦截环节出错都放行原请求，绝不让扰动失败拖垮检索本身
            console.warn(`${LOG_TAG} 拦截过程出错，已放行原请求`, e);
        }
        return origFetch.call(this, input, init);
    };

    window.__dicePerturbationInstalled = true;
    console.log(`${LOG_TAG} fetch 钩子已安装`);
}

// ---------------------------------------------------------------
// 设置面板 UI（套用酒馆原生 drawer 样式）
// ---------------------------------------------------------------

function settingsHtml() {
    return `
    <div class="dice-perturbation-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎲 骰子扰动</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="dice_pert_enabled">
                    <input id="dice_pert_enabled" type="checkbox" />
                    <span>启用扰动</span>
                </label>
                <label class="checkbox_label" for="dice_pert_log">
                    <input id="dice_pert_log" type="checkbox" />
                    <span>控制台打印 roll 结果（F12 查看）</span>
                </label>
                <label class="checkbox_label" for="dice_pert_catfirst">
                    <input id="dice_pert_catfirst" type="checkbox" />
                    <span>先抽类目再抽条目</span>
                </label>
                <div>
                    <label for="dice_pert_repeat">剂量（roll 结果重复次数）：<span id="dice_pert_repeat_value"></span></label>
                    <input id="dice_pert_repeat" type="range" min="1" max="10" step="1" />
                </div>
                <div>
                    <label for="dice_pert_exclude">排除前缀（逗号分隔，默认 file_ 保护 Data Bank）</label>
                    <input id="dice_pert_exclude" type="text" class="text_pole" placeholder="file_" />
                </div>
                <div>
                    <label for="dice_pert_whitelist">白名单（逗号分隔；非空时只扰动匹配的 collection）</label>
                    <input id="dice_pert_whitelist" type="text" class="text_pole" placeholder="留空 = 排除模式" />
                </div>
                <div class="flex-container" style="margin-top: 8px;">
                    <input id="dice_pert_test" class="menu_button" type="button" value="试掷一次 🎲" />
                    <input id="dice_pert_reload" class="menu_button" type="button" value="重载骰子库" />
                </div>
            </div>
        </div>
    </div>`;
}

function bindSettingsUI() {
    $('#dice_pert_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () { settings.enabled = this.checked; saveSettings(); });

    $('#dice_pert_log')
        .prop('checked', settings.logRoll)
        .on('change', function () { settings.logRoll = this.checked; saveSettings(); });

    $('#dice_pert_catfirst')
        .prop('checked', settings.categoryFirst)
        .on('change', function () { settings.categoryFirst = this.checked; saveSettings(); });

    $('#dice_pert_repeat')
        .val(settings.repeat)
        .on('input', function () {
            settings.repeat = Number(this.value);
            $('#dice_pert_repeat_value').text(this.value);
            saveSettings();
        });
    $('#dice_pert_repeat_value').text(settings.repeat);

    $('#dice_pert_exclude')
        .val(settings.excludePrefixes)
        .on('input', function () { settings.excludePrefixes = this.value; saveSettings(); });

    $('#dice_pert_whitelist')
        .val(settings.whitelist)
        .on('input', function () { settings.whitelist = this.value; saveSettings(); });

    $('#dice_pert_test').on('click', function () {
        const roll = rollDice();
        if (roll) {
            const msg = `[${roll.category}] ${roll.text}`;
            console.log(`${LOG_TAG} 试掷 🎲 ${msg}`);
            if (typeof toastr !== 'undefined') toastr.info(msg, '🎲 骰子扰动');
        } else {
            if (typeof toastr !== 'undefined') toastr.warning('骰子库为空或未加载', '🎲 骰子扰动');
        }
    });

    $('#dice_pert_reload').on('click', async function () {
        try {
            await loadDiceLibrary();
            if (typeof toastr !== 'undefined') toastr.success('骰子库已重载', '🎲 骰子扰动');
        } catch (e) {
            console.error(`${LOG_TAG}`, e);
            if (typeof toastr !== 'undefined') toastr.error(String(e.message || e), '🎲 骰子扰动');
        }
    });
}

function addSettingsUI() {
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    $(target).append(settingsHtml());
    bindSettingsUI();
}

// ---------------------------------------------------------------
// 入口
// ---------------------------------------------------------------

jQuery(async () => {
    try {
        loadSettings();
        await loadDiceLibrary();
        addSettingsUI();
        installFetchHook();
        console.log(`${LOG_TAG} v1.0.0 已就绪 | 启用: ${settings.enabled} | 剂量: ×${settings.repeat}`);
    } catch (e) {
        console.error(`${LOG_TAG} 初始化失败`, e);
        if (typeof toastr !== 'undefined') {
            toastr.error('初始化失败，详见 F12 控制台', '🎲 骰子扰动');
        }
    }
});
