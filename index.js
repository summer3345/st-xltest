/**
 * 骰子扰动 (Dice Query Perturbation) v1.1.0
 *
 * 原理：拦截向量检索请求（/api/vector/query 与 /api/vector/query-multi），
 * 在 searchText 前注入随机抽取的意象短句（重复 N 次以保证剂量），
 * 使查询向量发生语义偏移，从而打散 top-k 命中结果。
 *
 * v1.1 变更：骰子库改为设置面板内直接编辑（纯文本格式，无需JSON），
 * 存储在酒馆配置中，云端/手机可用，即改即生效。
 * dice.json 仅作为首次启动的默认库来源保留。
 */

const MODULE = 'dice_perturbation';
const LOG_TAG = '[骰子扰动]';

const defaultSettings = {
    enabled: true,        // 总开关
    repeat: 3,            // 剂量：roll 结果重复拼接次数（1-10）
    categoryFirst: true,  // 先随机选类目、再随机选条目
    logRoll: true,        // 在 F12 控制台打印每次 roll 结果
    excludePrefixes: 'file_',  // 排除前缀（逗号分隔）
    whitelist: '',        // 白名单（逗号分隔）
    diceText: '',         // 骰子库正文（面板内编辑的纯文本格式）
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

// ---------------------------------------------------------------
// 骰子库：纯文本格式 <-> 库对象
//
// 文本格式（打词儿就行，没有任何符号要求）：
//   ## 类目名
//   一条语料
//   另一条语料
//
//   ## 下一个类目
//   ……
//
// 以 # 开头的行 = 类目标题；其余非空行 = 语料；空行随意。
// ---------------------------------------------------------------

function parseDiceText(text) {
    const lib = {};
    let current = '默认';
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            current = line.replace(/^#+\s*/, '').trim() || '默认';
            if (!lib[current]) lib[current] = [];
            continue;
        }
        if (!lib[current]) lib[current] = [];
        lib[current].push(line);
    }
    // 清掉空类目
    for (const k of Object.keys(lib)) {
        if (lib[k].length === 0) delete lib[k];
    }
    return lib;
}

function libraryToText(lib) {
    return Object.entries(lib)
        .map(([cat, items]) => `## ${cat}\n${items.join('\n')}`)
        .join('\n\n');
}

function libraryStats(lib) {
    const cats = Object.keys(lib || {});
    const total = cats.reduce((n, k) => n + lib[k].length, 0);
    return { cats: cats.length, total };
}

async function fetchDefaultLibraryText() {
    const url = new URL('./dice.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`dice.json 读取失败: HTTP ${res.status}`);
    const json = await res.json();
    return libraryToText(json);
}

function applyDiceText(text) {
    settings.diceText = text;
    diceLibrary = parseDiceText(text);
    const { cats, total } = libraryStats(diceLibrary);
    $('#dice_pert_stats').text(`${cats} 个类目 / ${total} 条`);
    saveSettings();
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
        const cat = cats[Math.floor(Math.random() * cats.length)];
        const items = diceLibrary[cat];
        return { category: cat, text: items[Math.floor(Math.random() * items.length)] };
    }

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
        return wl.some(w => id.includes(w));
    }
    const ex = splitList(settings.excludePrefixes);
    return !ex.some(p => id.startsWith(p));
}

function shouldPerturb(body) {
    const ids = collectIds(body);
    if (ids.length === 0) {
        return { perturb: true, ids: ['(无 collectionId)'] };
    }
    const allowed = ids.filter(idAllowed);
    return { perturb: allowed.length > 0, ids };
}

// ---------------------------------------------------------------
// fetch 拦截
// ---------------------------------------------------------------

function isVectorQueryUrl(url) {
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
            console.warn(`${LOG_TAG} 拦截过程出错，已放行原请求`, e);
        }
        return origFetch.call(this, input, init);
    };

    window.__dicePerturbationInstalled = true;
    console.log(`${LOG_TAG} fetch 钩子已安装`);
}

// ---------------------------------------------------------------
// 设置面板 UI
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
                <hr />
                <div>
                    <label for="dice_pert_library">
                        骰子库（<code>## 类目名</code> 一行开新类目，下面每行一条语料，改完即生效）
                        — <span id="dice_pert_stats"></span>
                    </label>
                    <textarea id="dice_pert_library" class="text_pole textarea_compact" rows="14"
                        placeholder="## 类目名&#10;一条语料&#10;另一条语料&#10;&#10;## 下一个类目&#10;……"></textarea>
                </div>
                <div class="flex-container" style="margin-top: 8px;">
                    <input id="dice_pert_test" class="menu_button" type="button" value="试掷一次 🎲" />
                    <input id="dice_pert_reset" class="menu_button" type="button" value="恢复默认库" />
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

    $('#dice_pert_library')
        .val(settings.diceText)
        .on('input', function () { applyDiceText(this.value); });

    // 初始统计
    const { cats, total } = libraryStats(diceLibrary);
    $('#dice_pert_stats').text(`${cats} 个类目 / ${total} 条`);

    $('#dice_pert_test').on('click', function () {
        const roll = rollDice();
        if (roll) {
            const msg = `[${roll.category}] ${roll.text}`;
            console.log(`${LOG_TAG} 试掷 🎲 ${msg}`);
            if (typeof toastr !== 'undefined') toastr.info(msg, '🎲 骰子扰动');
        } else {
            if (typeof toastr !== 'undefined') toastr.warning('骰子库为空', '🎲 骰子扰动');
        }
    });

    $('#dice_pert_reset').on('click', async function () {
        if (!confirm('确定用默认库覆盖当前骰子库吗？你写的内容会被清掉。')) return;
        try {
            const text = await fetchDefaultLibraryText();
            $('#dice_pert_library').val(text);
            applyDiceText(text);
            if (typeof toastr !== 'undefined') toastr.success('已恢复默认库', '🎲 骰子扰动');
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

        // 首次启动：面板库为空时，用 dice.json 的默认内容垫底
        if (!settings.diceText || !settings.diceText.trim()) {
            try {
                settings.diceText = await fetchDefaultLibraryText();
                saveSettings();
            } catch (e) {
                console.warn(`${LOG_TAG} 默认库读取失败，骰子库为空，请在面板里填写`, e);
                settings.diceText = '';
            }
        }

        diceLibrary = parseDiceText(settings.diceText);
        addSettingsUI();
        installFetchHook();

        const { cats, total } = libraryStats(diceLibrary);
        console.log(`${LOG_TAG} v1.1.0 已就绪 | 启用: ${settings.enabled} | 剂量: ×${settings.repeat} | 骰子库: ${cats} 类 ${total} 条`);
    } catch (e) {
        console.error(`${LOG_TAG} 初始化失败`, e);
        if (typeof toastr !== 'undefined') {
            toastr.error('初始化失败，详见 F12 控制台', '🎲 骰子扰动');
        }
    }
});
